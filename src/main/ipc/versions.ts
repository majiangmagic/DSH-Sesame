import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { VERSION_CHANNELS } from '@shared/constants/channels'
import type { VersionProgressEvent } from '@shared/types/events'
import { installVersion, uninstallVersion } from '../domain/versions/installer'
import { overview } from '../domain/versions/versions'

/**
 * 版本管理（版本页）的 IPC：总览 / 下载安装 / 卸载。
 *
 * 启动与停止在 `./control.ts` —— 它们管的是"进程"，不是"磁盘上装了哪些版本"。
 *
 * 安装进度用 `event.sender.send` 推回**发起安装的那个窗口**，而不是广播 ——
 * 多窗口时另一个窗口不该看到一个它没发起的下载。
 */
export function registerVersionsIpc(): void {
  ipcMain.handle(VERSION_CHANNELS.overview, () => overview())

  ipcMain.handle(VERSION_CHANNELS.install, async (event: IpcMainInvokeEvent, version: string) => {
    if (typeof version !== 'string' || version === '') throw new Error('缺少版本号')
    await installVersion(version, (progress) => {
      const payload: VersionProgressEvent = { version, ...progress }
      if (!event.sender.isDestroyed()) event.sender.send(VERSION_CHANNELS.progress, payload)
    })
  })

  ipcMain.handle(VERSION_CHANNELS.uninstall, async (_event: IpcMainInvokeEvent, version: string) => {
    if (typeof version !== 'string' || version === '') throw new Error('缺少版本号')
    await uninstallVersion(version)
  })
}
