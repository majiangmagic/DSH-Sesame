import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { app, net } from 'electron'
import { compareVersionStrings } from '@utils/version'
import { destroyTray } from '../../platform/tray'
import { dataRoot, dataRootInsideInstallDir } from '../../platform/paths'
import { stopAllSync } from '../control/runner'
import type { LauncherUpdateInfo, LauncherUpdateProgressEvent } from '@shared/types/update'
import { parseLatestYml, releaseAssetUrl, releasePageUrl, repoSlugFrom } from './updateMeta'

/**
 * 静默安装参数（逐字来自 electron-builder 的 NSIS 白名单，见文件头说明）。
 */
const INSTALLER_ARGS = ['/S', '--updated', '--force-run']

/**
 * 更新过程日志（`<userData>/update.log`）。
 *
 * 为什么需要：更新失败时应用已经退出，终端页那份内存缓冲跟着没了 —— 用户只看到
 * "点了更新、然后就没了"，没有任何可查的东西。写成文件，下一次至少能回答
 * "安装器到底起没起来、几秒退的、退了几号"。
 */
export function updateLogPath(): string {
  return join(app.getPath('userData'), 'update.log')
}

function appendUpdateLog(line: string): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    appendFileSync(updateLogPath(), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // 日志写不进去不该影响更新本身
  }
}

/**
 * **启动器自己**的更新：检查 GitHub Releases → 下载安装包 → 校验 → 静默安装 → 退出。
 *
 * ## 为什么走 GitHub Releases
 *
 * 每次发版 `scripts/publish-release.mjs` 都会产出 `DSH-Sesame-Setup-<版本>.exe` 与
 * `latest.yml`（electron-builder 生成），发布时一起传到 Releases。所以"从仓库更新"
 * 就是读那个 `latest.yml` —— **不需要额外服务端**。
 *
 * ## 为什么不用 electron-updater
 *
 * 它能做这件事，但会带来一条依赖链，而且它的下载走 Node 的 undici —— 那**不认系统代理、
 * 也不认 Windows 证书库**（`domain/control/desktop.ts` 里有同样结论的详细记录：
 * 挂了代理 / TUN 做 TLS 中间人的机器上会以 `fetch failed` 收场且不给原因）。
 * 这里用 Electron 的 `net`（Chromium 网络栈），与下载桌面端同一套，天生走系统代理与证书库。
 *
 * ## 静默安装用的参数（都核对过 electron-builder 的 NSIS 模板）
 *
 *     Setup.exe /S --updated --force-run
 *
 *   · `/S` —— NSIS 的静默开关；
 *   · `--updated` —— NSIS 按"这是升级"处理：**跳过所有页面**、且**不清用户数据**
 *     （`installUtil.nsh` 的注释写明：总是传 `--updated` 以保证不删用户数据）；
 *   · `--force-run` —— 装完自动重启应用。assisted 安装器只在**静默**时才看这个标志，
 *     而我们正好是静默，所以它会生效（`installSection.nsh` 的 `${isForceRun} && ${Silent}`）。
 *
 * 这几个标志来自 `NsisTarget.js` 里 `flags([...])` 声明的白名单，
 * 不是猜的 —— 写成 `--force-run 1` 这种带值的写法不会被识别。
 *
 * ## 只在本机、只在打包后
 *
 * 开发模式（`npm run dev`）下 `app.isPackaged` 为 false，装的是源码目录，
 * **不允许自更新** —— 那会把开发目录搅坏。检查更新仍然可用（只是提示不可安装）。
 */

/**
 * 仓库坐标 —— **换 fork 只改这一处**。
 *
 * 为什么是常量而不是读 `package.json` 的 `repository`：
 * **electron-builder 会从那个字段推断 publish 配置**（`PublishManager.js` 的
 * "no publishConfigs, detect using repository info"），加上它会改变打包行为 ——
 * 可能改 `latest.yml` 的形状、或在打包时要求 `GH_TOKEN`。
 * 为了一个元数据字段去动发布链路不划算，所以这个字段**刻意不加**。
 *
 * 读取逻辑仍然留着（`repoSlugFrom`）：谁要是哪天有意加了 `repository`，
 * 这里会自动认出来；认不出才用下面这个常量。
 */
const FALLBACK_REPO = 'majiangmagic/DSH-Sesame'

/** 安装包下载后的落点：系统临时目录。装完由安装器接手，我们不负责清理。 */
function installerPath(version: string): string {
  return join(app.getPath('temp'), `DSH-Sesame-Setup-${version}.exe`)
}

function repoSlug(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      repository?: unknown
    }
    return repoSlugFrom(pkg.repository) ?? FALLBACK_REPO
  } catch {
    // 读不到就用常量
    return FALLBACK_REPO
  }
}

/**
 * 发一次 GET 并把响应体读成文本。
 *
 * 用 Electron 的 `net` 而不是 `fetch`：理由见文件头（系统代理与系统证书库）。
 * 非 2xx 直接抛，因为调用处都当作"这一次查不到"处理。
 */
function getText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request(url)
    request.on('error', (error: Error) => reject(new Error(`网络请求失败：${error.message}`)))
    request.on('response', (response) => {
      const status = response.statusCode ?? 0
      /*
       * Electron 把 IncomingMessage 声明成 NodeEventEmitter（没暴露 setEncoding），
       * 但运行时它就是标准的可读流；这里按可读流读。
       */
      const stream = response as unknown as NodeJS.ReadableStream
      if (status < 200 || status >= 300) {
        stream.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', (error: Error) => reject(new Error(`读取响应失败：${error.message}`)))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    request.end()
  })
}

/** 已经开始装了吗 —— 防连点，也防"下载中又点一次检查" */
let installing = false

/** 正在安装（界面据此禁用按钮、保持进度可见） */
export function isInstalling(): boolean {
  return installing
}

/**
 * 检查更新。**不下载、不抛异常** —— 设置页打开时就会调它，一次网络失败不该让它报错。
 */
export async function checkLauncherUpdate(): Promise<LauncherUpdateInfo> {
  const current = app.getVersion()
  const repo = repoSlug()
  const base: LauncherUpdateInfo = {
    current,
    latest: null,
    available: false,
    assetUrl: null,
    assetBytes: 0,
    sha512: null,
    releaseUrl: releasePageUrl(repo),
    error: ''
  }

  let text: string
  try {
    text = await getText(releaseAssetUrl(repo, 'latest.yml'))
  } catch (cause) {
    return { ...base, error: `读不到发布信息：${cause instanceof Error ? cause.message : String(cause)}` }
  }

  const meta = parseLatestYml(text)
  if (meta === null) {
    return { ...base, error: '发布信息里没有版本号或安装包名（latest.yml 形状变了？）' }
  }

  /*
   * 用 `@utils/version` 比 —— 与 dsh 版本管理同一套比较逻辑。
   * 这里同样**不信任何"latest"字面**：版本高低由 semver 决定，不由标签名决定。
   */
  const diff = compareVersionStrings(meta.version, current)
  if (diff === null) {
    return { ...base, latest: meta.version, error: `版本号形状不认识：当前 ${current} / 远端 ${meta.version}` }
  }

  return {
    ...base,
    latest: meta.version,
    available: diff > 0,
    assetUrl: diff > 0 ? releaseAssetUrl(repo, meta.file) : null,
    assetBytes: meta.size,
    sha512: meta.sha512 === '' ? null : meta.sha512
  }
}

/**
 * 下载安装包到临时目录，边下边算 sha512。
 *
 * 流式：安装包 140 MB 左右，整个读进内存没必要。
 *
 * @returns 落盘路径
 * @throws 网络失败、写入失败、或 sha512 与 `latest.yml` 对不上
 */
async function download(
  url: string,
  dest: string,
  expectedSha512: string | null,
  onProgress: (p: LauncherUpdateProgressEvent) => void
): Promise<void> {
  mkdirSync(join(dest, '..'), { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const request = net.request(url)
    request.on('error', (error: Error) => reject(new Error(`下载失败：${error.message}`)))

    request.on('response', (response) => {
      const status = response.statusCode ?? 0
      const stream = response as unknown as NodeJS.ReadableStream
      if (status < 200 || status >= 300) {
        stream.resume()
        reject(new Error(`下载失败：HTTP ${status}`))
        return
      }

      const raw = response.headers['content-length']
      const total = Number(Array.isArray(raw) ? raw[0] : (raw ?? 0))
      const hash = createHash('sha512')
      let received = 0
      let settled = false

      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        try {
          out.destroy()
        } catch {
          // 关不掉也无所谓：下面的 unlink 会把半成品删掉
        }
        try {
          if (existsSync(dest)) unlinkSync(dest)
        } catch {
          // 删不掉就算了，下次会覆盖
        }
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      const out = createWriteStream(dest)
      out.on('error', fail)

      stream.on('data', (chunk: Buffer) => {
        received += chunk.length
        hash.update(chunk)
        const percent = total > 0 ? Math.round((received / total) * 100) : null
        onProgress({
          phase: 'download',
          text:
            percent === null
              ? `正在下载更新（${(received / 1024 / 1024).toFixed(0)} MB）…`
              : `正在下载更新 ${percent}%（${(received / 1024 / 1024).toFixed(0)} MB）…`,
          percent
        })
      })
      stream.on('error', (error: Error) => fail(new Error(`下载中断：${error.message}`)))
      stream.pipe(out)

      out.on('finish', () => {
        if (settled) return
        settled = true

        // 长度对不上：下载断了或被截断，别拿坏包去装
        if (total > 0 && received !== total) {
          try {
            unlinkSync(dest)
          } catch {
            // 忽略
          }
          reject(new Error(`安装包下载不完整：期望 ${total} 字节，得到 ${received} 字节。`))
          return
        }

        if (expectedSha512 !== null) {
          onProgress({ phase: 'verify', text: '正在校验安装包…', percent: null })
          const actual = hash.digest('base64')
          if (actual !== expectedSha512) {
            try {
              unlinkSync(dest)
            } catch {
              // 忽略
            }
            reject(
              new Error(
                '安装包校验失败（sha512 与发布信息不一致）—— 已删除，不安装。\n' +
                  `期望 ${expectedSha512}\n实际 ${actual}`
              )
            )
            return
          }
        }
        resolve()
      })
    })

    request.end()
  })
}

/**
 * 下载并安装更新。**成功时这个函数不会返回** —— 它会启动安装器并让应用退出。
 *
 * @param onProgress - 进度回调（推到发起请求的那个窗口）
 * @throws 开发模式、已在安装中、或下载/校验失败
 */
export async function installLauncherUpdate(
  onProgress: (p: LauncherUpdateProgressEvent) => void
): Promise<void> {
  if (!app.isPackaged) {
    throw new Error(
      '开发模式不提供自更新 —— 现在跑的是源码目录，装安装包会把它搅坏。\n' +
        '请在打包后的应用里用这个按钮，或直接 git pull。'
    )
  }
  if (installing) throw new Error('更新已经在进行中')

  const info = await checkLauncherUpdate()
  if (info.error !== '') throw new Error(info.error)
  if (!info.available || info.latest === null || info.assetUrl === null) {
    throw new Error(`当前已是最新版本（${info.current}）`)
  }
  // 完整性校验不可缺席：latest.yml 缺 sha512 时**拒绝安装**，
  // 而不是像之前那样悄悄跳过校验 —— 那样整个安装包的完整性只靠 HTTPS 赌。
  if (info.sha512 === null) {
    throw new Error('发布信息里缺少 sha512 校验值，拒绝安装。请稍后重试，或到发布页手动下载。')
  }

  installing = true
  try {
    const dest = installerPath(info.latest)
    // 上一次失败留下的半成品：长度与校验都会挡住它，但先删掉更干净
    if (existsSync(dest)) {
      try {
        unlinkSync(dest)
      } catch {
        // 删不掉就让后面的覆盖写
      }
    }

    onProgress({ phase: 'download', text: '正在下载更新…', percent: null })
    await download(info.assetUrl, dest, info.sha512, onProgress)

    const size = statSync(dest).size
    if (size < 1024 * 1024) {
      throw new Error(`下载到的安装包只有 ${size} 字节，明显不完整。`)
    }

    onProgress({ phase: 'install', text: '正在启动安装程序…应用会退出并自动重启', percent: null })

    /*
     * 数据目录与安装目录重叠时**不敢装**：NSIS 升级会先把 $INSTDIR 逐个改名搬走，
     * 只要有一个文件被占用就 Abort（静默模式什么都不显示）—— 应用已经关了，用户就卡在
     * "更新完什么都没出现"。这条判断是为了让这种事发生时**至少说清原因**。
     */
    if (dataRootInsideInstallDir()) {
      throw new Error(
        '数据目录还在安装目录里面（' +
          dataRoot() +
          '）。这种布局下升级会被安装器中断，且可能连带删掉版本池与桌面端。\n' +
          '请先在「设置 → 版本位置」把数据目录指到安装目录之外（或运行 scripts/migrate-data.mjs），再更新。'
      )
    }

    /*
     * 参数见文件头。`detached` + `unref`：安装器要活得比我们久 ——
     * 我们马上强制退出，它得继续把文件替完。
     */
    const child = spawn(dest, INSTALLER_ARGS, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    appendUpdateLog(`已启动安装器 pid=${child.pid ?? '?'} 参数=${INSTALLER_ARGS.join(' ')}`)

    /*
     * 确认安装器**真的接手了**才退出自己。
     *
     * 原来只监听 `error`、然后固定等 1500ms 就 quit —— 安装器立刻失败退出（被杀软拦下、
     * 或 NSIS 的 `Abort`）时我们照样退，于是"应用关了，却没有任何东西回来"。
     * 现在给 3 秒观察窗：期间它非零退出 = 失败，**不退**，把原因报给界面。
     */
    const started = await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (value: boolean, why: string): void => {
        if (settled) return
        settled = true
        appendUpdateLog(why)
        resolve(value)
      }
      child.once('error', (error: Error) => done(false, `安装器启动失败：${error.message}`))
      child.once('exit', (code: number | null) =>
        done(code === 0, `安装器在观察窗内退出，code=${code ?? '-'}`)
      )
      setTimeout(() => done(true, '观察窗内安装器仍在运行 → 认为已接手'), 3000)
    })

    if (!started) {
      installing = false
      throw new Error(
        `安装程序没能接手（可能被杀毒软件拦下，或安装被中断）。\n` +
          `安装包还在：${dest}\n可以直接双击它手动安装。\n详细日志：${updateLogPath()}`
      )
    }

    /*
     * **确定性地退出**，不再依赖 `app.quit()`。
     *
     * `app.quit()` 是"请求退出"：会被窗口的 close 拦截、被未释放的句柄拖住，
     * 而安装器正等着我们腾出文件。`app.exit(0)` 直接终止进程，不留悬念。
     * 代价是 `before-quit` 不会触发，所以清理要在这里自己做。
     */
    setTimeout(() => {
      try {
        stopAllSync()
      } catch {
        // 收尾失败也要退：安装器在等文件
      }
      try {
        destroyTray()
      } catch {
        // 同上
      }
      appendUpdateLog('启动器退出，交给安装器')
      app.exit(0)
    }, 400)
  } catch (cause) {
    installing = false
    throw cause
  }
}
