import type { MarketCapabilities, MarketCatalog, MarketPlugin, MarketSelfUpdate } from '@shared/market'
import type { PluginEntry, PluginList, PluginReason } from '@shared/plugins'
import type { VersionOverview, VersionStatus } from '@shared/versions'
import type { DiagnosisResult } from '@shared/diagnose'
import type { RestoreResult, SnapshotEntry, SnapshotPaths } from '@shared/snapshot'

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
  VersionStatus
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
  /** 启动 profile：只有 web 能在启动器窗口里跑起来 */
  profile: string
  /** 启动端口（1024~65535）。固定端口，默认 3080；被占用时自动回退到系统分配的空闲端口 */
  port: number
  /** dsh 数据目录（DSH_HOME）。空串 = 用 DSH_HOME 环境变量或默认的 ~/.dsh */
  dshHome: string,
  snapshotDir: string
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
   * 启动一个版本：主进程 spawn `dsh web --host 127.0.0.1 --port <设置里的端口> --no-open`，
   * **等到 dsh 打印就绪地址才 resolve**。失败时消息里带子进程输出尾巴。
   */
  startVersion(version: string): Promise<RunningState>

  /** 停止当前运行的版本（杀整棵进程树）。没在跑时直接返回。 */
  stopVersion(): Promise<void>
}
