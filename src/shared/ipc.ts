/**
 * 主进程 ↔ 渲染层共用的通道名。
 *
 * 分两组：
 *  - WINDOW_CHANNELS：窗口壳（最小化/最大化/关闭/外链）
 *  - VERSION_CHANNELS：版本管理（真实逻辑）
 */
export const WINDOW_CHANNELS = {
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggle-maximize',
  close: 'window:close',
  isMaximized: 'window:is-maximized',
  maximizedChanged: 'window:maximized-changed',
  pickDirectory:
    'window:pickDirectory' as const,
  openExternal: 'shell:open-external'
} as const

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

/** 插件安装 / 卸载的进度推送载荷 */
export interface PluginProgressEvent {
  packageName: string
  phase: 'resolve' | 'install' | 'done'
  text: string
}

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
 * 放进 `~/.dsh` 会让那个目录的含义变模糊。
 */
export const SETTINGS_CHANNELS = {
  get: 'settings:get',
  save: 'settings:save'
} as const

/** 启动器设置的载荷（主进程与渲染层共用，字段与 main/settings.ts 的 LauncherSettings 一致） */
export interface LauncherSettingsPayload {
  autoStart: boolean
  lang: 'zh' | 'en'
  /** 额外启动参数，原样字符串（主进程负责拆分成 argv） */
  args: string
  /** 启动 profile。只有 `web` 能在启动器窗口里跑起来，其他会在启动时被明确拒绝 */
  profile: string
  /** 启动端口（1024~65535）。固定端口，默认 3080；被占用时自动回退到系统分配的空闲端口 */
  port: number
  /** dsh 数据目录（DSH_HOME）。空串 = 用环境变量或默认的 ~/.dsh */
  dshHome: string
}

/** 安装进度推送的载荷 */
export interface VersionProgressEvent {
  version: string
  phase: 'resolve' | 'download' | 'done'
  text: string
}

export type WindowChannel = (typeof WINDOW_CHANNELS)[keyof typeof WINDOW_CHANNELS]
export type VersionChannel = (typeof VERSION_CHANNELS)[keyof typeof VERSION_CHANNELS]
export type PluginChannel = (typeof PLUGIN_CHANNELS)[keyof typeof PLUGIN_CHANNELS]
export type MarketChannel = (typeof MARKET_CHANNELS)[keyof typeof MARKET_CHANNELS]
export type LogChannel = (typeof LOG_CHANNELS)[keyof typeof LOG_CHANNELS]
export type SettingsChannel = (typeof SETTINGS_CHANNELS)[keyof typeof SETTINGS_CHANNELS]
