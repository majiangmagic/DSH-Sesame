import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import { readSettings } from './settings'

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
 * 数据根目录（版本池、快照都放这里）。
 *
 * **刻意放在软件目录下**，而不是应用目录里面：
 * 覆盖安装/卸载时 NSIS 会把安装目录整个删掉 —— 本会话实测过，
 * 用户的 1.1 GB 版本池就是这么没的 —— 所以安装脚本里补了保护（见 build/installer.nsh）。
 *
 * 优先级：`SESAME_DATA_DIR` 环境变量 > 便携版自己那 > 软件目录下。
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

  return appDir()
}

/**
 * 一次性迁移：把旧位置（应用目录里）的 dsh 池与 snapshots 搬到新的数据根目录。
 *
 * 只在"新位置还没有、旧位置存在"时搬，搬完返回一行说明（主进程写日志）。
 * 同盘用 rename（瞬间完成，1 GB 也是瞬间）；跨盘退回复制。
 * **失败不阻断启动** —— 新位置会是空的，但旧的仍在原地，数据没丢。
 */
export function migrateLegacyData(): string | null {
  const target = dataRoot()
  const legacyBase = appDir()
  if (target === legacyBase) return null

  const moved: string[] = []
  for (const name of ['dsh', 'snapshots']) {
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
