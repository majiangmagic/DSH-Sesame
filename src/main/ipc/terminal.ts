import { ipcMain } from 'electron'
import { LOG_CHANNELS } from '@shared/constants/channels'
import { clearLog, logSnapshot } from '../domain/terminal/logbus'

/**
 * 终端页的 IPC。
 *
 * 数据源是 `infra/logbus` 的环形缓冲：dsh 子进程的输出由 `domain/control/runner` 推进去，
 * 操作事件由各领域的 ipc 推进去。这里只负责"取快照 / 清空"两件事 ——
 * 缓冲本身在 infra，因为往它里面推日志的领域不止一个。
 *
 * 通道名仍是 `log:get` / `log:clear` / `log:line`（`LOG_CHANNELS`）——
 * 通道名是**线上协议**，不随目录改名而变。目录叫 `terminal` 是因为
 * 标签页上写的是「终端」，而 `log` 对不上它。
 */
export function registerTerminalIpc(): void {
  ipcMain.handle(LOG_CHANNELS.get, () => logSnapshot())
  ipcMain.handle(LOG_CHANNELS.clear, () => {
    clearLog()
  })
}
