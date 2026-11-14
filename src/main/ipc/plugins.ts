import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { MARKET_CHANNELS, PLUGIN_CHANNELS } from '@shared/constants/channels'
import type { PluginProgressEvent } from '@shared/types/events'
import { profileDir } from '../platform/dshHome'
import { BASE_PROFILE } from '../platform/paths'
import { pushTagged } from '../domain/terminal/logbus'
import {
  assessProfile,
  checkMarketUpdate,
  listSnapshots,
  loadCatalog,
  loadMarket,
  type MarketRegion
} from '../domain/plugins/market'
import { installPlugin, uninstallPlugin, updatePlugin } from '../domain/plugins/pluginInstall'
import { listPlugins, setPluginEnabled } from '../domain/plugins/pluginState'
import { withPluginWriteLock } from '../domain/plugins/serialize'
import { baseStatus, initBaseFromProfile, type BaseSource } from '../domain/control/pluginBase'
// "改 profile 前先自动存档"是一条业务规则，住在 domain 里（见那个文件的注释）
import { autoSnapshotBefore } from '../domain/plugins/guard'

/**
 * 插件页 + 内置市场库的 IPC。
 *
 * 插件开关默认作用于 `web` profile（`DSH_HOME` 可覆盖，dsh 自身也是这个规则）。
 */
export function registerPluginsIpc(): void {
  ipcMain.handle(PLUGIN_CHANNELS.list, () => listPlugins(profileDir(BASE_PROFILE)))

  /*
   * 插件母版：状态查询与初始化。
   *
   * 初始化是"一次性迁移"——把 web 或桌面端现有的插件复制进母版。之后装/升/卸/开关
   * 都只动母版，启动时克隆到各 profile（见 domain/control/pluginBase.ts）。
   * 用 `withPluginWriteLock` 排队，避免与正在跑的插件操作抢同一批文件。
   */
  ipcMain.handle(PLUGIN_CHANNELS.baseStatus, () => baseStatus())

  ipcMain.handle(PLUGIN_CHANNELS.initBase, async (_event: IpcMainInvokeEvent, source: BaseSource) => {
    if (source !== 'web' && source !== 'desktop') throw new Error(`未知的插件基线：${String(source)}`)
    pushTagged('启动器', `用 ${source} 的插件初始化母版`)
    return withPluginWriteLock(async () => {
      const status = await initBaseFromProfile(source, (text) => pushTagged('母版', text))
      pushTagged('启动器', `母版已就绪：${status.plugins} 个插件（来源 ${status.source}）`)
      return status
    })
  })

  // 开关直接返回写后的新清单：界面据此更新，省掉一次"改完再拉一遍"的往返，
  // 也避免两次调用之间被别的东西改动而看到中间态。
  ipcMain.handle(
    PLUGIN_CHANNELS.setEnabled,
    async (_event: IpcMainInvokeEvent, packageName: string, enabled: boolean) => {
      if (typeof packageName !== 'string' || packageName === '') throw new Error('缺少插件包名')
      if (typeof enabled !== 'boolean') throw new Error('缺少开关目标状态')
      /*
       * **开关插件不存快照。**
       *
       * 原来这里调 `autoSnapshotBefore`，理由是"改 profile 前留退路"。但开关改的只有
       * `cordis.patch.yml` 里的一行，而快照会把整个 `node_modules` 打成 tgz ——
       * 实测一份约 175 MB、tar 跑 20 秒。用户真实目录里两条相隔 58 秒的"开启/关闭"
       * 各占 180 MB（共 361 MB），换来的"还原点"不过是一次点击就能复原的状态。
       *
       * 更要紧的是 `SNAPSHOT_KEEP = 10`：开关十次就把升级前的有效还原点全挤掉，
       * 留存策略被廉价操作占满。所以这里只留一行终端日志做审计，不打快照。
       *
       * 安装 / 升级 / 卸载**仍然**存快照 —— 那三个真会动 `node_modules`，不可一键复原。
       */
      pushTagged('启动器', `${enabled ? '开启' : '关闭'}插件 ${packageName}`)
      const dir = profileDir(BASE_PROFILE)

      /*
       * **不在这里写桌面端。** 只改 web —— 桌面端的那份由 `syncWebToDesktop` 在**启动前对齐**
       * （见 ../domain/control/sync.ts 的 `alignDisabledFlags`）。
       *
       * 为什么不做实时双写：补丁层里【启用】是"加一行"、而【禁用】要**删掉一条**，而启动时的合并天生只会
       * "补缺"、不会删 —— 所以曾经靠这里实时补一刀来兜。现在对齐逻辑补上了那个删除，实时
       * 同步就只需要**一个入口点**（启动前），语义也更干净：web 是唯一基准，桌面端照着对齐。
       *
       * 代价（已知并接受）：桌面端**正在跑**时切开关，要下次启动桌面端才生效。
       *
       * `withPluginWriteLock`：`setPluginEnabled` 是"读 yml → 改 → 写回"，
       * 两个开关同时进来会丢更新（后写的用旧文本覆盖）。排进串行队列即可，**不再丢弃**点击。
       */
      return withPluginWriteLock(() => {
        setPluginEnabled(dir, packageName, enabled)
        return listPlugins(dir)
      })
    }
  )

  // --- 插件安装 / 卸载（走 dsh 自己的 plugin 命令 → pnpm）---

  /**
   * 进度推回发起操作的那个窗口，不广播（多窗口时另一个窗口不该看到别人的安装）。
   *
   * **同时写进终端页的日志缓冲**：pnpm 的每一行输出都是排查依据（依赖冲突、构建脚本失败、
   * 发布年龄被挡…）。之前这些行只出现在插件页那一小块进度文案里，装完就没了 ——
   * 终端页只剩"安装插件 X / X 安装完成"两行，等于什么都没留下。
   */
  const pluginProgress = (event: IpcMainInvokeEvent, packageName: string) => {
    return (progress: { phase: PluginProgressEvent['phase']; text: string }): void => {
      pushTagged(`pnpm ${packageName}`, progress.text)
      const payload: PluginProgressEvent = { packageName, ...progress }
      if (!event.sender.isDestroyed()) event.sender.send(PLUGIN_CHANNELS.progress, payload)
    }
  }

  /**
   * 排进串行队列，并把失败原因也写进终端页。
   *
   * 失败以前只 reject 给界面弹一句，终端页不留痕 —— 而真正需要事后翻看的恰恰是失败。
   */
  const runLogged = async (label: string, job: () => Promise<void>): Promise<void> => {
    try {
      await withPluginWriteLock(job)
    } catch (cause) {
      pushTagged('启动器', `${label}失败：` + (cause instanceof Error ? cause.message : String(cause)))
      throw cause
    }
  }

  ipcMain.handle(PLUGIN_CHANNELS.install, async (event: IpcMainInvokeEvent, packageName: string) => {
    if (typeof packageName !== 'string' || packageName === '') throw new Error('缺少插件包名')
    pushTagged('启动器', `安装插件 ${packageName}`)
    // 装 / 卸 / 更都动 `package.json` 与 `node_modules`，必须排进同一个串行队列
    await runLogged(`安装 ${packageName} `, async () => {
      await autoSnapshotBefore('安装插件 ' + packageName)
      await installPlugin(packageName, pluginProgress(event, packageName))
    })
    pushTagged('启动器', `${packageName} 安装完成`)
  })

  ipcMain.handle(PLUGIN_CHANNELS.uninstall, async (event: IpcMainInvokeEvent, packageName: string) => {
    if (typeof packageName !== 'string' || packageName === '') throw new Error('缺少插件包名')
    pushTagged('启动器', `卸载插件 ${packageName}`)
    await runLogged(`卸载 ${packageName} `, async () => {
      await autoSnapshotBefore('卸载插件 ' + packageName)
      await uninstallPlugin(packageName, pluginProgress(event, packageName))
    })
    pushTagged('启动器', `${packageName} 已卸载`)
  })

  // 更新：走 `add <包>@<版本>`。目标版本由界面给（通常来自市场目录的 version），
  // 主进程只做校验与核对，不自己去猜"最新版是多少" —— 那样会多一次网络往返，
  // 而且可能与界面上显示的目标版本不一致。
  ipcMain.handle(
    PLUGIN_CHANNELS.update,
    async (event: IpcMainInvokeEvent, packageName: string, target: string) => {
      if (typeof packageName !== 'string' || packageName === '') throw new Error('缺少插件包名')
      if (typeof target !== 'string' || target === '') throw new Error('缺少目标版本')
      pushTagged('启动器', `更新插件 ${packageName} → ${target}`)
      await runLogged(`更新 ${packageName} `, async () => {
        await autoSnapshotBefore('升级插件 ' + packageName)
        await updatePlugin(packageName, target, pluginProgress(event, packageName))
      })
      pushTagged('启动器', `${packageName} 已更新到 ${target}`)
    }
  )

  // --- 内置市场库 ---

  ipcMain.handle(MARKET_CHANNELS.capabilities, () => loadMarket().capabilities)

  ipcMain.handle(MARKET_CHANNELS.catalog, (_event: IpcMainInvokeEvent, region: MarketRegion) =>
    loadCatalog(region === 'global' ? 'global' : 'china')
  )

  /** 「更新自己」：内置版本 vs 市场判定的目标版本，以及 profile 里那份装了哪个版本 */
  ipcMain.handle(MARKET_CHANNELS.selfVersion, async () => {
    const handle = loadMarket()
    const check = handle.capabilities.available
      ? await checkMarketUpdate('dshmarket')
      : { target: null, registryLatest: null, errors: ['市场库不可用'] }
    return {
      bundled: handle.capabilities.version,
      /** 市场判定的更新目标（受它的发布冷却策略约束，可能为 null） */
      target: check.target,
      /** 注册表实际的最新版，仅用于解释"为什么市场说没有更新" */
      registryLatest: check.registryLatest,
      errors: check.errors,
      // 顺带把兼容性与快照能力也报上来，界面据此决定显示哪些入口
      compatibility: handle.capabilities.available ? safe(() => assessProfile(profileDirName())) : null,
      snapshots: handle.capabilities.available ? safe(() => listSnapshots(profileDir(BASE_PROFILE))) : null
    }
  })
}

/**
 * 取 profile 名（固定 web）；单独抽出来是因为市场模块的入参是"名字"而不是目录。
 *
 * **不读 `DSH_PROFILE`。** 那个变量是启动器**写给孩子进程**的（告诉 dsh 用哪个 profile），
 * 反过来决定启动器自己的行为就是方向错了 —— 用户机器上一个残留值会悄悄改变
 * "插件开关作用在哪个 profile 上"。启动器的基准 profile 是常量，不受环境变量影响。
 * （可写：envFor 仍然会把当前 profile 传给 dsh；只是启动器自己不再回头读它。）
 */
function profileDirName(): string {
  return BASE_PROFILE
}

/** 探测用：内部 API 缺失时不要让它把 IPC 调用变成异常 */
function safe<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch {
    return null
  }
}
