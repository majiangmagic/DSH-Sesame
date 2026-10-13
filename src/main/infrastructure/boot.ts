import { spawn } from 'node:child_process'
import { dshHome } from './dshHome'
import { versionBin } from './paths'
import { nodeOptionsValue, pathWithBundledBin } from './runtime'
import { readSettings, splitArgs } from './settings'

/**
 * 「怎么起一个 dsh 进程」—— 与"谁在跑、跑到哪一步"无关的那部分。
 *
 * 为什么单独一个文件（而不是留在 `domain/control/runner.ts` 里）：
 *
 *   1. **断循环依赖**。原先 runner 导出这四个符号，而 `diagnose` 要用它们；
 *      `diagnose → runner → sync → diagnose` 于是成环 —— 只想改诊断的输出解析，
 *      却被迫理解整个桌面端同步栈。这四个符号**不依赖任何业务模块**（只依赖 infra），
 *      挪出来环就断了。
 *   2. **被两个领域用**（`domain/control` 启动、`domain/control` 诊断），
 *      按本项目的分层规则，被 ≥2 个领域使用的机制属于 infra。
 *
 * 放在 infra 的判据不是"通用"，而是"**不承载策略**"：这里只回答"参数是什么、
 * 环境变量怎么拼、进程树怎么杀"，不回答"该不该启动、启动失败怎么办"。
 * 那些在 `domain/control/runner.ts`。
 */

/**
 * dsh 就绪时打印的那行（`dsh web: http://…`）。
 *
 * 导出给 `domain/control` 复用 —— 判定"已就绪"这件事只该有一处实现，
 * 否则诊断模块会自己写一版，然后漏掉"已就绪后静默是正常的"。
 */
export const READY_RE = /dsh web:\s+(https?:\/\/[^\s]+)/

/** 子进程环境。这些变量 dsh 自己以及它拉起的插件都会读。 */
export function envFor(version: string, node: { path: string }, profile: string): NodeJS.ProcessEnv {
  const bin = versionBin(version)
  return {
    ...process.env,
    DSH_HOME: dshHome(),
    DSH_NODE: node.path,
    DSH_BIN: bin,
    DSH_VERSION: version,
    DSH_PROFILE: profile,
    /*
     * NODE_OPTIONS 从 infra/runtime 拿 —— 探测 node 的时候用的是同一个值（见那边 probe 的注释），
     * 两边必须一致，否则"探测通过"就没意义了。这也是原来那个 bug 的根：
     * 这里无条件注入参数，却没问过目标 node 接不接受。
     */
    NODE_OPTIONS: nodeOptionsValue(),
    /*
     * 把自己带的 pnpm 垫片目录插到 PATH 最前面（见 infra/runtime 的 bundledBinDir）。
     * dsh 的插件管理器调的是 PATH 上的 `pnpm` —— 插进去就命中我们自带的那个，
     * 不再取决于用户机器上装没装（否则换台机器装插件就报 `'pnpm' 不是内部或外部命令`）。
     */
    PATH: pathWithBundledBin(),
    npm_config_ignore_workspace_root_check: 'true',
    // Windows 上 Python 默认按控制台代码页写输出（中文 = GBK），终端页因此出现乱码。
    // 这两个变量让它直接输出 UTF-8（实测：Blender / Unity 的 MCP 服务都是 Python）。
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  }
}

/** dsh 启动参数。profile 与额外参数都来自设置（`<userData>/settings.json`）。 */
export function bootArgs(profile: string, port: number): string[] {
  /*
   * 端口来自设置（默认 3080），**不是 0**。
   *
   * 原来用 `--port 0` 让系统挑空闲端口：永不会冲突，但每次地址都变，用户没法收藏、
   * 也没法记住。现在固定端口，代价是"被占用"变成一种真实情况 —— 由
   * `domain/control/runner.ts` 的 resolvePort 先探测、占用则回退到系统分配，
   * 并写一行日志说明原因（否则用户只会看到一个完全看不出是端口问题的"就绪超时"）。
   */
  return [
    profile,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--no-open',
    ...splitArgs(readSettings().args)
  ]
}

/** 杀整棵进程树。Windows 必须用 taskkill /T，否则 worker 线程会变成孤儿。 */
export function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // 已经没了
  }
}
