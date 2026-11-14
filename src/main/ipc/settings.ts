import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { SETTINGS_CHANNELS, UPDATE_CHANNELS } from '@shared/constants/channels'
import { applySettingsPatch } from '../domain/settings/apply'
import { checkLauncherUpdate, installLauncherUpdate } from '../domain/settings/update'
import { snapshotRoot } from '../domain/snapshots/snapshot'
import { dshHome } from '../platform/dshHome'
import { pluginBaseDir, versionRoot } from '../platform/paths'
import { readSettings } from '../platform/settings'

/**
 * 设置页的 IPC。**很薄** —— 只做参数接收与转发：
 *
 *   读 → `platform/settings.ts`（JSON 文件读写，纯机制）
 *   写 → `domain/settings/apply.ts`（校验 + 落盘编排，策略）
 *   更新启动器自己 → `domain/settings/update.ts`（检查 + 下载 + 静默安装）
 *
 * 为什么这样分：设置被 `platform/paths.ts` 与 `platform/dshHome.ts`
 * 读（版本池位置、DSH_HOME），所以**原始读写必须留在 platform** ——
 * 搬进 domain 会让文件系统层反向依赖业务层。于是 domain 侧只收"该怎么处理这个载荷"。
 *
 * 为什么"更新启动器自己"也在这个文件：它的入口是设置页上的按钮，
 * 按本项目"domain 目录名 = 标签页"的规则，它属于设置这个领域。
 * 注意它与 `VERSION_CHANNELS`（dsh 的版本池，可并存可切换）是**两件不同的事**。
 */
export function registerSettingsIpc(): void {
  ipcMain.handle(SETTINGS_CHANNELS.get, () => readSettings())

  /**
   * 各项目录解析后的**真实路径**。
   *
   * 设置里留空 = 用默认，而默认随安装位置/数据根变化。界面拿这个显示"实际在哪"，
   * 不再靠占位符里那句模糊的"默认<软件目录>/xxx" —— 那句话和实际位置已经对不上了。
   */
  ipcMain.handle(SETTINGS_CHANNELS.paths, () => ({
    dshHome: dshHome(),
    poolDir: versionRoot(),
    snapshotDir: snapshotRoot(),
    pluginsDir: pluginBaseDir()
  }))

  ipcMain.handle(SETTINGS_CHANNELS.save, (_event: IpcMainInvokeEvent, patch: unknown) =>
    applySettingsPatch(patch)
  )

  // --- 启动器自己的更新 ---

  /** 只查不装。**不抛异常**（设置页打开时就会调它，一次网络失败不该让它报错）。 */
  ipcMain.handle(UPDATE_CHANNELS.check, () => checkLauncherUpdate())

  /**
   * 下载 → 校验 → 静默安装 → 退出（安装器负责重启）。
   *
   * 进度推回**发起操作的那个窗口**，不广播 —— 与插件安装同一套约定。
   * 失败会 reject（消息里带原因），界面据此提示。
   */
  ipcMain.handle(UPDATE_CHANNELS.install, async (event: IpcMainInvokeEvent) => {
    await installLauncherUpdate((progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(UPDATE_CHANNELS.progress, progress)
    })
  })
}
