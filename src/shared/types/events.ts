/**
 * 主进程 → 渲染层的**推送事件载荷**。
 *
 * 只有"进度/通知"这类单向推送在这里；请求/响应的数据类型属于领域模型，
 * 放 `@shared/types/*`。通道名在 `@shared/constants/channels`。
 */

/** 版本安装进度推送的载荷（通道 `versions:progress`） */
export interface VersionProgressEvent {
  version: string
  phase: 'resolve' | 'download' | 'done'
  text: string
}

/** 插件安装 / 卸载的进度推送载荷（通道 `plugins:progress`） */
export interface PluginProgressEvent {
  packageName: string
  phase: 'resolve' | 'install' | 'done'
  text: string
}

/** 桌面端启动进度推送的载荷（通道 `desktop:progress`） */
export interface DesktopProgressEvent {
  version: string
  phase: 'download' | 'install' | 'launch'
  text: string
}
