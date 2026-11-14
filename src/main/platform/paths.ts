import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { app } from 'electron'
import { readSettings } from './settings'
import { dshHome } from './dshHome'

/**
 * DSH-Sesame 的数据根目录。
 *
 * 刻意**不用** `%APPDATA%`，而是放在应用自己旁边（相对路径）：
 *  - 拷走整个目录就带走了已装版本，便携；
 *  - 同一台机器上多个 DSH-Sesame 互不干扰，各用各的版本池。
 *
 * 代价是**多个安装之间不共享版本**（同一份 `~/.dsh` 仍然共享插件与数据）。
 * 这是刻意的取舍：版本池可以重建，共享反而会让两个安装互相踩。
 */
/**
 * 应用本体所在目录（打包后 = exe 所在目录；开发时 = 仓库根）。
 *
 * 注意这是**程序本体**的目录 —— 安装包会清空它，所以数据不能放这里。
 */
export function appDir(): string {
  return app.isPackaged ? dirname(app.getPath('exe')) : resolve(__dirname, '../..')
}

/**
 * 数据根目录（版本池、快照、桌面端都放这里）。
 *
 * **必须放在安装目录外面** —— 这是踩出来的，代价是一条完整的更新链路：
 *
 *   NSIS 的升级流程（`app-builder-lib/templates/nsis/uninstaller.nsh:160-188`）在
 *   `isUpdated` 时会先 `atomicRMDir`：把 `$INSTDIR` 里**每一项逐个**改名搬到
 *   `%TEMP%\old-install`，然后 `RMDir /r $INSTDIR` 再装新版。
 *
 *   数据放在安装目录里时，这一步要把 `dsh/` + `desktop/` 一起搬走。实测那次
 *   `%TEMP%\old-install` 里留下了 274,529 个文件、10.05 GB（连 `chrome_*.pak` 这种
 *   应用本体文件都在），而 **D: 到 C: 是跨盘** —— 不是改名，是实打实复制。
 *   搬完之后安装器就没下文了：应用已关、窗口不再出现、进程挂着不动。
 *   那次升级因此彻底失败，10 GB 一直躺在 %TEMP% 里没被清理。
 *
 * 所以默认值是**安装目录的隔壁**（同盘 rename，瞬间完成；也不在任何安装器的清理范围里）。
 * 另外 `build/installer.nsh` 覆盖了删文件步骤，让升级不再搬空 `$INSTDIR`。
 *
 * 优先级：设置页的 `poolDir` > `SESAME_DATA_DIR` > 便携版自己那 > 安装目录隔壁。
 */
export function dataRoot(): string {
  // 设置页里指定的优先（用户可改到别的盘）
  const fromSettings = readSettings().poolDir
  if (typeof fromSettings === 'string' && fromSettings.trim() !== '') return fromSettings.trim()

  const fromEnv = process.env.SESAME_DATA_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()

  // 便携版：数据就在 exe 旁边，保持"拷走整个目录就带走一切"。
  // electron-builder 的 portable target 会把 app 解到临时目录再运行，并设这个变量指向
  // portable exe 自己所在的目录 —— 此时"应用旁边"必须是**那里**，否则解包目录一清就全没了。
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) return portableDir

  // 安装目录的**隔壁**，例如 D:\DSH-Sesame → D:\DSH-Sesame-data
  return join(dirname(appDir()), 'DSH-Sesame-data')
}

/** 数据根是否与安装目录重叠（重叠就意味着升级会被 NSIS 的改名步骤卡住 / 数据被删） */
export function dataRootInsideInstallDir(): boolean {
  const root = dataRoot()
  const install = appDir()
  return root === install || root.startsWith(install + sep)
}

/**
 * 一次性迁移：把旧位置（安装目录里）的 dsh 池、桌面端与 snapshots 搬到新的数据根目录。
 *
 * 只在"新位置还没有、旧位置存在"时搬，搬完返回一行说明（主进程写日志）。
 * 同盘用 rename（瞬间完成，1 GB 也是瞬间）；跨盘退回复制。
 * **失败不阻断启动** —— 新位置会是空的，但旧的仍在原地，数据没丢。
 *
 * `desktop` 必须一起搬：它是解压出来的官方桌面端（1 GB 量级），留在安装目录里
 * 既会被升级删掉，也是升级卡死的直接原因（文件正被运行中的桌面端占用）。
 */
export function migrateLegacyData(): string | null {
  const target = dataRoot()
  const legacyBase = appDir()
  if (target === legacyBase) return null

  const moved: string[] = []
  for (const name of ['dsh', 'desktop', 'snapshots']) {
    const from = join(legacyBase, name)
    const to = join(target, name)
    if (!existsSync(from) || existsSync(to)) continue
    try {
      mkdirSync(dirname(to), { recursive: true })
      try {
        renameSync(from, to)
      } catch {
        // 跨盘时 rename 会以 EXDEV 失败，退回递归复制再删原目录
        cpSync(from, to, { recursive: true })
        rmSync(from, { recursive: true, force: true })
      }
      moved.push(name)
    } catch (cause) {
      return `迁移 ${name} 失败：${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
  if (moved.length === 0) return null
  return `已把 ${moved.join('、')} 从 ${legacyBase} 迁到 ${target}`
}

/** dsh 版本池 */
export function versionRoot(): string {
  return join(dataRoot(), 'dsh')
}

/**
 * **插件母版**的 profile 名。
 *
 * 为什么必须是一个"profile 名"而不是任意目录：
 * `dsh plugin --profile <name>` 只接受名字，且**固定解析到 `$DSH_HOME/profiles/<name>`**
 * （`bin.js` 里 `--profile` 的说明原文：*the profile under $DSH_HOME/profiles to boot*）。
 * 把母版放在别处，dsh 的 CLI 就够不着它，"在母版里装插件"这件事根本无法实现。
 *
 * 所以母版永远是 `<DSH_HOME>/profiles/base`；用户想让它落在别的盘/别的目录时，
 * 用 **junction** 把 `base` 指过去（见 `pluginBase.ts` 的 `ensureBaseLink`）——
 * dsh 仍然按 `profiles/base` 访问，路径不变，内容在用户指定的位置。
 */
export const BASE_PROFILE = 'base'

/** 母版目录（`<DSH_HOME>/profiles/base`，可能是一个指向用户自定义位置的 junction） */
export function pluginBaseDir(): string {
  return join(dshHome(), 'profiles', BASE_PROFILE)
}

/**
 * 用户在设置里指定的母版**目标**目录；没设就是空串（= 直接用 `profiles/base`）。
 *
 * 非空且不在 `profiles/` 下时，`base` 会变成指向它的 junction。
 */
export function pluginBaseTarget(): string {
  const fromSettings = readSettings().pluginsDir
  return typeof fromSettings === 'string' ? fromSettings.trim() : ''
}

/** 某个版本的安装目录：`<版本根>/<版本号>` */
export function versionDir(version: string): string {
  return join(versionRoot(), version)
}

/**
 * 受管版本的入口脚本。
 *
 * 认 npm 包里的 `lib/bin.js`，它的存在即"这个版本装好了"。
 */
export function versionBin(version: string): string {
  return join(versionDir(version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}
