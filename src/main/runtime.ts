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
 * 顺序：`DSH_NODE` 环境变量 → PATH 上的 node → 应用自带的 `<app>/node/node.exe`。
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
 * 校验候选确实是 Node（而不是别的同名程序），返回版本字符串。
 *
 * 只认 `--version` 输出形如 `v24.19.0`：Electron 的 `electron.exe --version` 输出的是
 * `v44.4.5` 这种 Electron 版本号，也会长得像，所以光看"能跑"不够 —— 但真正的判据是
 * 它跑 dsh 会不会被 V8 指纹拒绝，那只有启动时才知道。这里只排除明显不是 Node 的情况。
 */
function probe(path: string): string | null {
  try {
    const out = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const version = out.trim()
    return /^v\d+\.\d+\.\d+/.test(version) ? version : null
  } catch {
    return null
  }
}

/** 找可用的 Node；找不到返回 null。 */
export function resolveNode(): (NodeRuntime & { version: string }) | null {
  const candidates: Array<{ path: string; kind: NodeRuntime['kind'] }> = []

  const fromEnv = process.env['SESAME_NODE'] ?? process.env['DSH_NODE']
  if (fromEnv && existsSync(fromEnv)) candidates.push({ path: fromEnv, kind: 'env' })

  const onPath = findOnPath()
  if (onPath) candidates.push({ path: onPath, kind: 'path' })

  const bundled = bundledNode()
  if (bundled) candidates.push({ path: bundled, kind: 'bundled' })

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
