import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, renameSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, net } from 'electron'
import { dshHome } from './dshHome'
import { dataRoot } from './paths'
import { decodeChunk } from './textDecode'

/**
 * 「桌面端」启动方式：下载官方 DeepSeek Harness Desktop 安装包 → 静默安装 → 启动。
 *
 * 为什么是「下载」而不是「编译」：desktop 是另一个 Electron 应用（`@deepseek-ai/dsh-desktop`，
 * private，不发 npm），官方把它编译成 NSIS 安装包发到 `download.deepseek.com`。在用户机器上
 * 从源码编译它等于重跑官方发版流水线（自定义 Electron 发行版 + 签名 + PowerShell 安装器脚本），
 * 普通机器跑不起来；下载官方已编译产物才是可行路径。
 *
 * 版本与 dsh 同号：`deepseek-harness-<版本>-win-x64.exe`。选中的 dsh 版本没有对应 desktop 时，
 * 下载会 404，这里把它转成一句明确的错误。
 */

/** 桌面端启动过程的粗粒度进度 */
export interface DesktopProgress {
  phase: 'download' | 'install' | 'launch'
  text: string
}

const ORIGIN = 'https://download.deepseek.com'
/** electron-builder 的 productName 是 "DeepSeek Harness"，安装后这个就是可执行文件名 */
const PRODUCT_EXE = 'DeepSeek Harness.exe'
/** 下载失败最多重试几次 */
const DOWNLOAD_ATTEMPTS = 3

/** 桌面端根目录：与 dsh 版本池平级（`<数据根>/{dsh,desktop}`） */
function desktopRoot(): string {
  return join(dataRoot(), 'desktop')
}
/** 一个版本一个目录，与 `dsh/<版本>` 同构 */
function versionDir(version: string): string {
  return join(desktopRoot(), version)
}
/** 安装包落在版本目录里 */
function installerPath(version: string): string {
  return join(versionDir(version), `deepseek-harness-${version}-win-x64.exe`)
}
/**
 * 静默安装目标：版本目录下的 `app/`。
 *
 * **不能直接装进版本目录本身** —— NSIS 要求新安装位置为空，而版本目录里躺着安装包。
 */
function appDir(version: string): string {
  return join(versionDir(version), 'app')
}
function appExe(version: string): string {
  return join(appDir(version), PRODUCT_EXE)
}
function desktopUrl(version: string): string {
  return `${ORIGIN}/dsh-desk/bin/win-x64/deepseek-harness-${version}-win-x64.exe`
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0)
}

/** 「该版本没有桌面端」这一类错误重试没有意义 */
const NO_DESKTOP_RE = /没有对应的桌面端/

/**
 * 单次下载，走 **Electron 的 `net`（Chromium 网络栈）**。
 *
 * 为什么不用 Node 的 `fetch`：undici 不认系统代理、也不认 Windows 证书库。挂了代理 / TUN 做
 * TLS 中间人的机器上，它会以 `TypeError: fetch failed` 收场、且不给任何原因（本启动器给 dsh 传
 * `--use-system-ca` 要解决的正是同一类问题）。Chromium 的网络栈天然走系统代理与系统证书库，
 * 是 Electron 主进程里做下载的正确选择。
 */
function downloadOnce(version: string, onProgress: (p: DesktopProgress) => void): Promise<void> {
  const url = desktopUrl(version)
  const final = installerPath(version)
  mkdirSync(dirname(final), { recursive: true })
  const tmp = `${final}.part`

  return new Promise<void>((resolve, reject) => {
    const request = net.request(url)

    request.on('error', (error: Error) => {
      reject(new Error(`网络请求失败：${error.message}`))
    })

    request.on('response', (response) => {
      const status = response.statusCode
      /*
       * Electron 的类型把 IncomingMessage 声明成 NodeEventEmitter（没暴露 pipe / resume），
       * 但运行时它就是标准的可读流；这里按可读流使用。
       */
      const stream = response as unknown as NodeJS.ReadableStream

      if (status === 404) {
        stream.resume()
        reject(new Error(`版本 ${version} 没有对应的桌面端。`))
        return
      }
      if (status !== 200) {
        stream.resume()
        reject(new Error(`下载桌面端失败：HTTP ${status}`))
        return
      }

      const raw = response.headers['content-length']
      const total = Number(Array.isArray(raw) ? raw[0] : (raw ?? 0))
      let received = 0
      let settled = false

      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      stream.on('data', (chunk: Buffer) => {
        received += chunk.length
        const percent = total > 0 ? Math.round((received / total) * 100) : null
        onProgress({
          phase: 'download',
          text:
            percent === null
              ? `正在下载桌面端（${mb(received)} MB）…`
              : `正在下载桌面端 ${percent}%（${mb(received)} MB）…`
        })
      })
      stream.on('error', (error: Error) => fail(new Error(`下载中断：${error.message}`)))

      const out = createWriteStream(tmp)
      out.on('error', fail)
      stream.pipe(out)

      out.on('finish', () => {
        if (settled) return
        settled = true
        void (async () => {
          try {
            // 完整性：长度对不上就是下载断了/被截断，别拿坏包去装
            if (total > 0) {
              const s = await stat(tmp)
              if (s.size !== total) {
                throw new Error(`桌面端下载不完整：期望 ${total} 字节，得到 ${s.size} 字节。`)
              }
            }
            renameSync(tmp, final)
            resolve()
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })()
      })
    })

    request.end()
  })
}

/** 下载安装包到版本目录，带进度与重试。404（该版本没有桌面端）不重试。 */
async function download(version: string, onProgress: (p: DesktopProgress) => void): Promise<void> {
  onProgress({ phase: 'download', text: '首次启动桌面端需要下载安装包（约 276 MB）…' })

  let lastError: unknown
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      await downloadOnce(version, onProgress)
      onProgress({ phase: 'download', text: '桌面端下载完成' })
      return
    } catch (error) {
      lastError = error
      const text = error instanceof Error ? error.message : String(error)
      if (NO_DESKTOP_RE.test(text)) throw error
      if (attempt < DOWNLOAD_ATTEMPTS) {
        onProgress({
          phase: 'download',
          text: `下载失败（${text}），正在重试 ${attempt}/${DOWNLOAD_ATTEMPTS - 1}…`
        })
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * 找 7za：随包带的 `<应用目录>/node/7za.exe`（开发时在 `node-bundle/node/`）。
 *
 * 解压必须靠它 —— 官方只发 NSIS 安装包，而那个安装器是全局单实例的（见下方 extract 的说明）。
 */
function sevenZip(): string | null {
  const root = app.isPackaged
    ? process.resourcesPath.replace(/[\\/]?resources[\\/]?$/, '')
    : app.getAppPath()
  const candidates = [
    join(root, 'node', '7za.exe'),
    join(root, 'node', '7za'),
    join(root, 'node-bundle', 'node', '7za.exe')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 用 7za 把官方 NSIS 安装包**解压成绿色版**装进 `app/`。
 *
 * 为什么不直接跑那个安装器：它是**全局单实例**的（按固定 appId 注册）。装第二个版本时它会先
 * 「卸载旧版本文件」，于是多版本无法并存、重复启动还会去重装 —— 实测报
 * "Failed to uninstall old application files"。7za 能识别 NSIS 包内嵌的 7z，直接解出应用文件，
 * 既留下干净的绿色目录，也彻底不碰注册表。
 */
function extract(version: string): Promise<number> {
  const zip = sevenZip()
  if (zip === null) {
    throw new Error('找不到 7za.exe，无法解开桌面端安装包。请重新安装启动器。')
  }
  const installer = installerPath(version)
  const dir = appDir(version)
  mkdirSync(dir, { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn(zip, ['x', '-y', '-bso0', '-bsp0', `-o${dir}`, installer], {
      windowsHide: true,
      stdio: 'ignore'
    })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? -1))
  })
}

/**
 * 启动已解压好的桌面端，返回 child 交给 runner 跟踪 / 掐断。
 *
 * detached + unref：桌面端是独立应用，不该被启动器当作"子进程"绑死；
 * 但句柄仍留在启动器手里，所以「停止」能杀掉它 —— 这正是"能监测、能掐断"的落点。
 */
/** 桌面端的启动日志（每次启动覆盖写）。诊断靠它拿"哪些 bundle 被跳过"。 */
export function desktopLogPath(version: string): string {
  return join(versionDir(version), 'desktop.log')
}

export function launchDesktop(exe: string, logPath: string): ChildProcess {
  /*
   * stdout/stderr 落到 `<版本目录>/desktop.log`（每次启动覆盖）。
   *
   * 为什么必须留这份：桌面端启动时 dsh 会打印
   *   `dsh: skipping profile bundle "<名>": Error: <原因>`
   * 而**没有任何 CLI 能 dump desktop profile** —— `--profile desktop` 被 dsh 明确拒绝，
   * 桌面端自带的 CLI 也一样拒（实测）。所以这份启动输出是唯一能拿到
   * "桌面端哪些插件没加载"的来源。
   */
  const fd = openSync(logPath, 'w')
  let child: ChildProcess
  try {
    child = spawn(exe, [], {
      detached: true,
      stdio: ['ignore', fd, fd],
      /*
       * 必须显式传 DSH_HOME：桌面端和 web 一样按它找数据目录（会话、凭据、storages 都在那儿）。
       * 不传的话它落回默认的 ~/.dsh —— 用户在设置里改过「插件与数据目录」时，web 跟着变了、
       * 桌面端却还看旧目录，表现就是"打开是空的"。
       *
       * 注意：共享的是 $DSH_HOME 下的产品数据；**profile 不共享** —— 桌面端独占
       * $DSH_HOME/profiles/desktop（官方设计），所以它的插件/依赖跟 web 那套是隔离的。
       */
      env: { ...process.env, DSH_HOME: dshHome() }
    })
  } finally {
    // 子进程已继承这份句柄，父进程关掉自己的副本，别泄漏
    closeSync(fd)
  }
  child.unref()
  return child
}

/**
 * 保证某版本的桌面端**已就位**（按需下载 + 解压），返回可执行文件路径。
 *
 * **不负责启动** —— 启动与进程跟踪放在 runner 里，这样「运行中 / 停止」与 web 走同一套状态机。
 *
 * 缓存：`desktop/<版本>/app/DeepSeek Harness.exe` 已存在就直接返回（秒复用）；
 * 否则用版本目录里的安装包解压；安装包也没有才下载。
 */
export async function ensureDesktop(
  version: string,
  onProgress: (p: DesktopProgress) => void = () => {}
): Promise<string> {
  if (existsSync(appExe(version))) return appExe(version)

  if (!existsSync(installerPath(version))) {
    await download(version, onProgress)
  }

  onProgress({ phase: 'install', text: '正在解压桌面端（首次较慢，约 1 GB）…' })
  const code = await extract(version)
  if (code !== 0) throw new Error(`桌面端解压失败（退出码 ${code}）`)
  if (!existsSync(appExe(version))) {
    throw new Error('桌面端解压完成，但找不到可执行文件。')
  }
  return appExe(version)
}

/**
 * 桌面端自带的运行时入口。
 *
 * 它的 CLI 脚本（`resources/runtime/cli/bin/dsh.cmd`）本质是：
 *   `ELECTRON_RUN_AS_NODE=1 "<app>/DeepSeek Harness.exe" --expose-internals "<app>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" <args>`
 *
 * 所以我们**不经 shell**、直接按这两段去 spawn —— 既避开 `.cmd` 的引号问题，也不会被参数注入。
 * 用它管 desktop profile 的意义：兼容性判断用的是**它自己的 dsh 版本**，豁免才授得对版本。
 */
export interface DesktopRuntime {
  /** Electron 可执行文件（配合 ELECTRON_RUN_AS_NODE 当 node 用） */
  electron: string
  /** desktop-host 的 CLI 入口 */
  cliJs: string
}

export function desktopRuntime(version: string): DesktopRuntime | null {
  const root = appDir(version)
  const electron = join(root, PRODUCT_EXE)
  const cliJs = join(
    root,
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js'
  )
  if (!existsSync(electron) || !existsSync(cliJs)) return null
  return { electron, cliJs }
}

/** 已解压好的桌面端版本（目录里存在 app 可执行文件的那些）。 */
export function installedDesktopVersions(): string[] {
  const root = desktopRoot()
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(appExe(entry.name)))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 跑一次桌面端自带的 CLI，逐行回调，返回退出码与输出尾部。
 *
 * 用途：装插件（sync.ts）、`--profile desktop --dump-config` 诊断（diagnose.ts）。
 * 它在桌面端**运行时**会被 profile 写锁挡住，所以只用于「启动前」与「只读诊断」。
 */
export function runDesktopCli(
  rt: DesktopRuntime,
  args: string[],
  onLine: (line: string) => void
): Promise<{ code: number; tail: string[] }> {
  const tail: string[] = []
  return new Promise((resolve, reject) => {
    // 不经 shell：直接按 dsh.cmd 的配方跑（ELECTRON_RUN_AS_NODE + CLI 入口）
    const child = spawn(rt.electron, ['--expose-internals', rt.cliJs, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    let buffer = ''
    const consume = (chunk: Buffer): void => {
      buffer += decodeChunk(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.replace(/\s+$/, '')
        if (!text) continue
        if (tail.length >= 60) tail.shift()
        tail.push(text)
        onLine(text)
      }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, tail }))
  })
}
