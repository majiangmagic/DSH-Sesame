import type { MarketCapabilities, MarketCatalog, MarketPlugin, MarketSelfUpdate } from '@shared/types/plugins'
import type { PluginEntry, PluginList, PluginReason } from '@shared/types/plugins'
import type { VersionOverview, VersionStatus } from '@shared/types/versions'
import type { DiagnosisResult } from '@shared/types/control'
import type { RestoreResult, SnapshotEntry, SnapshotPaths, SnapshotPreview } from '@shared/types/snapshots'
import type { LauncherUpdateInfo, LauncherUpdateProgressEvent } from '@shared/types/update'

/**
 * 接口契约 —— 只有类型，没有实现。
 *
 * 现状（接真实逻辑的进度）：
 *  - 版本：读 / 装 / 卸 已**接真**；
 *  - 启动 / 停止：已**接真**（主进程 spawn `dsh web`，从输出里读就绪地址）；
 *  - 插件：读 / 开关写入 / 安装 / 卸载 已**接真**；
 *  - 市场：目录 / 能力探测 / 自更新信息 已**接真**（内置 dshmarket 库）；
 *  - 终端：已**接真**（主进程日志环形缓冲）；
 *  - 设置：已**接真**（存 `<userData>/settings.json`）。
 */

export type {
  MarketCapabilities,
  MarketCatalog,
  MarketPlugin,
  MarketSelfUpdate,
  PluginEntry,
  PluginList,
  PluginReason,
  VersionOverview,
  VersionStatus,
  LauncherUpdateInfo,
  LauncherUpdateProgressEvent
}

/* ---------------- 设置（真实：<userData>/settings.json） ---------------- */

/**
 * 启动器的设置，只有四项 —— 设置页精简后剩下的，每项都能真的生效。
 *
 * 原先这里有 12 个字段（dataDir / port / listenPort / seedMarket / autoDisablePlugins …），
 * 那些是照抄原版表单抄来的：原版的管理页自己是个本地 HTTP 服务，所以有端口；
 * 本应用是 Electron 窗口，那些字段**没有对应物**，已随表单一并删除。
 */
export interface SettingsPayload {
  /** 开机自启（主进程调 app.setLoginItemSettings，仅在打包后生效） */
  autoStart: boolean
  /** 界面语言 */
  lang: 'zh' | 'en'
  /** 额外启动参数，原样字符串 */
  args: string
  /** 启动方式：`web` / `tui` 是 dsh 的 profile；`desktop` 是另一个 Electron 应用 */
  profile: string
  /**
   * **dsh 的端口**（web / tui 用）。**桌面端不受它影响** ——
   * 桌面端用自己内置的 `webserver.config.port`（默认 19387）。
   */
  port: number
  /** dsh 数据目录（DSH_HOME）。空串 = 用 DSH_HOME 环境变量或默认的 ~/.dsh */
  dshHome: string,
  snapshotDir: string
  poolDir: string
}

export interface RunningState {
  version: string
  status: VersionStatus
  url: string | null
}

/** 安装进度：phase 表示阶段，text 是给用户看的一句话 */
export interface InstallProgress {
  phase: 'resolve' | 'download' | 'done'
  text: string
}

/**
 * 插件安装 / 卸载进度。
 *
 * 与版本安装的 `InstallProgress` 分开：插件走的是 dsh 的 plugin 命令（→ pnpm），
 * 没有"download"这个阶段，硬套会让两边的 phase 语义都变模糊。
 */
export interface PluginInstallProgress {
  phase: 'resolve' | 'install' | 'done'
  text: string
}

/** 桌面端「下载 → 安装 → 启动」的进度（对应 shared 里的 DesktopProgressEvent，去掉 version 字段） */
export interface DesktopLaunchProgress {
  phase: 'download' | 'install' | 'launch'
  text: string
}

/* ---------------- 面 ---------------- */

export interface ManagerApi {
  /** 真实：安装根目录 + 已装版本 + 远端版本表 */
  getVersionOverview(): Promise<VersionOverview>

  /** 真实：读 profile 的已装插件（主进程照实回全量，渲染层过滤掉官方组件） */
  /**
   * 限时启动一次当前版本并解析 dsh 自己的失败诊断，返回**有问题的插件**。
   * 会真的起 dsh（用完即停）。
   */
  runDiagnosis(version: string): Promise<DiagnosisResult>

  /** 快照：列出（新的在前） */
  listSnapshots(): Promise<SnapshotEntry[]>
  /** 快照：当前 profile 的配置目录与快照根 */
  snapshotPaths(): Promise<SnapshotPaths>
  /** 快照：手动存一份 */
  createSnapshot(label: string): Promise<SnapshotEntry>
  /** 快照：回退（回退前自动先存一份当前状态） */
  restoreSnapshot(id: string): Promise<RestoreResult>
  /** 快照：删除一份 */
  deleteSnapshot(id: string): Promise<boolean>
  /** 快照：存之前的预演（弹窗里那两份列表） */
  snapshotPlan(): Promise<SnapshotPreview>

  getPlugins(): Promise<PluginList>

  /** 读启动器设置（存 `<userData>/settings.json`，读失败退回默认值） */
  getSettings(): Promise<SettingsPayload>
  /** 合并写入设置；开机自启会同步到系统（仅打包后） */
  saveSettings(patch: Partial<SettingsPayload>): Promise<SettingsPayload>
  setPluginEnabled(pluginName: string, enabled: boolean): Promise<void>

  /* ---------------- 终端 ---------------- */

  /** 终端日志快照：主进程环形缓冲（dsh 子进程输出 + 启动器操作事件） */
  getLog(): Promise<string[]>
  /** 清空主进程的日志缓冲 */
  clearLog(): Promise<void>
  /** 订阅实时日志行，返回取消订阅函数 */
  onLogLine(listener: (line: string) => void): () => void

  /**
   * 下载安装一个版本。真实实现：主进程写私有清单后用 npm 装。
   * @param onProgress - 可选进度回调；界面据此显示"正在解析 / 已装 N 个包"
   */
  installVersion(version: string, onProgress?: (progress: InstallProgress) => void): Promise<void>

  /** 卸载一个版本（正在运行的不给卸） */
  uninstallVersion(version: string): Promise<void>

  /* ---------------- 插件市场（内置 dshmarket 库） ---------------- */

  /** 内置市场库的能力探测：是否可用、版本、缺失的内部导出 */
  getMarketCapabilities(): Promise<MarketCapabilities>
  /** 插件目录（真实来源，实测四千余条） */
  getMarketCatalog(region: 'china' | 'global'): Promise<MarketCatalog>
  /** 「更新自己」所需：内置版本、市场判定的目标、裸查结果 */
  getMarketSelfUpdate(): Promise<MarketSelfUpdate>

  /**
   * 安装一个插件到 profile。
   *
   * 走 dsh 自己的插件命令（`dsh plugin --profile <name> add <pkg>` → pnpm），
   * 不是自己 npm install —— profile 是 pnpm 布局，混用会破坏依赖树。
   *
   * @param packageName - **真 npm 包名**（目录的 `npm` 字段，可能带 scope）
   */
  installPlugin(
    packageName: string,
    onProgress?: (progress: PluginInstallProgress) => void
  ): Promise<void>

  /**
   * 把一个已装插件更新到指定版本。
   *
   * 与安装走同一个透传通道（`add <包>@<版本>` → pnpm）。用 `add` 而不是 pnpm 的 `update`：
   * `update` 受 package.json 里的范围约束（`^0.19.1` 不会跨到 `0.20.0`），
   * 会出现"界面说有新版、点了却没动"。显式指定版本，按钮承诺什么就装什么。
   *
   * @param target - 目标版本号（**不带** `^`/`~` 前缀）。界面通常传市场目录里的 `version`。
   */
  updatePlugin(
    packageName: string,
    target: string,
    onProgress?: (progress: PluginInstallProgress) => void
  ): Promise<void>

  /** 卸载一个插件（`dsh plugin ... remove`）。`@deepseek-ai/*` 官方组件不允许卸。 */
  uninstallPlugin(
    packageName: string,
    onProgress?: (progress: PluginInstallProgress) => void
  ): Promise<void>

  /* ---------------- 启动 / 停止 ---------------- */

  /**
   * 启动一个版本。
   *
   * 启动方式为 `web` / `tui` 时：主进程 spawn `dsh web --host 127.0.0.1 --port <设置里的端口> --no-open`，
   * **等到 dsh 打印就绪地址才 resolve**。失败时消息里带子进程输出尾巴。
   *
   * 启动方式为 `desktop` 时：下载对应版本的官方桌面端安装包 → 静默安装 → 启动，
   * 进度通过 onProgress 回报（首次较慢）。返回的 url 为 null，界面据此不开浏览器。
   */
  startVersion(
    version: string,
    onProgress?: (progress: DesktopLaunchProgress) => void
  ): Promise<RunningState>

  /** 停止当前运行的版本（杀整棵进程树）。没在跑时直接返回。 */
  stopVersion(): Promise<void>

  /* ---------------- 启动器自己的更新（设置页） ---------------- */

  /**
   * 查本仓库的 GitHub Releases 有没有比当前更新的启动器版本。**只查不装。**
   *
   * 失败也会 resolve（`error` 字段带原因）—— 设置页打开时就会调它，
   * 一次网络失败不该让整页报错。
   */
  checkLauncherUpdate(): Promise<LauncherUpdateInfo>

  /**
   * 下载 → 校验 sha512 → 静默安装 → 退出（安装器负责把应用重新拉起）。
   *
   * **成功时这个 Promise 不会 resolve** —— 应用会退出。失败才 reject。
   * 开发模式下会直接拒绝（装的是源码目录，不能被安装包覆盖）。
   */
  installLauncherUpdate(): Promise<void>

  /** 订阅下载/校验/安装进度，返回取消订阅函数 */
  onLauncherUpdateProgress(listener: (event: LauncherUpdateProgressEvent) => void): () => void

  /* ---------------- 外链 ---------------- */

  /**
   * 交给系统浏览器打开（只允许 http/https，主进程会挡掉别的协议）。
   *
   * 渲染层自己开不了外链：CSP 限死在本机，而且 Electron 的 `window.open` 默认
   * 会开一个新 Electron 窗口而不是默认浏览器。
   */
  openExternal(url: string): Promise<void>
}
