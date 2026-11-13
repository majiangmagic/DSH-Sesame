import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { VERSION_CHANNELS } from '@shared/constants/channels'
import type { VersionProgressEvent } from '@shared/types/events'
import { pushTagged } from '../domain/terminal/logbus'
import { installVersion, uninstallVersion } from '../domain/versions/installer'
import { overview } from '../domain/versions/versions'

/**
 * 版本管理（版本页）的 IPC：总览 / 下载安装 / 卸载。
 *
 * 启动与停止在 `./control.ts` —— 它们管的是"进程"，不是"磁盘上装了哪些版本"。
 *
 * 安装进度用 `event.sender.send` 推回**发起安装的那个窗口**，而不是广播 ——
 * 多窗口时另一个窗口不该看到一个它没发起的下载。
 *
 * **同时把 npm 的原始输出写进终端页**：以前这里只推给界面一块进度文案，
 * 装完就没了，终端页只剩"已完成"三个字。装版本失败时（404、peer 冲突、镜像超时）
 * 真正有用的是 npm 原始行，所以它们必须留痕。
 */
export function registerVersionsIpc(): void {
  ipcMain.handle(VERSION_CHANNELS.overview, () => overview())

  ipcMain.handle(VERSION_CHANNELS.install, async (event: IpcMainInvokeEvent, version: string) => {
    if (typeof version !== 'string' || version === '') throw new Error('缺少版本号')
    pushTagged('启动器', `安装 dsh ${version}`)
    try {
      await installVersion(
        version,
        (progress) => {
          const payload: VersionProgressEvent = { version, ...progress }
          if (!event.sender.isDestroyed()) event.sender.send(VERSION_CHANNELS.progress, payload)
        },
        (line) => pushTagged(`npm ${version}`, line)
      )
      pushTagged('启动器', `dsh ${version} 安装完成`)
    } catch (cause) {
      pushTagged('启动器', `安装 dsh ${version} 失败：` + (cause instanceof Error ? cause.message : String(cause)))
      throw cause
    }
  })

  ipcMain.handle(VERSION_CHANNELS.uninstall, async (_event: IpcMainInvokeEvent, version: string) => {
    if (typeof version !== 'string' || version === '') throw new Error('缺少版本号')
    pushTagged('启动器', `卸载 dsh ${version}`)
    try {
      await uninstallVersion(version)
      pushTagged('启动器', `dsh ${version} 已卸载`)
    } catch (cause) {
      pushTagged('启动器', `卸载 dsh ${version} 失败：` + (cause instanceof Error ? cause.message : String(cause)))
      throw cause
    }
  })
}
