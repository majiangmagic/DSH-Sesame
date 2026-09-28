import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  DIAGNOSE_CHANNELS,
  LOG_CHANNELS,
  SNAPSHOT_CHANNELS,
  MARKET_CHANNELS,
  PLUGIN_CHANNELS,
  SETTINGS_CHANNELS,
  VERSION_CHANNELS,
  type LauncherSettingsPayload,
  type PluginProgressEvent,
  type VersionProgressEvent
} from '@shared/ipc'
import { installVersion, uninstallVersion } from './installer'
import { installPlugin, uninstallPlugin, updatePlugin } from './pluginInstall'
import { startVersion, stopVersion } from './runner'
import { listPlugins, setPluginEnabled } from './patch'
import { profileDir } from './dshHome'
import { assessProfile, checkMarketUpdate, loadCatalog, loadMarket, listSnapshots, type MarketRegion } from './market'
import { overview } from './versions'
import { clearLog, logSnapshot, pushTagged } from './logbus'
import { readSettings, writeSettings } from './settings'
import { diagnose } from './diagnose'
/*
 * 注意别名：本文件第 17 行已经从 ./market 引入了同名的 listSnapshots（那是市场的快照列表，
 * 和插件配置快照是两回事）。不加别名会 TS2300 重名报错。
 */
import {
  createSnapshot,
  deleteSnapshot,
  listSnapshots as listPluginSnapshots,
  restoreSnapshot,
  snapshotPaths,
  snapshotPreview
} from './snapshot'

/**
 * 业务 IPC 注册。
 *
 * 安装进度用 `event.sender.send` 推回**发起安装的那个窗口**，而不是广播 ——
 * 多窗口时另一个窗口不该看到一个它没发起的下载。
 *
 * 插件开关默认作用于 `web` profile（`DSH_HOME` 可覆盖，dsh 自身也是这个规则）。
 */
/**
 * 插件变更前的自动存档。
 *
 * 这是快照功能里"自动触发"的落点：任何会改 profile 配置的动作（关闭插件、
 * 安装、升级、卸载）之前先存一份，于是那个动作本身也变成可逆的。
 *
 * **失败不阻断主流程**：存不上（磁盘满、权限）不该让"关闭插件"这个动作做不了，
 * 所以这里吞掉异常 —— 但会写一行日志，免得悄悄失效。
 */
async function autoSnapshotBefore(reason: string): Promise<void> {
  try {
    await createSnapshot('auto', reason)
  } catch (cause) {
    pushTagged('启动器', '自动快照失败（不影响本次操作）：' + (cause instanceof Error ? cause.message : String(cause)))
  }
}

export function registerBusinessIpc(): void {
  /**
   * 启动诊断：限时启动一次，解析 dsh 自己的失败诊断。
   *
   * 端口用设置里的那个（复现真实情况）。**它会真的起 dsh**，用完即停 ——
   * 要抓"搞坏启动"的插件，harness 连插件一起启动是唯一办法。
   */
  ipcMain.handle(DIAGNOSE_CHANNELS.run, (_event: IpcMainInvokeEvent, version: string) =>
    diagnose(version, readSettings().port)
  )

  /* 插件配置快照：手动/自动存、列、回退（回退前自动先存一份当前状态） */
  ipcMain.handle(SNAPSHOT_CHANNELS.list, () => listPluginSnapshots())
  ipcMain.handle(SNAPSHOT_CHANNELS.paths, () => snapshotPaths())
  ipcMain.handle(SNAPSHOT_CHANNELS.create, (_event: IpcMainInvokeEvent, label: string) =>
    createSnapshot('manual', typeof label === 'string' ? label : '')
  )
  ipcMain.handle(SNAPSHOT_CHANNELS.restore, (_event: IpcMainInvokeEvent, id: string) =>
    restoreSnapshot(id)
  )
  ipcMain.handle(SNAPSHOT_CHANNELS.remove, (_event: IpcMainInvokeEvent, id: string) =>
    deleteSnapshot(id)
  )
  // 存之前的预演：弹窗里那两份列表（npm / 非 npm）
  ipcMain.handle(SNAPSHOT_CHANNELS.plan, () => snapshotPreview())

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

  // 启动要等到 dsh 打印就绪地址才返回 —— 界面因此不会出现"点了没反应"的中间态。
  // 首次启动可能要现场装依赖，会比较慢，这是 dsh 侧的真实耗时，不做假的进度条。
  ipcMain.handle(VERSION_CHANNELS.start, async (_event: IpcMainInvokeEvent, version: string) => {
    if (typeof version !== 'string' || version === '') throw new Error('缺少版本号')
    pushTagged('启动器', `启动 ${version}`)
    const state = await startVersion(version)
    pushTagged('启动器', `${version} 就绪：${state.url ?? '(无地址)'}`)
    return state
  })

  ipcMain.handle(VERSION_CHANNELS.stop, async () => {
    pushTagged('启动器', '停止当前版本')
    await stopVersion()
    pushTagged('启动器', '已停止')
  })

  ipcMain.handle(PLUGIN_CHANNELS.list, () => listPlugins(profileDir()))

  // 开关直接返回写后的新清单：界面据此更新，省掉一次"改完再拉一遍"的往返，
  // 也避免两次调用之间被别的东西改动而看到中间态。
  ipcMain.handle(
    PLUGIN_CHANNELS.setEnabled,
    async (_event: IpcMainInvokeEvent, packageName: string, enabled: boolean) => {
      await autoSnapshotBefore((enabled ? '开启' : '关闭') + '插件 ' + packageName)
      if (typeof packageName !== 'string' || packageName === '') throw new Error('缺少插件包名')
      if (typeof enabled !== 'boolean') throw new Error('缺少开关目标状态')
      const dir = profileDir()
      setPluginEnabled(dir, packageName, enabled)
      return listPlugins(dir)
    }
  )

  // --- 插件安装 / 卸载（走 dsh 自己的 plugin 命令 → pnpm）---

  /** 进度推回发起操作的那个窗口，不广播（多窗口时别的窗口不该看到它没发起的安装） */
  const pluginProgress = (event: IpcMainInvokeEvent, packageName: string) => {
    return (progress: { phase: PluginProgressEvent['phase']; text: string }): void => {
      const payload: PluginProgressEvent = { packageName, ...progress }
      if (!event.sender.isDestroyed()) event.sender.send(PLUGIN_CHANNELS.progress, payload)
    }
  }

  ipcMain.handle(PLUGIN_CHANNELS.install, async (event: IpcMainInvokeEvent, packageName: string) => {
    if (typeof packageName !== 'string' || packageName === '') throw new Error('缺少插件包名')
    pushTagged('启动器', `安装插件 ${packageName}`)
    await autoSnapshotBefore('安装插件 ' + packageName)
    await installPlugin(packageName, pluginProgress(event, packageName))
    pushTagged('启动器', `${packageName} 安装完成`)
  })

  ipcMain.handle(PLUGIN_CHANNELS.uninstall, async (event: IpcMainInvokeEvent, packageName: string) => {
    if (typeof packageName !== 'string' || packageName === '') throw new Error('缺少插件包名')
    pushTagged('启动器', `卸载插件 ${packageName}`)
    await autoSnapshotBefore('卸载插件 ' + packageName)
    await uninstallPlugin(packageName, pluginProgress(event, packageName))
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
      await autoSnapshotBefore('升级插件 ' + packageName)
      await updatePlugin(packageName, target, pluginProgress(event, packageName))
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
      /** 注册表实际最新版，仅用于解释"为什么市场说没有更新" */
      registryLatest: check.registryLatest,
      errors: check.errors,
      // 顺带把兼容性与快照能力也报上来，界面据此决定显示哪些入口
      compatibility: handle.capabilities.available ? safe(() => assessProfile(profileDirName())) : null,
      snapshots: handle.capabilities.available ? safe(() => listSnapshots(profileDir())) : null
    }
  })

  // --- 终端页 ---
  // 数据源是 logbus 的环形缓冲：dsh 子进程的输出由 runner 推进去，操作事件在这里推。
  ipcMain.handle(LOG_CHANNELS.get, () => logSnapshot())
  ipcMain.handle(LOG_CHANNELS.clear, () => {
    clearLog()
  })

  // --- 启动器设置（<userData>/settings.json，不是 dsh profile 的配置）---

  ipcMain.handle(SETTINGS_CHANNELS.get, () => readSettings())

  /**
   * 合并写入。**逐个字段校验后再收**：这个载荷来自渲染层，不能整包 trust 地写进磁盘。
   * 开机自启的落盘（注册表）由 settings.ts 负责，且只在打包后执行。
   */
  ipcMain.handle(
    SETTINGS_CHANNELS.save,
    (_event: IpcMainInvokeEvent, patch: Partial<LauncherSettingsPayload>) => {
      if (patch === null || typeof patch !== 'object') throw new Error('设置载荷不合法')
      const next = writeSettings({
        ...(typeof patch.autoStart === 'boolean' ? { autoStart: patch.autoStart } : {}),
        ...(patch.lang === 'en' || patch.lang === 'zh' ? { lang: patch.lang } : {}),
        ...(typeof patch.args === 'string' ? { args: patch.args } : {}),
        ...(typeof patch.profile === 'string' && patch.profile !== '' ? { profile: patch.profile } : {}),
      ...(typeof patch.dshHome === 'string' ? { dshHome: patch.dshHome.trim() } : {}),
      ...(typeof patch.snapshotDir === 'string' ? { snapshotDir: patch.snapshotDir.trim() } : {}),
      ...(typeof patch.poolDir === 'string' ? { poolDir: patch.poolDir.trim() } : {}),
      ...(typeof patch.port === 'number' &&
      Number.isInteger(patch.port) &&
      patch.port >= 1024 &&
      patch.port <= 65535
        ? { port: patch.port }
        : {})
      })
      pushTagged('启动器', `设置已保存（profile=${next.profile}${next.args ? ` · 参数 ${next.args}` : ''}）`)
      return next
    }
  )
}

/** 取 profile 名（默认 web）；单独抽出来是因为市场模块的入参是"名字"而不是目录 */
function profileDirName(): string {
  return process.env.DSH_PROFILE?.trim() || 'web'
}

/** 探测用：内部 API 缺失时不要让它把 IPC 调用变成异常 */
function safe<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch {
    return null
  }
}
