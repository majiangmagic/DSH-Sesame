import { createSnapshot } from '../snapshots/snapshot'
import { pushTagged } from '../terminal/logbus'

/**
 * 插件变更前的自动存档。
 *
 * 这是快照功能里"自动触发"的落点：任何会改 profile 配置的动作（开关插件、
 * 安装、升级、卸载）之前先存一份，于是那个动作本身也变成可逆的。
 *
 * **为什么在 domain 而不是 ipc 层**：它是一条**业务规则**（"改配置前必须留退路"），
 * 不是通信适配。放在 ipc 里，只有走 Electron IPC 的那条路会受保护；
 * 将来 `main/api/` 让外部程序也能装插件时，那条路会绕过它。
 * 放在这里，任何调用方想改 profile 都得先经过这个函数。
 *
 * **失败不阻断主流程**：存不上（磁盘满、权限）不该让"关闭插件"这个动作做不了，
 * 所以这里吞掉异常 —— 但会写一行日志，免得悄悄失效。
 *
 * 这也是 `domain/plugins` 对 `domain/snapshots` 的**唯一一条跨领域依赖**，刻意保留：
 * 搬到 infra 反而会把这个策略的意图藏起来。
 */
export async function autoSnapshotBefore(reason: string): Promise<void> {
  try {
    await createSnapshot('auto', reason)
  } catch (cause) {
    pushTagged(
      '启动器',
      '自动快照失败（不影响本次操作）：' + (cause instanceof Error ? cause.message : String(cause))
    )
  }
}
