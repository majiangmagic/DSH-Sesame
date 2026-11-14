import { spawn, type ChildProcess } from 'node:child_process'
import { createStreamDecoder } from '../../platform/textDecode'
import { existsSync, mkdirSync } from 'node:fs'
import type { VersionStatus } from '@shared/types/versions'
import { dshHome, profileDir } from '../../platform/dshHome'
import { versionBin } from '../../platform/paths'
import { createServer } from 'node:net'
import { requireNode } from '../../platform/runtime'
import { pushTagged } from '../terminal/logbus'
import { readSettings } from '../../platform/settings'
import { bootArgs, envFor, killTree, READY_RE } from '../../platform/boot'
import {
  desktopLogPath,
  ensureDesktop,
  launchDesktop,
  tailDesktopLog,
  type DesktopProgress
} from './desktop'
import { repairDesktopPatch } from './sync'
import { baseStatus, cloneBaseToProfile } from './pluginBase'

/**
 * dsh 进程的运行器 —— 「启动 / 停止」的真实实现。
 *
 * 启动流程：spawn dsh → 从输出里读就绪地址 → 退出时杀整棵进程树。
 * 但**没有**移植它的 `perf/` 与 `compat/` 注入钩子：那两个是本启动器为特定 dsh 版本打的
 * 补丁（启动加速、会话事件词汇兼容），是它自己的权宜手段，本应用不依赖。
 *
 * 关键决策：
 *
 * 1. **端口来自设置（默认 3080）。** 原版用 `--port 0` 让系统挑，好处是彻底没有"端口被占"这类
 *    失败，也不需要顺延逻辑；真实地址从子进程输出里读（`READY_RE`）。
 * 2. **`--no-open`**：不让 dsh 自己弹浏览器，界面由启动器负责。
 * 3. **`--use-system-ca`**：用系统证书库。挂了代理 / TUN（mihomo 之类）做 TLS 中间人时，
 *    不加这个 DeepSeek 的请求会以 transport failed 收场 —— 这条对国内用户是必需的。
 * 4. **`--max-http-header-size=131072`**：浏览器里堆积的 cookie 会顶爆默认 16KB 请求头上限
 *    导致 HTTP 431。
 * 5. **停止用 `taskkill /T /F` 杀整棵进程树。** dsh 会起 worker 线程与子进程，只杀父进程会留孤儿。
 * 6. **cwd 用 DSH_HOME**：dsh 把相对路径（profiles、会话记录）都挂在 DSH_HOME 下，
 *    cwd 不对会让它读到别处的数据。
 *
 * 「怎么起一个 dsh 进程」的原语（`bootArgs` / `envFor` / `killTree` / `READY_RE`）在
 * `infra/boot.ts` —— 它们不依赖任何领域模块，所以 `domain/control` 能直接用而不成环。
 * 这个文件只管**状态与策略**：谁在跑、端口怎么回退、什么时候算就绪、停止怎么收尾。
 */

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
  /** 等这个实例就绪的等待者（超时/取消时逐个 reject） */
  startWaiters: Array<(error: Error) => void>
}

let current: Proc | null = null

/**
 * 正在运行的桌面端。
 *
 * 桌面端是另一个应用（不是 dsh 子进程），所以单独记一份；它与 dsh 实例**互斥** ——
 * 同一时刻只该有一个在跑。记着它，`overview()` 才能把那个版本标成「运行中」，
 * 界面上的「停止」也才能真的掐断。
 */
let desktopProc: {
  version: string
  child: ChildProcess
  /** 停掉「跟随 desktop.log」的定时器（进程退出/被停止时调） */
  stopTail: () => void
} | null = null

/** 当前运行态；没有在跑返回 null。`overview()` 用它给已装版本打上 status/url。 */
export function currentRun(): RunState | null {
  // 桌面端优先：它没有就绪地址，url 恒为 null，界面据此不开浏览器
  if (desktopProc !== null) return { version: desktopProc.version, status: 'running', url: null }
  if (current === null) return null
  return { version: current.version, status: current.status, url: current.url }
}

/** 最近的输出尾巴（诊断用，也让"启动失败"能给出真实原因） */
export function runTail(): string[] {
  return current?.tail.slice(-60) ?? []
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
  if (!Number.isInteger(configured) || configured < 1024 || configured > 65535) {
    pushTagged('启动器', `启动端口 ${configured} 不在 1024~65535 范围，改用系统分配的空闲端口。`)
    return 0
  }
  if (await isPortFree(configured)) return configured
  pushTagged(
    '启动器',
    `端口 ${configured} 已被占用（可能是上一次的 dsh 没退干净，或别的程序在用），` +
      `改用系统分配的空闲端口启动。就绪地址见下一行；想固定端口请在「设置 → 启动端口」里换一个。`
  )
  return 0
}

function attach(version: string, child: ChildProcess): Proc {
  const proc: Proc = {
    version,
    child,
    status: 'starting',
    url: null,
    tail: [],
    exit: null,
    startedAt: Date.now(),
    startWaiters: []
  }
  current = proc

  // stdout 与 stderr **各用一个解码器** —— TextDecoder(stream:true) 的残留状态
  // 必须按流持有，两路共用一个会把半个字符拼到另一路去（实测乱码就是这么来的）。
  // 行装配也在这里做：TCP 会分包，就绪行被切成两块时按块 split 会匹配不到 READY_RE，
  // 之前因此白等满 180s 超时（对照正确写法：desktop.ts 的 consume）。
  const decoders = { stdout: createStreamDecoder(), stderr: createStreamDecoder() }
  const buffers = { stdout: '', stderr: '' }

  const onChunk = (which: 'stdout' | 'stderr') => (buf: Buffer): void => {
    buffers[which] += decoders[which].decode(buf)
    const parts = buffers[which].split(/\r?\n/)
    buffers[which] = parts.pop() ?? ''
    for (const line of parts) {
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
  child.stdout?.on('data', onChunk('stdout'))
  child.stderr?.on('data', onChunk('stderr'))

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

/** 等就绪：轮询状态，超时则杀树、清状态，并抛出带输出尾巴的错误。 */
function waitUntilReady(proc: Proc): Promise<RunState> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      const idx = proc.startWaiters.indexOf(reject)
      if (idx !== -1) proc.startWaiters.splice(idx, 1)
    }
    const tick = (): void => {
      if (current !== proc && proc.status !== 'running') {
        cleanup()
        reject(new Error(`${proc.version} 启动失败：进程已退出\n${proc.tail.slice(-15).join('\n')}`))
        return
      }
      if (proc.status === 'running') {
        cleanup()
        if (proc.url === null) {
          reject(new Error(`${proc.version} 报告就绪但没给出地址`))
          return
        }
        resolve({ version: proc.version, status: 'running', url: proc.url })
        return
      }
      if (Date.now() - proc.startedAt > START_TIMEOUT_MS) {
        killTree(proc.child.pid)
        // 之前这里不清状态：超时后 `status` 仍是 'starting'，`current` 仍指向它 ——
        // 再点启动会命中 `status === 'starting'` 又等一个 180s。现在彻底清掉。
        if (current === proc) current = null
        cancelWaiters(proc)
        pushTagged('启动器', `${proc.version} 启动超时（${Math.round(START_TIMEOUT_MS / 1000)}s），已终止该进程`)
        reject(
          new Error(
            `${proc.version} 启动超时（${Math.round(START_TIMEOUT_MS / 1000)}s）\n${proc.tail.slice(-15).join('\n')}`
          )
        )
        return
      }
      setTimeout(tick, 200)
    }
    proc.startWaiters.push(reject)
    tick()
  })
}

/** 停掉正在跑的桌面端；没在跑就什么都不做。 */
export async function stopDesktop(): Promise<void> {
  const proc = desktopProc
  if (proc === null) return
  desktopProc = null
  proc.stopTail()
  killTree(proc.child.pid)
}

/** 停止当前进程（dsh 或桌面端）；没在跑就直接返回。 */
export async function stopVersion(): Promise<void> {
  await stopDesktop()

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
 * 单次启动的并发令牌。双击 / 并发 IPC 会同时进来两个 `startVersion` ——
 * 没有这道闸会 spawn 出两个 dsh，旧那个的 `exit` 被 `current === proc` 守卫吞掉
 * （留孤儿占端口 + 占 profile 写锁），界面却显示另一个实例在跑。
 */
let startLock: Promise<RunState> | null = null

/** 停止等待中的轮询（`startLock === null` 时调用方在自行组装新实例） */
function cancelWaiters(proc: Proc): void {
  proc.startWaiters.splice(0).forEach((reject) =>
    reject(new Error(`${proc.version} 启动已取消（另一个启动请求接管了状态）\n${proc.tail.slice(-15).join('\n')}`))
  )
}

/** 把一次性启动（spawn + 等就绪）包成串行队列：同一个时刻只有一个在跑。 */
export async function startVersion(
  version: string,
  onDesktopProgress?: (progress: DesktopProgress) => void
): Promise<RunState> {
  if (startLock !== null) {
    const running = startLock
    const state = await running
    if (state.version === version && state.status === 'running') return state
    return startVersion(version, onDesktopProgress)
  }
  const job = startVersionInner(version, onDesktopProgress)
  startLock = job
  try {
    return await job
  } finally {
    if (startLock === job) startLock = null
  }
}

async function startVersionInner(
  version: string,
  onDesktopProgress?: (progress: DesktopProgress) => void
): Promise<RunState> {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) throw new Error(`版本号不合法：${version}`)

  const profile = readSettings().profile

  /*
   * **插件母版闸门。**
   *
   * 插件现在只有一个写入点（母版），web 与桌面端都是它的副本。母版没初始化 = 还不知道
   * 插件该以哪边为基线，这时候启动任何一个都会得到一套"不确定的插件"，所以直接拒绝，
   * 由界面弹窗让用户选 web / 桌面端作为初始基线（见 pluginBase.ts）。
   */
  if (profile === 'web' || profile === 'desktop') {
    const base = baseStatus()
    if (!base.initialized) {
      throw new Error(
        'BASEPENDING:' +
          '插件母版还没有初始化。请先选择以「Web 端」还是「桌面端」现有的插件作为基线，' +
          '之后所有启动方式都会使用这套插件。'
      )
    }
  }

  /*
   * 桌面端不是 dsh 的 profile，而是另一个 Electron 应用：这里不 spawn dsh，改成
   * 「按需下载 + 解压官方安装包 → 启动它」，并把进程记进 desktopProc ——
   * 于是它和 web 一样：界面标「运行中」、点「停止」能掐断。
   * 返回 url=null，界面据此知道不该去开浏览器。
   */
  if (profile === 'desktop') {
    // 同一个版本已经在跑 → 直接返回，不重复启动
    if (desktopProc !== null && desktopProc.version === version) {
      return { version, status: 'running', url: null }
    }
    // 桌面端与 dsh 实例互斥：先停掉在跑的（dsh，或另一个版本的桌面端）
    if (current !== null || desktopProc !== null) await stopVersion()

    const exe = await ensureDesktop(version, onDesktopProgress)

    /*
     * 启动前把母版的插件克隆到桌面端 profile。
     *
     * 以前这里是「web 的插件逐个 remove + add 到桌面端」—— 8 个插件 16 次 pnpm 往返，
     * 每次启动等 2~3 分钟。现在母版是唯一写入点，profile 只是副本，整棵 node_modules
     * 克隆（同盘硬链接）几秒完成。
     *
     * 必须在**启动之前**做 —— 桌面端跑起来就持有 profile 写锁。
     * 克隆失败**不阻断启动**：桌面端本身是好的，只是插件没跟上（会写进终端页）。
     */
    try {
      onDesktopProgress?.({ phase: 'install', text: '正在从插件母版同步到桌面端…' })
      const report = await cloneBaseToProfile('desktop', (text) => {
        onDesktopProgress?.({ phase: 'install', text })
        pushTagged('桌面端', text)
      })
      pushTagged(
        '桌面端',
        `插件已从母版同步：${report.files} 个文件（硬链接 ${report.linked} / 复制 ${report.copied}）`
      )
      if (report.broken.length > 0) {
        pushTagged('桌面端', `这些包不完整：${report.broken.join('、')}（建议在母版里重装）`)
      }
    } catch (cause) {
      pushTagged('桌面端', '从母版同步失败（不影响启动）：' + (cause instanceof Error ? cause.message : String(cause)))
    }

    /*
     * 拉起之前**无条件**再修一次补丁层的 `[]` 占位符（见 repairDesktopPatch 的注释）。
     *
     * 单独一层 try/catch：它绝对不能因为同步里别处（比如装插件那段）出错就被跳过 ——
     * 这个占位符写坏会让桌面端**直接起不来**（"DeepSeek Harness is unavailable"），
     * 属于必须兜住的那一类。
     */
    try {
      const repaired = repairDesktopPatch()
      if (repaired.changed) pushTagged('桌面端', `已修复补丁层占位符（[] → # []）：${repaired.path}`)
    } catch (cause) {
      pushTagged('桌面端', '修复补丁层占位符失败：' + (cause instanceof Error ? cause.message : String(cause)))
    }

    onDesktopProgress?.({ phase: 'launch', text: '正在启动桌面端…' })
    const logPath = desktopLogPath(version)
    const child = launchDesktop(exe, logPath)

    /*
     * 桌面端的 stdio 是写进文件的（detached 进程不能用管道），所以这里**跟随那个文件**
     * 把运行时输出转进终端页 —— 否则「终端」页只有三四行启动器事件，
     * dsh 自己的 `skipping profile bundle "…": Error: …` 一句都看不到。
     */
    const stopTail = tailDesktopLog(logPath, (line) => pushTagged(`桌面端 ${version}`, line))

    desktopProc = { version, child, stopTail }
    // 用户自己关掉桌面端时要清掉状态，否则界面会一直显示「运行中」
    child.on('exit', () => {
      stopTail()
      if (desktopProc !== null && desktopProc.child === child) desktopProc = null
    })
    return { version, status: 'running', url: null }
  }

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
  if (profile !== 'web') {
    const reason =
      profile === 'tui'
        ? 'tui 是终端界面，需要一个真正的终端窗口（TTY），启动器这个窗口里没有终端。'
        : `${profile} 不是 web 界面，不会输出可打开的地址，启动器无法承载它。`
    throw new Error(
      `${reason}\n\n` +
        `想在终端里用它，执行：\n  node "${versionBin(version)}" ${profile}\n\n` +
        '或者到「设置」页把「启动方式」改回 web。'
    )
  }

  if (current !== null && current.version === version) {
    if (current.status === 'running' && current.url !== null) {
      return { version, status: 'running', url: current.url }
    }
    if (current.status === 'starting') {
      // 在等就绪的过程中被取消（另一个 start 接管 / 超时清了状态）→ 别再等，重新启动
      if (current !== null && current.version !== version) return startVersionInner(version, onDesktopProgress)
      return waitUntilReady(current)
    }
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

  /*
   * 启动前把母版的插件克隆到 web profile —— 与桌面端走同一条路。
   *
   * 这一步失败**必须**阻断：web 端会拿着一个没插件（或半残缺）的 profile 跑起来，
   * 表现是"插件全没了"，比启动失败更难排查。
   */
  const cloneReport = await cloneBaseToProfile('web', (text) => pushTagged('web', text))
  pushTagged('web', `插件已从母版同步：${cloneReport.files} 个文件（硬链接 ${cloneReport.linked} / 复制 ${cloneReport.copied}）`)
  if (cloneReport.broken.length > 0) {
    pushTagged('web', `这些包不完整：${cloneReport.broken.join('、')}（建议在母版里重装）`)
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

/** 退出应用时收尾：杀掉还在跑的 dsh / 桌面端，别留孤儿进程（会一直占着内存）。 */
export function stopAllSync(): void {
  const dsh = current
  if (dsh !== null) {
    killTree(dsh.child.pid)
    current = null
  }
  const desktop = desktopProc
  if (desktop !== null) {
    desktop.stopTail()
    killTree(desktop.child.pid)
    desktopProc = null
  }
}
