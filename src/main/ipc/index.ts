import { registerControlIpc } from './control'
import { registerPluginsIpc } from './plugins'
import { registerSettingsIpc } from './settings'
import { registerSnapshotsIpc } from './snapshots'
import { registerTerminalIpc } from './terminal'
import { registerVersionsIpc } from './versions'
import { registerWindowIpc } from './window'

/**
 * IPC 注册总入口。**主进程里唯一知道全部通道的地方。**
 *
 * 为什么把各领域的 ipc 集中到 `main/ipc/`（而不是像之前那样散在 `domain/<页>/ipc.ts`）：
 *
 *   1. **`domain/` 只留业务。** 一个领域目录里混着"业务逻辑"和"通信适配"两种东西时，
 *      "这个文件属于哪一层"就变得含糊。现在分工是死的：
 *        `domain/`  → 做什么（策略、状态、算法）
 *        `ipc/`     → 怎么被调用（参数校验、进度转发、错误包装）
 *        `infrastructure/` → 靠什么做（文件、进程、网络、Electron）
 *   2. **协议面一眼可见。** 全部通道注册集中在这里，想知道"这个应用对外暴露了什么"
 *      不用翻 6 个目录。
 *
 * 通道名仍然是**一处定义**：`@shared/constants/channels`。它是线上协议，
 * 不随任何一侧的目录划分变化。
 *
 * `window` 那条（最小化/最大化/关闭/选目录/开外链）不服务任何业务领域，
 * 所以它是这个目录里唯一不对应标签页的文件 —— 它是"窗口壳"的适配。
 */
export function registerAllIpc(): void {
  // 6 个标签页，顺序与界面上的 tab 一致
  registerControlIpc()
  registerVersionsIpc()
  registerPluginsIpc()
  registerTerminalIpc()
  registerSnapshotsIpc()
  registerSettingsIpc()

  // 窗口壳（不服务任何业务领域）
  registerWindowIpc()
}
