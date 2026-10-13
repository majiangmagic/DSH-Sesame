/**
 * 主进程 ↔ 渲染层共用的**通道名**。
 *
 * 全项目只有这一处定义通道名：主进程在 `src/main/domain/<领域>/ipc.ts` 注册，
 * preload 在 `src/preload/index.ts` 调用 —— 两边都从这里取常量，不写字面量。
 *
 * 通道名是**线上协议**：目录怎么重组都不该改它（`versions:start` 永远叫这个名），
 * 所以下面按业务分组，而不是按 `src/main/domain/` 的目录划分。
 *
 * 事件载荷（进度推送的形状）在 ./events.ts。
 */

/** 窗口壳：最小化 / 最大化 / 关闭 / 外链 / 目录选择器 */
export const WINDOW_CHANNELS = {
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggle-maximize',
  close: 'window:close',
  isMaximized: 'window:is-maximized',
  maximizedChanged: 'window:maximized-changed',
  pickDirectory: 'window:pickDirectory' as const,
  openExternal: 'shell:open-external'
} as const

/**
 * 版本与运行生命周期。
 *
 * 注意 start / stop 由 `src/main/domain/control/ipc.ts` 注册，overview / install /
 * uninstall 由 `src/main/domain/versions/ipc.ts` 注册 —— 分属两个领域，但共用这一组
 * 通道名，因为对渲染层来说它们是同一件事（"这个版本"）。
 */
export const VERSION_CHANNELS = {
  /** 一次拿全：安装根目录 + 已装版本 + 远端版本表 */
  overview: 'versions:overview',
  /** 下载安装一个版本 */
  install: 'versions:install',
  /** 卸载一个版本 */
  uninstall: 'versions:uninstall',
  /** 启动一个版本（spawn dsh web，等到它打印就绪地址才 resolve） */
  start: 'versions:start',
  /** 停止当前运行的版本（杀整棵进程树） */
  stop: 'versions:stop',
  /** 主进程 → 渲染层的安装进度推送 */
  progress: 'versions:progress'
} as const

export const PLUGIN_CHANNELS = {
  /** 读 profile 的已装插件与开关状态 */
  list: 'plugins:list',
  /** 按包名整包开关（写 cordis.patch.yml） */
  setEnabled: 'plugins:set-enabled',
  /** 通过 dsh 自己的 plugin 命令安装一个插件 */
  install: 'plugins:install',
  /** 把一个已装插件更新到指定版本 */
  update: 'plugins:update',
  /** 通过 dsh 自己的 plugin 命令卸载一个插件 */
  uninstall: 'plugins:uninstall',
  /** 主进程 → 渲染层的插件增删进度 */
  progress: 'plugins:progress'
} as const

export const MARKET_CHANNELS = {
  /** 内置市场库是否载入成功、各模块导出了什么（内部 API 探测结果） */
  capabilities: 'market:capabilities',
  /** 插件目录 */
  catalog: 'market:catalog',
  /** 市场自己的最新版本（"更新自己"用） */
  selfVersion: 'market:self-version'
} as const

/** 终端页：主进程的日志环形缓冲 */
export const LOG_CHANNELS = {
  /** 取当前缓冲快照（进入页面时） */
  get: 'log:get',
  /** 清空缓冲 */
  clear: 'log:clear',
  /** 主进程 → 渲染层的实时行推送 */
  line: 'log:line'
} as const

/**
 * 启动器**自己**的设置（存 `<userData>/settings.json`）。
 *
 * 刻意与 dsh 的 profile 配置分开：这几项只关于"启动器怎么启动 dsh"，
 * 放进 `~/.dsh` 会让那个目录的含义变模糊。载荷形状见 `@shared/types/settings`。
 */
export const SETTINGS_CHANNELS = {
  get: 'settings:get',
  save: 'settings:save'
} as const

/**
 * 桌面端启动方式专用的通道。
 *
 * desktop 是另一个 Electron 应用（不是 dsh 的 profile），它的「启动」是
 * 下载官方安装包 → 静默安装 → 拉起可执行文件，所以进度和版本安装分开走一条通道。
 */
export const DESKTOP_CHANNELS = {
  /** 主进程 → 渲染层的桌面端下载/安装/启动进度 */
  progress: 'desktop:progress'
} as const

/**
 * 启动诊断。**会真的启动一次 dsh**（用完即停）—— 因为要抓"搞坏启动"的插件，
 * harness 连它一起启动是唯一办法（这一点与 dsh-plugin-guard 的结论一致）。
 */
export const DIAGNOSE_CHANNELS = {
  run: 'diagnose:run'
} as const

/**
 * 插件配置快照。存/列/回退三件事。
 * 快照放 <userData>/snapshots/（**不放安装目录** —— 覆盖安装会把它清空）。
 */
export const SNAPSHOT_CHANNELS = {
  list: 'snapshot:list',
  create: 'snapshot:create',
  restore: 'snapshot:restore',
  remove: 'snapshot:remove',
  plan: 'snapshot:plan',
  paths: 'snapshot:paths'
} as const

/**
 * **启动器自己**的更新（入口在设置页）。
 *
 * 刻意与 `VERSION_CHANNELS` 分开：那一组管的是 **dsh 的版本池**（可并存、可切换），
 * 这一组管的是**启动器这个安装包自己**（就地覆盖升级）。两者语义完全不同，
 * 混在一起会让"更新"这个词在两处指两件事。
 */
export const UPDATE_CHANNELS = {
  /** 读远端最新版并与当前版本比较；**不下载** */
  check: 'launcher:update-check',
  /** 下载 → 校验 sha512 → 静默安装 → 退出（安装器负责重启） */
  install: 'launcher:update-install',
  /** 主进程 → 渲染层的下载/校验/安装进度 */
  progress: 'launcher:update-progress'
} as const

export type WindowChannel = (typeof WINDOW_CHANNELS)[keyof typeof WINDOW_CHANNELS]
export type VersionChannel = (typeof VERSION_CHANNELS)[keyof typeof VERSION_CHANNELS]
export type PluginChannel = (typeof PLUGIN_CHANNELS)[keyof typeof PLUGIN_CHANNELS]
export type MarketChannel = (typeof MARKET_CHANNELS)[keyof typeof MARKET_CHANNELS]
export type LogChannel = (typeof LOG_CHANNELS)[keyof typeof LOG_CHANNELS]
export type SettingsChannel = (typeof SETTINGS_CHANNELS)[keyof typeof SETTINGS_CHANNELS]
export type DiagnoseChannel = (typeof DIAGNOSE_CHANNELS)[keyof typeof DIAGNOSE_CHANNELS]
export type SnapshotChannel = (typeof SNAPSHOT_CHANNELS)[keyof typeof SNAPSHOT_CHANNELS]
export type UpdateChannel = (typeof UPDATE_CHANNELS)[keyof typeof UPDATE_CHANNELS]
