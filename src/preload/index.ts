import { contextBridge, ipcRenderer } from 'electron'
import type { DiagnosisResult } from '@shared/diagnose'
import type { RestoreResult, SnapshotEntry, SnapshotPaths, SnapshotPreview } from '@shared/snapshot'
import {
  LOG_CHANNELS,
  MARKET_CHANNELS,
  PLUGIN_CHANNELS,
  SETTINGS_CHANNELS,
  VERSION_CHANNELS,
  DIAGNOSE_CHANNELS,
  SNAPSHOT_CHANNELS,
  WINDOW_CHANNELS,
  type LauncherSettingsPayload,
  type PluginProgressEvent,
  type VersionProgressEvent
} from '@shared/ipc'
import type { MarketCapabilities, MarketCatalog, MarketSelfUpdate } from '@shared/market'
import type { PluginList } from '@shared/plugins'
import type { InstalledVersion, VersionOverview } from '@shared/versions'

/** 启动返回的运行态（与 shared 里的 InstalledVersion 同源，只取运行相关字段） */
type RunningStatePayload = Pick<InstalledVersion, 'version' | 'status' | 'url'>

/**
 * 暴露给渲染层的能力面。
 *
 * 渲染层**只能**通过 `src/renderer/src/api` 使用这些能力，不要在组件里直接调 ——
 * 这样将来把某个能力从 IPC 换成别的实现时，组件不用改。
 */
const api = {
  window: {
    minimize: (): void => ipcRenderer.send(WINDOW_CHANNELS.minimize),
    toggleMaximize: (): void => ipcRenderer.send(WINDOW_CHANNELS.toggleMaximize),
    close: (): void => ipcRenderer.send(WINDOW_CHANNELS.close),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(WINDOW_CHANNELS.isMaximized),
    /** 打开原生目录选择器；取消时返回 null */
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(WINDOW_CHANNELS.pickDirectory),

    /** 订阅最大化状态变化，返回取消订阅函数。 */
    onMaximizedChanged: (listener: (maximized: boolean) => void): (() => void) => {
      const handler = (_event: unknown, maximized: boolean): void => listener(maximized)
      ipcRenderer.on(WINDOW_CHANNELS.maximizedChanged, handler)
      return () => {
        ipcRenderer.off(WINDOW_CHANNELS.maximizedChanged, handler)
      }
    }
  },

  versions: {
    /** 版本总览：安装根目录、已装版本、远端版本表（远端失败时 remoteError 带原因） */
    overview: (): Promise<VersionOverview> => ipcRenderer.invoke(VERSION_CHANNELS.overview),

    /** 下载安装一个版本；失败会 reject，消息里带 npm 输出的尾部 */
    install: (version: string): Promise<void> => ipcRenderer.invoke(VERSION_CHANNELS.install, version),

    /** 卸载一个版本（正在运行的不给卸，主进程会再挡一次） */
    uninstall: (version: string): Promise<void> => ipcRenderer.invoke(VERSION_CHANNELS.uninstall, version),

    /**
     * 启动一个版本。**等到 dsh 打印就绪地址才 resolve**，所以要给足超时
     * （首次启动可能现场装依赖）。失败时 reject，消息里带子进程输出尾巴。
     */
    start: (version: string): Promise<RunningStatePayload> =>
      ipcRenderer.invoke(VERSION_CHANNELS.start, version),

    /** 停止当前运行的版本（杀整棵进程树） */
    stop: (): Promise<void> => ipcRenderer.invoke(VERSION_CHANNELS.stop),

    /** 订阅安装进度，返回取消订阅函数 */
    onProgress: (listener: (event: VersionProgressEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: VersionProgressEvent): void => listener(payload)
      ipcRenderer.on(VERSION_CHANNELS.progress, handler)
      return () => {
        ipcRenderer.off(VERSION_CHANNELS.progress, handler)
      }
    }
  },

  plugins: {
    /** 读 profile 的已装插件与开关状态（读 cordis.patch.yml，不需要 dsh 在跑） */
    list: (): Promise<PluginList> => ipcRenderer.invoke(PLUGIN_CHANNELS.list),

    /** 按包名整包开关；返回写后的新清单 */
    setEnabled: (packageName: string, enabled: boolean): Promise<PluginList> =>
      ipcRenderer.invoke(PLUGIN_CHANNELS.setEnabled, packageName, enabled),

    /**
     * 安装一个插件。走 dsh 自己的 plugin 命令（→ pnpm）。
     * @param packageName - **真 npm 包名**（可能带 scope），不是目录里的短名
     */
    install: (packageName: string): Promise<void> =>
      ipcRenderer.invoke(PLUGIN_CHANNELS.install, packageName),

    /** 卸载一个插件（`@deepseek-ai/*` 官方组件不允许卸，主进程会挡） */
    uninstall: (packageName: string): Promise<void> =>
      ipcRenderer.invoke(PLUGIN_CHANNELS.uninstall, packageName),

    /** 把一个已装插件更新到指定版本（`add <包>@<版本>`，版本号不带 ^/~/前缀） */
    update: (packageName: string, target: string): Promise<void> =>
      ipcRenderer.invoke(PLUGIN_CHANNELS.update, packageName, target),

    /** 订阅插件增删进度，返回取消订阅函数 */
    onProgress: (listener: (event: PluginProgressEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: PluginProgressEvent): void => listener(payload)
      ipcRenderer.on(PLUGIN_CHANNELS.progress, handler)
      return () => {
        ipcRenderer.off(PLUGIN_CHANNELS.progress, handler)
      }
    }
  },

  log: {
    /** 取主进程日志缓冲的快照（进入终端页时） */
    get: (): Promise<string[]> => ipcRenderer.invoke(LOG_CHANNELS.get),

    /** 清空主进程的日志缓冲 */
    clear: (): Promise<void> => ipcRenderer.invoke(LOG_CHANNELS.clear),

    /** 订阅实时日志行，返回取消订阅函数 */
    onLine: (listener: (line: string) => void): (() => void) => {
      const handler = (_event: unknown, line: string): void => listener(line)
      ipcRenderer.on(LOG_CHANNELS.line, handler)
      return () => {
        ipcRenderer.off(LOG_CHANNELS.line, handler)
      }
    }
  },

  settings: {
    /** 读启动器设置（存 <userData>/settings.json；读失败退回默认值） */
    get: (): Promise<LauncherSettingsPayload> => ipcRenderer.invoke(SETTINGS_CHANNELS.get),

    /** 合并写入设置；开机自启会同步到系统（仅打包后真正写注册表） */
    save: (patch: Partial<LauncherSettingsPayload>): Promise<LauncherSettingsPayload> =>
      ipcRenderer.invoke(SETTINGS_CHANNELS.save, patch)
  },

  market: {
    /** 内置市场库的探测结果：是否可用、版本、各模块导出了什么 */
    capabilities: (): Promise<MarketCapabilities> => ipcRenderer.invoke(MARKET_CHANNELS.capabilities),
    /** 插件目录（region: 'china' | 'global'） */
    catalog: (region: 'china' | 'global'): Promise<MarketCatalog> =>
      ipcRenderer.invoke(MARKET_CHANNELS.catalog, region),
    /** 「更新自己」所需：内置版本 + 市场判定的目标 + 裸查结果 */
    selfVersion: (): Promise<MarketSelfUpdate> => ipcRenderer.invoke(MARKET_CHANNELS.selfVersion)
  },

  snapshot: {
    /** 列出快照（新的在前） */
    list: (): Promise<SnapshotEntry[]> => ipcRenderer.invoke(SNAPSHOT_CHANNELS.list),
    /** 当前 profile 的配置目录与快照根（界面显示用） */
    paths: (): Promise<SnapshotPaths> => ipcRenderer.invoke(SNAPSHOT_CHANNELS.paths),
    /** 手动存一份 */
    create: (label: string): Promise<SnapshotEntry> => ipcRenderer.invoke(SNAPSHOT_CHANNELS.create, label),
    /** 回退到指定快照（回退前会自动先存一份当前状态） */
    restore: (id: string): Promise<RestoreResult> => ipcRenderer.invoke(SNAPSHOT_CHANNELS.restore, id),
    /** 删除一份快照（只删它，不动 profile） */
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke(SNAPSHOT_CHANNELS.remove, id),
    /** 存之前的预演：npm / 非 npm 两份列表 */
    plan: (): Promise<SnapshotPreview> => ipcRenderer.invoke(SNAPSHOT_CHANNELS.plan)
  },

  diagnose: {
    /**
     * 限时启动一次并解析 dsh 自己的失败诊断。
     * **会真的起 dsh**（用完即停），所以由用户显式点按钮触发。
     */
    run: (version: string): Promise<DiagnosisResult> => ipcRenderer.invoke(DIAGNOSE_CHANNELS.run, version)
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(WINDOW_CHANNELS.openExternal, url)
}

contextBridge.exposeInMainWorld('sesame', api)

export type SesameApi = typeof api
