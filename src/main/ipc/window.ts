import { dialog, ipcMain, shell } from 'electron'
import { WINDOW_CHANNELS } from '@shared/constants/channels'
import { currentWindow, isSafeExternal } from '../infrastructure/window'

/**
 * 窗口壳的 IPC：最小化 / 最大化 / 关闭 / 取最大化状态 / 选目录 / 开外链。
 *
 * 这是 `main/ipc/` 里**唯一不对应标签页**的文件 —— 它服务的是窗口本身，
 * 不是某个业务领域。放在这里而不是 `infrastructure/window.ts`，是为了守住那条分工：
 *   `infrastructure/` 管窗口怎么建、怎么显示；`ipc/` 管它怎么被渲染层调用。
 *
 * 窗口实例从 `currentWindow()` 取（单例，状态在 infrastructure 那边），
 * 所以这里不需要再串一个 `getWindow` 参数。
 */
export function registerWindowIpc(): void {
  ipcMain.on(WINDOW_CHANNELS.minimize, () => currentWindow()?.minimize())

  ipcMain.on(WINDOW_CHANNELS.toggleMaximize, () => {
    const win = currentWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on(WINDOW_CHANNELS.close, () => currentWindow()?.close())

  ipcMain.handle(WINDOW_CHANNELS.isMaximized, () => currentWindow()?.isMaximized() ?? false)

  /**
   * 选目录。给「数据目录」这类需要在磁盘上指位置的设置用。
   *
   * 为什么必须走主进程：渲染层没有 Node，拿不到原生文件选择器。
   * 取消时返回 null（调用方据此保持原值，不要清空）。
   */
  ipcMain.handle(WINDOW_CHANNELS.pickDirectory, async () => {
    const win = currentWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  /**
   * 开外链。**只放 http/https 过去** —— 别的协议（`file:` / `javascript:`）
   * 一律拒掉，避免被渲染层带进来一个能执行本地文件的 URL。
   */
  ipcMain.handle(WINDOW_CHANNELS.openExternal, async (_event, url: unknown) => {
    const target = String(url ?? '')
    if (!isSafeExternal(target)) throw new Error(`拒绝打开非 http(s) 地址：${target}`)
    await shell.openExternal(target)
  })
}
