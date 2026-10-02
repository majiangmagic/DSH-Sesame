import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { app } from 'electron'

/**
 * 找一个**真正的 Node 运行时**来跑 dsh。
 *
 * ── 为什么不能用 Electron 自己的 `process.execPath` ──
 *
 * 在 Electron 主进程里 `process.execPath` 是 `electron.exe`。用它直接跑 dsh 有两种坏结果，
 * 两种都实测过：
 *
 * 1. **不加 `ELECTRON_RUN_AS_NODE`**：Electron 把 `bin.js` 当成**应用入口**加载 Chromium，
 *    argv 位置也错位 —— 结果是**一声不响地挂着**（界面上"正在启动…"转满 180 秒超时，
 *    子进程一行输出都没有）。
 * 2. **加了 `ELECTRON_RUN_AS_NODE`**：能当 Node 跑，但 dsh 的加载器钩子会拒绝 Electron 的 V8：
 *    `unsupported Electron runtime fingerprint: Node 24.21.0, V8 15.2.124.28-electron.0`
 *    （它只认 43/44/45 的原生 V8）。进程 2 秒内就退出。
 *
 * 用真正的 `node.exe` 跑同一份 bin.js，**1.8 秒就打印 `dsh web: http://…`**。
 *
 * 顺序：`SESAME_NODE` → 应用自带的 `<app>/node/node.exe` → PATH 上的 node。
 * 自带运行时是给"用户机器上没装 Node"准备的（同类启动器常这么做），现在还没有，
 * 所以找不到时会明确报错，而不是退化成一个必然失败的启动。
 */
export interface NodeRuntime {
  path: string
  kind: 'env' | 'path' | 'bundled'
}

/** PATH 里逐个目录找 node.exe / node */
function findOnPath(): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir.trim() === '') continue
    for (const ext of exts) {
      const candidate = join(dir, `node${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** 自带运行时：<app>/node/node.exe（打包后即 exe 旁边的 node/） */
function bundledNode(): string | null {
  const root = app.isPackaged ? process.resourcesPath.replace(/resources[\\/]?$/, '') : app.getAppPath()
  for (const candidate of [join(root, 'node', 'node.exe'), join(root, 'node', 'node')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 自带运行时的垫片目录 `<app>/node/bin`（里面是我们放的 `pnpm` 垫片）。
 *
 * **必须把它插到子进程 PATH 的最前面**：dsh 的插件管理器调用的是 PATH 上的 `pnpm`
 * （它自己不带）。不插的话，装插件就取决于"用户机器上碰巧装没装 pnpm" ——
 * 实测有台新机器因此报 `'pnpm' 不是内部或外部命令`，插件完全装不了。
 *
 * 官方桌面端就是这么做的：它的 runtime 里 node 与 pnpm 一起带（versions.json:
 * node 24.18.1 / pnpm 11.7.0），所以桌面端那条路从来不缺 pnpm。
 *
 * 返回 null 表示这个构建没带 pnpm（旧包）—— 调用方按"不改 PATH"处理。
 */
export function bundledBinDir(): string | null {
  const root = app.isPackaged ? process.resourcesPath.replace(/resources[\\/]?$/, '') : app.getAppPath()
  const dir = join(root, 'node', 'bin')
  return existsSync(dir) ? dir : null
}

/** 把自带垫片目录插到 PATH 最前面（这个构建没带 pnpm 就原样返回）。 */
export function pathWithBundledBin(current: string = process.env['PATH'] ?? ''): string {
  const bin = bundledBinDir()
  if (bin === null) return current
  const separator = process.platform === 'win32' ? ';' : ':'
  return current === '' ? bin : `${bin}${separator}${current}`
}

/**
 * 注入给所有 dsh 子进程的 `NODE_OPTIONS`。
 *
 * 放在这里（而不是 runner.ts）是为了让**探测**与**实际注入**用同一个值 —— 两边一飘，探测就白做了。
 *
 *   `--use-system-ca`          用系统证书库。挂代理 / TUN（mihomo 之类）做 TLS 中间人时，
 *                              Node 默认只认自带根证书 → 握手失败
 *   `--max-http-header-size`   放宽 header 上限
 *
 * `NODE_OPTIONS` 按空格分词，所以只写不含空格的裸参数。
 */
export function nodeOptionsValue(): string {
  return ['--use-system-ca', process.env['NODE_OPTIONS'], '--max-http-header-size=131072']
    .filter(Boolean)
    .join(' ')
}

/**
 * 校验候选确实是 Node，**并且能吃下我们要注入的 `NODE_OPTIONS`**。
 *
 * 为什么连 NODE_OPTIONS 一起验：`NODE_OPTIONS` 是**白名单机制** —— 出现不被允许的参数时，
 * node 不是忽略它，而是**拒绝启动**（实测退出码 9，报
 * `--use-system-ca is not allowed in NODE_OPTIONS`）。而"用哪个 node"是运行时才定的，
 * 不能假设用户机器上那个一定接受。所以把这件事**在探测阶段就问清楚**：不合格的候选直接跳过，
 * 由后面的候选顶上 —— 而不是等 spawn 出来一个死进程。
 *
 * 只认形如 `v24.19.0` 的输出：Electron 的 `electron.exe --version` 打印 `v44.4.5` 也长得像，
 * 所以光看"能跑"不够；但真正的判据（V8 指纹）只有启动时才知道，这里只排除明显不对的。
 */
function probe(path: string): string | null {
  try {
    const out = execFileSync(path, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      // 带上真正会用的 NODE_OPTIONS —— 不接受它的 node 会在这里就失败
      env: { ...process.env, NODE_OPTIONS: nodeOptionsValue() }
    })
    const version = out.trim()
    return /^v\d+\.\d+\.\d+/.test(version) ? version : null
  } catch {
    return null
  }
}

/** 找可用的 Node；找不到返回 null。 */
export function resolveNode(): (NodeRuntime & { version: string }) | null {
  const candidates: Array<{ path: string; kind: NodeRuntime['kind'] }> = []

  /*
   * 顺序：**显式指定 → 自带 → PATH**。
   *
   * 自带那个必须排在 PATH 之前：它是随包发布的、我们验证过的 v24.19.0；而用户机器上 PATH 里
   * 是哪个版本完全不可控 —— 实测有台新机器就因为 PATH 里那个不接受 --use-system-ca，
   * 整个 dsh 起不来。自带运行时存在的**全部意义**就是"不依赖用户机器"，把它排最后等于白带。
   *
   * 三者都是**候选**：探测不过就换下一个（见 probe）。不会因为"你指定了"就死给用户看。
   */
  const fromEnv = process.env['SESAME_NODE']
  if (fromEnv && existsSync(fromEnv)) candidates.push({ path: fromEnv, kind: 'env' })

  const bundled = bundledNode()
  if (bundled) candidates.push({ path: bundled, kind: 'bundled' })

  const onPath = findOnPath()
  if (onPath) candidates.push({ path: onPath, kind: 'path' })

  for (const candidate of candidates) {
    const version = probe(candidate.path)
    if (version !== null) return { ...candidate, version }
  }
  return null
}

/** 找不到 Node 时抛出的统一错误 —— 说清原因和怎么办，别让用户看到一句 V8 指纹。 */
export function requireNode(): NodeRuntime & { version: string } {
  const node = resolveNode()
  if (node === null) {
    throw new Error(
      '找不到 Node 运行时，无法启动 dsh。\n' +
        '原因：dsh 的加载器钩子会检查 V8 指纹，不接受 Electron 自带的那个 V8，必须用真正的 node.exe。\n' +
        '解决：装一个 Node（https://nodejs.org）并确保 `node` 在 PATH 上，或用 SESAME_NODE 环境变量指定 node.exe 的完整路径。'
    )
  }
  return node
}
