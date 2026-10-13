import type { MarketCapabilities, MarketCatalog, MarketSelfUpdate } from '@shared/types/plugins'
import type { PluginList } from '@shared/types/plugins'
import type { VersionOverview } from '@shared/types/versions'
import type { DiagnosisResult } from '@shared/types/control'
import type { RestoreResult, SnapshotEntry, SnapshotPaths, SnapshotPreview } from '@shared/types/snapshots'
import type { LauncherUpdateInfo, LauncherUpdateProgressEvent } from '@shared/types/update'
import type {
  DesktopLaunchProgress,
  InstallProgress,
  ManagerApi,
  PluginInstallProgress,
  RunningState,
  SettingsPayload
} from './contract'

/**
 * 真实实现。
 *
 *  - 版本：走 IPC 到主进程，真扫目录、真拉 registry、真用 npm 下载/卸载；
 *  - 启动 / 停止：走 IPC，主进程 spawn `dsh web --port <设置里的端口>` 并从输出里读就绪地址；
 *  - 插件：走 IPC 到主进程，真读写真 profile 的 `cordis.patch.yml`；安装/卸载走
 *    dsh 自己的 `plugin` 命令（→ pnpm），不自己 npm install；
 *  - 终端：走 IPC，读主进程日志环形缓冲（dsh 子进程输出 + 操作事件）并实时订阅；
 *  - **设置仍是样例数据**（只改内存、重启即丢），界面上应挂「样例数据」标注。
 */
export const realApi: ManagerApi = {
  getVersionOverview: (): Promise<VersionOverview> => window.sesame.versions.overview(),

  /**
   * 插件清单。
   *
   * **只回第三方插件**：`@deepseek-ai/*` 是官方运行时，不是"用户装的插件"，而且一律不可开关 ——
   * 展示出来只会占位。过滤放在这一层，控制页与插件页拿到的是同一份，不会两处不一致。
   * 主进程照实回全量，需要时随时能把官方项显示回来。
   */
  runDiagnosis: (version: string): Promise<DiagnosisResult> => window.sesame.diagnose.run(version),
  listSnapshots: (): Promise<SnapshotEntry[]> => window.sesame.snapshot.list(),
  snapshotPaths: (): Promise<SnapshotPaths> => window.sesame.snapshot.paths(),
  createSnapshot: (label: string): Promise<SnapshotEntry> => window.sesame.snapshot.create(label),
  restoreSnapshot: (id: string): Promise<RestoreResult> => window.sesame.snapshot.restore(id),
  deleteSnapshot: (id: string): Promise<boolean> => window.sesame.snapshot.remove(id),
  snapshotPlan: (): Promise<SnapshotPreview> => window.sesame.snapshot.plan(),

  async getPlugins(): Promise<PluginList> {
    const list = await window.sesame.plugins.list()
    return { ...list, plugins: list.plugins.filter((plugin) => !plugin.official) }
  },

  setPluginEnabled: async (pluginName: string, enabled: boolean): Promise<void> => {
    await window.sesame.plugins.setEnabled(pluginName, enabled)
  },

  /* ---------------- 设置（真实：<userData>/settings.json） ---------------- */

  getSettings: (): Promise<SettingsPayload> => window.sesame.settings.get(),
  saveSettings: (patch: Partial<SettingsPayload>): Promise<SettingsPayload> =>
    window.sesame.settings.save(patch),

  /* ---------------- 终端（真实） ---------------- */

  /** 主进程日志缓冲的快照：dsh 子进程输出 + 启动器操作事件 */
  getLog: (): Promise<string[]> => window.sesame.log.get(),
  clearLog: (): Promise<void> => window.sesame.log.clear(),
  onLogLine: (listener: (line: string) => void): (() => void) => window.sesame.log.onLine(listener),

  /** 下载安装：主进程用 npm 装进 `<版本根>/<版本号>`，进度通过推送通道回来 */
  async installVersion(version: string, onProgress?: (progress: InstallProgress) => void): Promise<void> {
    const off = onProgress
      ? window.sesame.versions.onProgress((event) => {
          if (event.version !== version) return
          onProgress({ phase: event.phase, text: event.text })
        })
      : null
    try {
      await window.sesame.versions.install(version)
    } finally {
      off?.()
    }
  },

  uninstallVersion: (version: string): Promise<void> => window.sesame.versions.uninstall(version),

  // --- 插件市场：内置 dshmarket 库 ---

  getMarketCapabilities: (): Promise<MarketCapabilities> => window.sesame.market.capabilities(),
  getMarketCatalog: (region: 'china' | 'global'): Promise<MarketCatalog> => window.sesame.market.catalog(region),
  getMarketSelfUpdate: (): Promise<MarketSelfUpdate> => window.sesame.market.selfVersion(),

  /**
   * 插件安装。走 dsh 自己的 `plugin --profile web add <pkg>`（→ pnpm）。
   *
   * 用**真 npm 包名**当入参（目录的 `npm` 字段）。不能自己 `npm install` ——
   * profile 是 pnpm 布局，混用会破坏依赖树；也不能省掉 dsh 那一层，因为
   * `dsh.profile.bundles` 的启用清单由它在 pnpm 成功后一并 reconcile。
   */
  async installPlugin(
    packageName: string,
    onProgress?: (progress: PluginInstallProgress) => void
  ): Promise<void> {
    const off = onProgress
      ? window.sesame.plugins.onProgress((event) => {
          if (event.packageName !== packageName) return
          onProgress({ phase: event.phase, text: event.text })
        })
      : null
    try {
      await window.sesame.plugins.install(packageName)
    } finally {
      off?.()
    }
  },

  /**
   * 插件更新：走 dsh 的 plugin 命令（`add <包>@<版本>`）。
   *
   * 不复用 installPlugin 的入参拼法：那条路径只接包名、并且会以"清单里已有"为由直接返回
   * （它把"已装"当成"不用装"），对更新是错的。
   */
  async updatePlugin(
    packageName: string,
    target: string,
    onProgress?: (progress: PluginInstallProgress) => void
  ): Promise<void> {
    const off = onProgress
      ? window.sesame.plugins.onProgress((event) => {
          if (event.packageName !== packageName) return
          onProgress({ phase: event.phase, text: event.text })
        })
      : null
    try {
      await window.sesame.plugins.update(packageName, target)
    } finally {
      off?.()
    }
  },

  /** 插件卸载：同样走 dsh 的 plugin 命令（`remove`），官方组件由主进程拦下 */
  async uninstallPlugin(
    packageName: string,
    onProgress?: (progress: PluginInstallProgress) => void
  ): Promise<void> {
    const off = onProgress
      ? window.sesame.plugins.onProgress((event) => {
          if (event.packageName !== packageName) return
          onProgress({ phase: event.phase, text: event.text })
        })
      : null
    try {
      await window.sesame.plugins.uninstall(packageName)
    } finally {
      off?.()
    }
  },

  /* ---------------- 启动 / 停止（spawn dsh web） ---------------- */

  /**
   * 启动一个版本。桌面端时订阅「下载 → 安装 → 启动」的进度并透传给 onProgress；
   * 其余启动方式进度通道不发消息，onProgress 自然不会被调用。
   */
  async startVersion(
    version: string,
    onProgress?: (progress: DesktopLaunchProgress) => void
  ): Promise<RunningState> {
    const off = onProgress
      ? window.sesame.desktop.onProgress((event) => {
          if (event.version !== version) return
          onProgress({ phase: event.phase, text: event.text })
        })
      : null
    try {
      return await window.sesame.versions.start(version)
    } finally {
      off?.()
    }
  },

  stopVersion: (): Promise<void> => window.sesame.versions.stop(),

  /* ---------------- 启动器自己的更新（设置页） ---------------- */

  checkLauncherUpdate: (): Promise<LauncherUpdateInfo> => window.sesame.launcherUpdate.check(),

  /**
   * 下载并安装启动器更新。
   *
   * **成功时不会 resolve** —— 主进程会让应用退出，安装器接着把新版拉起来。
   * 所以界面不要写"更新成功"这种提示，只处理失败分支。
   */
  installLauncherUpdate: (): Promise<void> => window.sesame.launcherUpdate.install(),

  onLauncherUpdateProgress: (
    listener: (event: LauncherUpdateProgressEvent) => void
  ): (() => void) => window.sesame.launcherUpdate.onProgress(listener),

  openExternal: (url: string): Promise<void> => window.sesame.openExternal(url)
}
