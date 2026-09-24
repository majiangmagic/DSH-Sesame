import { spawn, type ChildProcess } from 'node:child_process'
import { decodeChunk } from './textDecode'
import { existsSync, mkdirSync } from 'node:fs'
import type { VersionStatus } from '@shared/versions'
import { dshHome, profileDir } from './dshHome'
import { versionBin } from './paths'
import { createServer } from 'node:net'
import { requireNode } from './runtime'
import { pushTagged } from './logbus'
import { readSettings, splitArgs } from './settings'

/**
 * dsh 进程的运行器 —— 「启动 / 停止」的真实实现。
 *
 * 启动流程：spawn dsh → 从输出里读就绪地址 → 退出时杀整棵进程树。
 * 但**没有**移植它的 `perf/` 与 `compat/` 注入钩子：那两个是本启动器为特定 dsh 版本打的
 * 补丁（启动加速、会话事件词汇兼容），是它自己的权宜手段，本应用不依赖。
 *
 * 关键决策：
 *
 * 1. **`--port 0`，让系统挑空闲端口。** 原版就是这么做的，好处是彻底没有"端口被占"这类
 *    失败，也不需要顺延逻辑；真实地址从子进程输出里读（`READY_RE`）。
 * 2. **`--no-open`**：不让 dsh 自己弹浏览器，界面由启动器负责。
 * 3. **`--use-system-ca`**：用系统证书库。挂了代理 / TUN（mihomo 之类）做 TLS 中间人时，
 *    不加这个 DeepSeek 的请求会以 transport failed 收场 —— 这条对国内用户是必需的。
 * 4. **`--max-http-header-size=131072`**：浏览器里堆积的 cookie 会顶爆默认 16KB 请求头上限
 *    导致 HTTP 431。
 * 5. **停止用 `taskkill /T /F` 杀整棵进程树。** dsh 会起 worker 线程与子进程，只杀父进程会留孤儿。
 * 6. **cwd 用 DSH_HOME**：dsh 把相对路径（profiles、会话记录）都挂在 DSH_HOME 下，
 *    cwd 不对会让它读到别处的数据。
 */

/** dsh 就绪时打印的那行。原版同一个正则（server.js:70）。 */
const READY_RE = /dsh web:\s+(https?:\/\/[^\s]+)/

/**
 * 启动超时。给得比较宽：某个版本**首次**启动可能要现场装依赖，
 * 比冷启动慢得多；超时后会杀掉进程树并把输出尾巴当作诊断返回。
 */
const START_TIMEOUT_MS = 180_000
/** 停止后等待进程真正退出的上限 */
const STOP_GRACE_MS = 5_000
/** 保留多少行输出用于诊断 */
const TAIL_LIMIT = 200

export interface RunState {
  version: string
  status: VersionStatus
  url: string | null
}

interface Proc extends RunState {
  child: ChildProcess
  tail: string[]
  exit: { code: number | null; signal: string | null } | null
  startedAt: number
}

let current: Proc | null = null

/** 当前运行态；没有在跑返回 null。`overview()` 用它给已装版本打上 status/url。 */
export function currentRun(): RunState | null {
  if (current === null) return null
  return { version: current.version, status: current.status, url: current.url }
}

/** 最近的输出尾巴（诊断用，也让"启动失败"能给出真实原因） */
export function runTail(): string[] {
  return current?.tail.slice(-60) ?? []
}

/** 子进程环境。这些变量 dsh 自己以及它拉起的插件都会读。 */
function envFor(version: string, node: { path: string }, profile: string): NodeJS.ProcessEnv {
  const bin = versionBin(version)
  return {
    ...process.env,
    DSH_HOME: dshHome(),
    DSH_NODE: node.path,
    DSH_BIN: bin,
    DSH_VERSION: version,
    DSH_PROFILE: profile,
    // NODE_OPTIONS 是按空格分词的，所以只写不含空格的裸参数
    NODE_OPTIONS: [
      '--use-system-ca',
      process.env['NODE_OPTIONS'],
      '--max-http-header-size=131072'
    ]
      .filter(Boolean)
      .join(' '),
    npm_config_ignore_workspace_root_check: 'true',
    // Windows 上 Python 默认按控制台代码页写输出（中文 = GBK），终端页因此出现乱码。
    // 这两个变量让它直接输出 UTF-8（实测：Blender / Unity 的 MCP 服务都是 Python）。
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  }
}

/** 这个端口现在能不能绑。只探测，不占用。 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/**
 * 决定这次用哪个端口。
 *
 * 策略（用户明确要求）：**先试设置的固定端口；被占用时回退到系统分配**（`--port 0`），
 * 但**必须写日志说清为什么、换到了哪** —— "自己找完就找完了"是不行的：
 * 静默换端口会让地址重新变得不可预期，用户会以为是启动器坏了或端口设置没生效。
 *
 * 也不能像最初设想的那样直接报错不启动 —— 占用是常见情况（比如上一次的 dsh 没退干净），
 * 因此回退 + 告知，而不是拒绝服务。
 */
async function resolvePort(configured: number): Promise<number> {
  if (!Number.isInteger(configured) || configured < 1024 || configured > 65535) return 0
  if (await isPortFree(configured)) return configured
  pushTagged(
    '启动器',
    `端口 ${configured} 已被占用（可能是上一次的 dsh 没退干净，或别的程序在用），` +
      `改用系统分配的空闲端口启动。就绪地址见下一行；想固定端口请在「设置 → 启动端口」里换一个。`
  )
  return 0
}

/** dsh 启动参数。profile 与额外参数都来自设置（`<userData>/settings.json`）。 */
function bootArgs(profile: string, port: number): string[] {
  /*
   * 端口来自设置（默认 3080），**不再是 0**。
   *
   * 原来 `--port 0` 让系统挑空闲端口：永不会冲突，但每次地址都变，用户没法收藏、也没法记住。
   * 也没法记住。现在固定端口；被占用时 dsh 会绑不上，而启动器要等满
   * `START_TIMEOUT_MS`（180 秒）才报"就绪超时"—— 那个错误完全看不出是端口问题。
   * 现在固定端口；被占用时 startVersion 先探测，再**回退到系统分配**并写一行日志说明（见 resolvePort）。
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
function killTree(pid: number | undefined): void {
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

function attach(version: string, child: ChildProcess): Proc {
  const proc: Proc = {
    version,
    child,
    status: 'starting',
    url: null,
    tail: [],
    exit: null,
    startedAt: Date.now()
  }
  current = proc

  const onChunk = (buf: Buffer): void => {
    for (const line of decodeChunk(buf).split(/\r?\n/)) {
      if (line.trim() !== '') {
        proc.tail.push(line)
        if (proc.tail.length > TAIL_LIMIT) proc.tail.shift()
      }
      // 子进程的输出直接进终端页 —— 这是终端页最有价值的内容
      // （dsh 的就绪地址、插件加载报错、退出原因都在这里）
      pushTagged(`dsh ${version}`, line)
      const match = line.match(READY_RE)
      if (match && proc.status === 'starting') {
        proc.url = match[1] ?? null
        proc.status = 'running'
      }
    }
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)

  child.on('error', (error) => {
    proc.tail.push(`进程错误：${error.message}`)
    proc.exit = { code: null, signal: null }
    if (current === proc) current = null
  })

  child.on('exit', (code, signal) => {
    proc.exit = { code, signal }
    proc.tail.push(`已退出 code=${code ?? '-'} signal=${signal ?? '-'}`)
    // 自己退出（崩溃 / 被外部杀）时清掉，别让界面以为还在跑
    if (current === proc) current = null
  })

  return proc
}

/** 等就绪：轮询状态，超时则杀树并抛出带输出尾巴的错误 */
function waitUntilReady(proc: Proc): Promise<RunState> {
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (current !== proc && proc.status !== 'running') {
        reject(new Error(`${proc.version} 启动失败：进程已退出\n${proc.tail.slice(-15).join('\n')}`))
        return
      }
      if (proc.status === 'running') {
        if (proc.url === null) {
          reject(new Error(`${proc.version} 报告就绪但没给出地址`))
          return
        }
        resolve({ version: proc.version, status: 'running', url: proc.url })
        return
      }
      if (Date.now() - proc.startedAt > START_TIMEOUT_MS) {
        killTree(proc.child.pid)
        reject(
          new Error(
            `${proc.version} 启动超时（${Math.round(START_TIMEOUT_MS / 1000)}s）\n${proc.tail.slice(-15).join('\n')}`
          )
        )
        return
      }
      setTimeout(tick, 200)
    }
    tick()
  })
}

/** 停止当前进程；没在跑就直接返回。 */
export async function stopVersion(): Promise<void> {
  const proc = current
  if (proc === null) return
  proc.status = 'stopping'

  const closed = new Promise<void>((resolve) => {
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
      resolve()
      return
    }
    proc.child.once('close', () => resolve())
  })
  killTree(proc.child.pid)
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS))])

  if (current === proc) current = null
}

/**
 * 启动一个版本。
 *
 * 已经在跑同一个且就绪 → 直接返回现有地址；正在启动 → 等它就绪；
 * 跑着别的版本 → 先停再启（一个 dsh 实例共用同一份 profile，不能并存）。
 */
export async function startVersion(version: string): Promise<RunState> {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) throw new Error(`版本号不合法：${version}`)

  /**
   * 非 web 的 profile **在启动器窗口里跑不起来**，所以在这里就明确拒绝。
   *
   * 它们都不会打印 `dsh web: <地址>` 那一行，`waitUntilReady` 只会干等到超时，
   * 用户看到的是一句没有信息量的"启动超时（180s）"。四种的真实原因各不相同：
   *   tui       终端界面，需要一个真正的 TTY —— 启动器没有终端
   *   acp/sdk   协议 / 编程接口，没有给人看的界面
   *   headless  回答一个问题就退出的一次性任务
   * 与其让它挂三分钟，不如立刻说清楚，并把该敲的命令原样给出来。
   */
  const profile = readSettings().profile
  if (profile !== 'web') {
    const reason =
      profile === 'tui'
        ? 'tui 是终端界面，需要一个真正的终端窗口（TTY），启动器这个窗口里没有终端。'
        : `${profile} 不是 web 界面，不会输出可打开的地址，启动器无法承载它。`
    throw new Error(
      `${reason}\n\n` +
        `想在终端里用它，执行：\n  node "${versionBin(version)}" ${profile}\n\n` +
        '或者到「设置」页把「启动 profile」改回 web。'
    )
  }

  if (current !== null && current.version === version) {
    if (current.status === 'running' && current.url !== null) {
      return { version, status: 'running', url: current.url }
    }
    if (current.status === 'starting') return waitUntilReady(current)
  }
  if (current !== null) await stopVersion()

  const bin = versionBin(version)
  if (!existsSync(bin)) throw new Error(`${version} 未安装或缺少入口 ${bin}`)

  // 必须用真正的 Node 跑 dsh —— 用 Electron 的 V8 会被 dsh 的加载器钩子拒绝（见 runtime.ts）
  const node = requireNode()

  // 首次启动前 DSH_HOME 可能还不存在，dsh 会自己建，但 cwd 不存在 spawn 会直接失败
  const home = dshHome()
  try {
    mkdirSync(home, { recursive: true })
    mkdirSync(profileDir(profile), { recursive: true })
  } catch {
    // 建不出来就让 dsh 自己报错，别在这里吞掉真实原因
  }

  // 端口在这里定：先试固定端口，占用则回退（并已写日志说明）
  const port = await resolvePort(readSettings().port)
  const child = spawn(node.path, [bin, ...bootArgs(profile, port)], {
    cwd: home,
    env: envFor(version, node, profile),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  return waitUntilReady(attach(version, child))
}

/** 退出应用时收尾：杀掉还在跑的 dsh，别留孤儿进程。 */
export function stopAllSync(): void {
  const proc = current
  if (proc === null) return
  killTree(proc.child.pid)
  current = null
}
