import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { DESKTOP_CHANNELS, DIAGNOSE_CHANNELS, VERSION_CHANNELS } from '@shared/constants/channels'
import type { DesktopProgressEvent } from '@shared/types/events'
import { pushTagged } from '../domain/terminal/logbus'
import { readSettings } from '../infrastructure/settings'
import { diagnose, diagnoseDesktop } from '../domain/control/diagnose'
import { startVersion, stopVersion } from '../domain/control/runner'

/**
 * 控制页的 IPC —— 启动 / 停止 + 启动诊断。
 *
 * 两件事同属一个领域：它们都在回答"这个版本能不能跑起来"。
 * 诊断原先单列一个 `domain/control/`，但它没有自己的界面 ——
 * 入口就是控制页上的「检查」按钮，所以并进这里。
 *
 * 通道名 `versions:start` / `versions:stop` / `diagnose:run` 都在
 * `@shared/constants/channels` 定义一次 —— 通道名是**线上协议**，
 * 不随主进程的目录划分变化。overview / install / uninstall 属于版本管理，
 * 在 `./versions.ts`。
 */
export function registerControlIpc(): void {
  // 启动要等到 dsh 打印就绪地址才返回 —— 界面因此不会出现"点了没反应"的中间态。
  // 首次启动可能要现场装依赖，会比较慢，这是 dsh 侧的真实耗时，不做假的进度条。
  // 桌面端走的是「下载 → 安装 → 启动」，进度单独通过 DESKTOP_CHANNELS.progress 推回发起窗口。
  ipcMain.handle(VERSION_CHANNELS.start, async (event: IpcMainInvokeEvent, version: string) => {
    if (typeof version !== 'string' || version === '') throw new Error('缺少版本号')
    pushTagged('启动器', `启动 ${version}`)
    const state = await startVersion(version, (progress) => {
      const payload: DesktopProgressEvent = { version, ...progress }
      if (!event.sender.isDestroyed()) event.sender.send(DESKTOP_CHANNELS.progress, payload)
    })
    pushTagged('启动器', state.url ? `${version} 就绪：${state.url}` : `${version} 已启动`)
    return state
  })

  ipcMain.handle(VERSION_CHANNELS.stop, async () => {
    pushTagged('启动器', '停止当前版本')
    await stopVersion()
    pushTagged('启动器', '已停止')
  })

  /**
   * 启动诊断：限时启动一次，解析 dsh 自己的失败诊断。
   *
   * 桌面端模式下**不能**走 "spawn dsh" 那条路 —— CLI 明确拒绝 desktop profile
   * （`managed exclusively by the Electron application`），硬跑只会得到一句
   * 假的"启动失败"。改成用桌面端自带 CLI 做只读诊断（解析它跳过哪些 bundle）。
   *
   * 端口用设置里的那个（复现真实情况）。**它会真的起 dsh**，用完即停。
   */
  ipcMain.handle(DIAGNOSE_CHANNELS.run, (_event, version: string) =>
    readSettings().profile === 'desktop'
      ? diagnoseDesktop(version)
      : diagnose(version, readSettings().port)
  )
}
