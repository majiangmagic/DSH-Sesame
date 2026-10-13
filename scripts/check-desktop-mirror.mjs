/**
 * 打印「桌面端 profile 的插件」与「web profile 的插件」的差异。
 *
 * 用法：
 *   node scripts/check-desktop-mirror.mjs          # 打印差异；有差异时以非零码退出
 *   node scripts/check-desktop-mirror.mjs --quiet  # 只打印结论
 *
 * **它只是一份诊断报告，不决定任何行为。** 启动桌面端时，启动器会**无条件**把这个
 * 差异抹平 —— 先把桌面端的插件全卸掉，再按 web 一比一装回来
 * （见 `src/main/domain/control/sync.ts` 顶部）。所以这里的输出是"你启动时会看到什么"，
 * 而不是"启动时会不会做"。
 *
 * 想确认"某个插件怎么又没装上"时用它：跑一次记下差异，启动一次桌面端，再跑一次 ——
 * 如果差异一模一样，说明那个插件每次都没装上（去终端页看 `failed` 那几行）。
 *
 * **它直接 import 真实实现**（`pluginMirror.ts`），不复制一份判断逻辑 ——
 * 复制出来的那份迟早会和真身漂移，然后给出让人安心的错误结论。
 * 能做到这一点是因为 `pluginMirror.ts` 刻意不依赖 Electron（只用类型）。
 *
 * ⚠️ 需要 **Node ≥ 22.6**：它靠 Node 的类型剥离直接 import `.ts`。
 * （开发环境用的是 Node 24；`npm run check:mirror` 里加了
 * `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` 只是为了让输出干净。）
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { diffMirror, describeDiff, isEmptyDiff } from '../src/main/domain/control/pluginMirror.ts'

const quiet = process.argv.includes('--quiet')

/**
 * dsh 数据目录。与 `src/main/infrastructure/dshHome.ts` 同一条优先级
 * （设置里的值 > DSH_HOME > ~/.dsh），但这里读不到启动器的设置，所以从环境变量开始。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 把一个 profile 读成 pluginMirror 要的视图 —— 与 sync.ts 的 readPluginView 同一套规则。 */
function readPluginView(profile) {
  const dir = join(dshHome(), 'profiles', profile)
  let specs = {}
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    specs = pkg.dependencies ?? {}
  } catch {
    // 空 profile
  }
  const versions = {}
  for (const name of Object.keys(specs)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'))
      versions[name] = typeof pkg.version === 'string' ? pkg.version : null
    } catch {
      versions[name] = null
    }
  }
  return { specs, versions }
}

const web = readPluginView('web')
const desktop = readPluginView('desktop')
const diff = diffMirror(web, desktop)

console.log(`DSH_HOME        ${dshHome()}`)
console.log(`web 插件        ${Object.keys(web.specs).length} 个`)
console.log(`desktop 插件    ${Object.keys(desktop.specs).length} 个`)

if (isEmptyDiff(diff)) {
  console.log('✅ 清单层面两边一致（注意：node_modules 是否健康它看不出来）')
  console.log('   启动桌面端时**仍然**会按 web 重建一遍 —— 重建是无条件的。')
  process.exit(0)
}

console.log('❌ 两边有差异 —— 启动桌面端时会按 web 重建（差异如下，重建本身无条件）')
if (!quiet) {
  console.log(`   差异：${describeDiff(diff)}`)
  const show = (label, names) => {
    if (names.length === 0) return
    console.log(`   ${label}：`)
    for (const name of names) {
      const w = web.versions[name] ?? '(无)'
      const d = desktop.versions[name] ?? '(无)'
      console.log(`     ${name}   web=${w}  desktop=${d}`)
    }
  }
  show('桌面端多出来的（重建时会被卸掉）', diff.extra)
  show('web 有但桌面端缺的（重建时会被装上）', diff.missing)
  show('两边都有但版本不同（重建时会被重装）', diff.versionMismatch)
  show('非 registry 来源不同（重建时会被重装）', diff.specMismatch)
}
process.exit(1)
