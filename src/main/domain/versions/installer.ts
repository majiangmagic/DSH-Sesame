import { spawn } from 'node:child_process'
import { createStreamDecoder } from '../../platform/textDecode'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { versionBin, versionDir } from '../../platform/paths'
import { registryUrl } from '../../platform/registry'
import { currentRun } from '../control/runner'
import { VERSION_RE } from './versions'

/**
 * 版本的安装 / 卸载。
 *
 * 安装配方：在版本目录里写一个私有的 package.json 和 .npmrc，
 * 再让 npm 把 `@deepseek-ai/dsh@<版本>` 装进去。写成私有清单 + 不生成 lockfile，是为了让每个
 * 版本目录自包含、可整份删除重建。
 *
 * **node / npm 一律从 PATH 找**，不自带运行时。同类做法也有在应用目录下自带一份 node 的，
 * 用它会让本应用隐式依赖那个目录；用户在 PATH 上没有 node 时报错即可，不偷偷借用。
 */

/** 安装/卸载过程中的粗粒度进度，用来给界面反馈 */
export interface InstallProgress {
  phase: 'resolve' | 'download' | 'done'
  text: string
}

/**
 * 正在运行的版本。**真实运行态在 `control/runner.ts` 的 `currentRun()` 里**，
 * 这里不再维护一份会漂移的副本 —— 之前那个 `runningVersion` 变量恒为 null、无人写入，
 * 导致"运行中不给卸"的守卫永远不触发（dsh 在跑时卸载，会留下半破损的目录）。
 */
function isRunning(version: string): boolean {
  const run = currentRun()
  return run !== null && run.version === version && run.status === 'running'
}

/** 在 PATH 里找一个可执行文件（Windows 试 .exe/.cmd/.bat，其它平台试原名）。 */
function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

interface NpmCommand {
  file: string
  /** npm-cli.js 的路径；为空表示直接用 file（PATH 上的 npm） */
  cli: string | null
}

/**
 * 定位 npm。
 *
 * 优先用 `node <npm-cli.js>`：不经 shell、不碰 .cmd，跨平台最稳（Node 在 Windows 上直接 spawn
 * `.cmd` 会 EINVAL）。找不到 npm-cli.js 才退回 PATH 上的 npm，并交给 shell 执行。
 */
function resolveNpm(): NpmCommand | { error: string } {
  const node = findOnPath('node')
  if (node) {
    const cli = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(cli)) return { file: node, cli }
  }
  const npm = findOnPath('npm')
  if (npm) return { file: npm, cli: null }
  return {
    error: ' 在 PATH 上找不到 node / npm。请先安装 Node.js 22.19+ 或 24+，再重试下载。'
  }
}

interface RunResult {
  code: number
  tail: string[]
}

/** 跑一次命令，逐行回调，并把最后若干行留下作为失败时的诊断。 */
function run(
  command: NpmCommand,
  args: string[],
  options: { cwd: string; onLine: (line: string) => void; tailLines?: number }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const tail: string[] = []
    const keep = options.tailLines ?? 40
    const useShell = command.cli === null
    const finalArgs = command.cli === null ? args : [command.cli, ...args]
    const child = spawn(command.file, finalArgs, {
      cwd: options.cwd,
      shell: useShell,
      windowsHide: true
      /*
       * 这里原本还关了一堆 npm 降噪开关（update_notifier / progress / audit / fund）。
       * 去掉了：它们是**纯装饰性**的，代价却是每次 spawn 都往子进程环境里塞四个变量，
       * 而这些变量会不会被误读、跟别的 npm 调用冲突，都没人验证过。
       * （真正 load-bearing 的是 pluginInstall 里的 `npm_config_reporter: append-only`，
       * 那个是为了拿到逐行输出，保留。）
       */
    })

    const decoders = { stdout: createStreamDecoder(), stderr: createStreamDecoder() }
    const buffers = { stdout: '', stderr: '' }
    const consume = (which: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      buffers[which] += decoders[which].decode(chunk)
      const lines = buffers[which].split(/\r?\n/)
      buffers[which] = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.replace(/\s+$/, '')
        if (!text) continue
        if (tail.length >= keep) tail.shift()
        tail.push(text)
        options.onLine(text)
      }
    }

    child.stdout?.on('data', consume('stdout'))
    child.stderr?.on('data', consume('stderr'))
    child.on('error', reject)
    child.on('close', (code) => {
      const rest = buffers.stdout.trim() !== '' ? buffers.stdout.trim() : buffers.stderr.trim()
      if (rest !== '') {
        if (tail.length >= keep) tail.shift()
        tail.push(rest)
        options.onLine(rest)
      }
      resolve({ code: code ?? -1, tail })
    })
  })
}

function writePrivateManifest(root: string): void {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ private: true, name: 'dsh-version', version: '0.0.0' }, null, 2)}\n`,
    'utf8'
  )
  // .npmrc 写进版本目录，让这个目录自描述：手工在这里跑 npm install 也走同一个源
  writeFileSync(
    join(root, '.npmrc'),
    `registry=${registryUrl()}\naudit=false\nfund=false\nupdate-notifier=false\nprogress=false\n`,
    'utf8'
  )
}

/**
 * 安装一个版本。
 *
 * @param version - 精确版本号（调用方给的是远端列表里的一项，不是范围）
 * @param onProgress - 进度回调；界面据此显示"正在解析依赖 / 正在下载"
 * @throws 装完后 `lib/bin.js` 仍不存在时抛错，并把 npm 输出的最后若干行带上
 */
export async function installVersion(
  version: string,
  onProgress: (progress: InstallProgress) => void = () => {},
  /**
   * 原始输出行（npm 的每一行，未过滤）。
   *
   * 与 `onProgress` 分开：进度只挑"已装 N 个包 / 错误"两类给界面看，避免刷屏；
   * 而终端页需要**全部原始行**才有排查价值 —— 装失败时真正有用的往往是
   * `npm http fetch` 的 404、或者某个 peer 冲突的 warn。
   */
  onLine: (line: string) => void = () => {}
): Promise<void> {
  // 与 versions.ts 扫描端的 VERSION_RE 同源：形状不认就拒绝 —— version 直接拼路径，
  // "../../x" 会在数据根之外建目录；也挡掉空串与 shell 元字符
  if (!VERSION_RE.test(version)) throw new Error(`版本号不合法：${version}`)

  const npm = resolveNpm()
  if ('error' in npm) throw new Error(npm.error)

  const root = versionDir(version)
  mkdirSync(root, { recursive: true })
  writePrivateManifest(root)
  onProgress({ phase: 'resolve', text: `正在解析 @deepseek-ai/dsh@${version} 的依赖…` })

  let lastText = ''
  const result = await run(
    npm,
    [
      'install',
      `@deepseek-ai/dsh@${version}`,
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--loglevel=http',
      '--no-progress'
    ],
    {
      cwd: root,
      onLine: (line) => {
        // 原始行先交给调用方（终端页要全量），再挑两类给界面进度
        onLine(line)
        // 只把有价值的两类行报给界面，避免刷屏：包计数与错误
        const added = line.match(/added (\d+) packages?/i)
        if (added) {
          lastText = `已安装 ${added[1]} 个包`
          onProgress({ phase: 'download', text: lastText })
          return
        }
        if (/npm (error|ERR!)/i.test(line)) {
          lastText = line
          onProgress({ phase: 'download', text: line })
        }
      }
    }
  )

  if (result.code !== 0) {
    // 失败时清掉半成品目录 —— 留下它会让"装好了"的判据（versionBin 存在）永远不成立，
    // 下次同名安装也只是在废墟上覆盖
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 清不掉就算了，至少把真实错误抛出去
    }
    const detail = result.tail.slice(-8).join('\n')
    throw new Error(`npm 安装 ${version} 失败（退出码 ${result.code}）：\n${detail}`)
  }
  if (!existsSync(versionBin(version))) {
    const detail = result.tail.slice(-8).join('\n')
    throw new Error(`装完了但找不到 ${version} 的入口文件（${versionBin(version)}）。npm 输出：\n${detail}`)
  }
  onProgress({ phase: 'done', text: `${version} 安装完成` })
}

/**
 * 卸载一个版本：整份删掉 `<版本根>/<版本号>`。
 *
 * 正在运行的版本不给删 —— 与前端那条禁用规则同源，但这里再挡一次：
 * 界面可以被绕过，文件系统这一层不能。
 */
export async function uninstallVersion(version: string): Promise<void> {
  if (isRunning(version)) {
    throw new Error(`${version} 正在运行，不能卸载。请先停止它。`)
  }
  const root = versionDir(version)
  if (!existsSync(root)) throw new Error(`没有找到已安装的 ${version}`)

  // 只允许删版本根目录下面的一层，避免路径拼错时删到别处
  const expectedParent = dirname(root)
  if (!existsSync(expectedParent)) throw new Error(`版本根目录不存在：${expectedParent}`)

  const entries = readdirSync(expectedParent)
  if (!entries.includes(version)) throw new Error(`版本根目录里没有 ${version}，拒绝删除`)

  rmSync(root, { recursive: true, force: true })
}
