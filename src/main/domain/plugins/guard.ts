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
  /*
   * **先说话再干活。**
   *
   * 这一步要遍历三万个文件算指纹、必要时再打包 180 MB，实测几十秒。它排在
   * 装/卸/更新之前，而原先**一句日志都不打** —— 用户点了更新，终端停在
   * "安装插件 X"，界面按钮一直转，看起来就是卡死。实际是在打快照。
   */
  pushTagged('启动器', `正在自动快照（${reason}）…需要几十秒，请稍候`)
  try {
    const entry = await createSnapshot('auto', reason)
    if (entry.reused === true) {
      pushTagged('启动器', '快照内容与上一份相同，已跳过打包')
      return
    }
    /*
     * 报**整包的实际大小**，不是 `entry.bytes`。
     *
     * `entry.bytes` 只是那几个配置文件（package.json / cordis.patch.yml …）的总和，
     * 几 KB 而已，除以 1024² 永远是 0 —— 之前这里打印"完成（0 MB）"，
     * 看着像存了个空快照，实际压缩包有 185 MB。
     */
    const total = entry.modules?.bytes ?? entry.bytes
    pushTagged('启动器', `自动快照完成（${Math.round(total / 1024 / 1024)} MB）`)
  } catch (cause) {
    pushTagged(
      '启动器',
      '自动快照失败（不影响本次操作）：' + (cause instanceof Error ? cause.message : String(cause))
    )
  }
}
