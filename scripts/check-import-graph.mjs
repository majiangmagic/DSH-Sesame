/**
 * 导入图自检：**循环依赖**与**分层越界**。
 *
 * 为什么需要它：`src/README.md` 里那几条依赖规则（renderer 不许碰 main、
 * shared/utils 是叶子、infra 不许依赖 domain、domain 之间不许成环）**没有构建期强制** ——
 * tsc 和 vite 都不会拦。没有这个脚本，规则就只是文档里的愿望。
 *
 * 用法：
 *   node scripts/check-import-graph.mjs        # 有问题时以非零码退出（CI 用）
 *   node scripts/check-import-graph.mjs --list # 额外打印全部领域间依赖边
 *
 * 不引入任何依赖（没有 eslint-plugin-boundaries / dependency-cruiser）：
 * 这个检查只需要解析 import 语句，几十行就够，不值得为它加一条依赖链。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

/**
 * 已知并**接受**的越界。加进这里必须在对应目录的 README 里写明理由，
 * 否则下一个人只会看到"检查通过"，不知道这里欠着一笔账。
 */
const ALLOWED = new Set([
  // 图片代理需要市场的区域路由配置（截图在国内直连不通，要按市场配置改写）。
  // 理由与两种改法见 src/main/infrastructure/README.md
  'src/main/infrastructure/imageProxy.ts -> src/main/domain/plugins/market.ts'
])

const posix = (p) => p.split('\\').join('/')
const rel = (abs) => posix(relative(ROOT, abs))

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else if (/\.(ts|vue)$/.test(abs) && !/\.d\.ts$/.test(abs)) out.push(abs)
  }
  return out
}

const files = walk(SRC)
const stripExt = (p) => p.replace(/\.(ts|vue)$/, '')

/** 模块 id（无扩展名）-> 文件。index 文件额外用目录名登记一次。 */
const byId = new Map()
for (const abs of files) {
  const id = stripExt(rel(abs))
  byId.set(id, abs)
  if (id.endsWith('/index')) byId.set(id.slice(0, -'/index'.length), abs)
}

/** 别名 -> 目录。与 electron.vite.config.ts / tsconfig 的 paths 保持一致。 */
const ALIAS = [
  [/^@shared\//, 'src/shared/'],
  [/^@utils\//, 'src/utils/'],
  [/^@\//, 'src/renderer/']
]

const IMPORT_PATTERNS = [
  /(?:\bfrom\s*)(['"])([^'"]+)\1/g,
  /(?:^|\n)\s*import\s+(['"])([^'"]+)\1/g,
  /(?:\bimport\(\s*)(['"])([^'"]+)\1/g
]

function resolveSpec(spec, fromAbs) {
  if (spec.startsWith('.')) {
    const id = stripExt(posix(relative(ROOT, resolve(dirname(fromAbs), spec))))
    return byId.get(id) ?? null
  }
  for (const [re, base] of ALIAS) {
    if (re.test(spec)) return byId.get(stripExt(base + spec.replace(re, ''))) ?? null
  }
  return null // 外部包（electron / vue / node:* …）
}

const graph = new Map()
for (const abs of files) {
  const text = readFileSync(abs, 'utf8')
  const deps = new Set()
  for (const re of IMPORT_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const target = resolveSpec(m[2], abs)
      if (target && target !== abs) deps.add(target)
    }
  }
  graph.set(abs, [...deps])
}

/* ---------------- 循环依赖（Tarjan 强连通分量） ---------------- */

let counter = 0
const idx = new Map()
const low = new Map()
const onStack = new Set()
const stack = []
const cycles = []

function strongConnect(v) {
  idx.set(v, counter)
  low.set(v, counter)
  counter += 1
  stack.push(v)
  onStack.add(v)
  for (const w of graph.get(v) ?? []) {
    if (!idx.has(w)) {
      strongConnect(w)
      low.set(v, Math.min(low.get(v), low.get(w)))
    } else if (onStack.has(w)) {
      low.set(v, Math.min(low.get(v), idx.get(w)))
    }
  }
  if (low.get(v) === idx.get(v)) {
    const comp = []
    let w
    do {
      w = stack.pop()
      onStack.delete(w)
      comp.push(w)
    } while (w !== v)
    if (comp.length > 1) cycles.push(comp)
  }
}

for (const abs of files) if (!idx.has(abs)) strongConnect(abs)

/* ---------------- 分层规则 ---------------- */

const violations = []
for (const [from, deps] of graph) {
  const f = rel(from)
  for (const to of deps) {
    const t = rel(to)
    const edge = `${f} -> ${t}`
    if (ALLOWED.has(edge)) continue

    const rules = [
      // 渲染层不许碰主进程 / 预加载：它的 lib 里没有 node 类型，碰了就是编译期或运行期事故
      [f.startsWith('src/renderer/') && /^src\/(main|preload)\//.test(t), 'renderer 不许依赖 main / preload'],
      // shared 与 utils 是叶子：反向依赖会让两个 tsconfig 的 include 关系崩塌
      [
        (f.startsWith('src/shared/') || f.startsWith('src/utils/')) && /^src\/(main|preload|renderer)\//.test(t),
        'shared / utils 是叶子，不许依赖进程层'
      ],
      /*
       * infrastructure 是"靠什么做"（文件、进程、网络、Electron 壳），不许依赖
       * domain（做什么）或 ipc（怎么被调用）。反过来依赖会让"换掉一个领域"
       * 变成"要动基础设施"，这一层的意义就没了。
       */
      [
        f.startsWith('src/main/infrastructure/') && /^src\/main\/(domain|ipc|api)\//.test(t),
        'infrastructure 不许依赖 domain / ipc / api'
      ],
      // ipc 是适配层：只许调 domain 与 infrastructure，不许反向被它们依赖（由上一条覆盖）
      // domain 之间允许依赖，但绝不许成环 —— 环由上面的循环检测负责
      [
        f.startsWith('src/main/domain/') && /^src\/main\/(ipc|api)\//.test(t),
        'domain 不许依赖 ipc / api（方向反了）'
      ]
    ]
    for (const [hit, message] of rules) if (hit) violations.push(`${message}：${edge}`)
  }
}

/* ---------------- 报告 ---------------- */

const edges = [...graph.values()].reduce((n, d) => n + d.length, 0)
console.log(`导入图：${files.length} 个模块，${edges} 条边`)

let failed = false

if (cycles.length === 0) {
  console.log('✅ 无循环依赖')
} else {
  failed = true
  console.log(`❌ 发现 ${cycles.length} 处循环依赖：`)
  for (const comp of cycles) console.log('   ' + comp.map((a) => rel(a).replace(/^src\//, '')).join('  <->  '))
}

if (violations.length === 0) {
  console.log('✅ 无分层越界')
} else {
  failed = true
  console.log(`❌ 发现 ${violations.length} 处分层越界：`)
  for (const v of violations) console.log('   ' + v)
}

if (process.argv.includes('--list')) {
  const domainEdges = new Set()
  for (const [from, deps] of graph) {
    const mf = rel(from).match(/^src\/main\/domain\/([^/]+)\//)
    if (!mf) continue
    for (const to of deps) {
      const mt = rel(to).match(/^src\/main\/domain\/([^/]+)\//)
      if (mt && mt[1] !== mf[1]) domainEdges.add(`${mf[1]} -> ${mt[1]}`)
    }
  }
  console.log(`\n领域之间的依赖边（${domainEdges.size} 条）：`)
  if (domainEdges.size === 0) console.log('   （无）')
  for (const e of [...domainEdges].sort()) console.log('   ' + e)
}

if (failed) process.exit(1)
