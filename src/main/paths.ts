import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'

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
export function versionRoot(): string {
  // electron-builder 的 portable target 会把 app 解到临时目录再运行，并设这个变量指向
  // portable exe 自己所在的目录。此时"应用旁边"必须是**那里**，否则解包目录一清就全没了。
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) return join(portableDir, 'dsh')

  // 打包后：exe 所在目录。开发时 __dirname 是 <repo>/out/main，回退两级到仓库根。
  const base = app.isPackaged ? dirname(app.getPath('exe')) : resolve(__dirname, '../..')
  return join(base, 'dsh')
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
