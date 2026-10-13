/**
 * **启动器自己**的更新（不是 dsh 的版本管理）。
 *
 * 与 dsh 版本管理是两件完全不同的事：
 *   · dsh 版本 —— 装在版本池里、可并存、可切换（见 `domain/versions/`）；
 *   · 启动器自己 —— 一个安装包、就地覆盖升级（就是这里）。
 *
 * 数据来源是**本仓库的 GitHub Releases**：每次发版都会带上
 * `DSH-Sesame-Setup-<版本>.exe` 与 `latest.yml`（由 electron-builder 生成，
 * 见 `scripts/publish-release.mjs`）。所以"从仓库更新"= 读那个 `latest.yml`。
 */

/** 一次更新检查的结果 */
export interface LauncherUpdateInfo {
  /** 当前运行版本（`app.getVersion()`） */
  current: string
  /** 远端最新版本；检查失败时为 null */
  latest: string | null
  /** 是否比当前新 */
  available: boolean
  /** 新版本安装包的下载地址（`available` 为 true 时才有） */
  assetUrl: string | null
  /** 安装包字节数（读不到为 0，此时以下载响应的 Content-Length 为准） */
  assetBytes: number
  /** 安装包的 sha512（base64）—— 下载后校验，对不上就不装 */
  sha512: string | null
  /** 该版本的 Release 页面（给"查看更新内容"用） */
  releaseUrl: string
  /**
   * 检查失败的原因；成功时为空串。
   *
   * 网络不通、仓库还没有 Release、`latest.yml` 格式变了都走这里 ——
   * **不抛异常**：设置页打开时不该因为一次网络失败而报错。
   */
  error: string
}

/** 更新过程的进度推送（通道 `launcher:update-progress`） */
export interface LauncherUpdateProgressEvent {
  phase: 'download' | 'verify' | 'install'
  text: string
  /** 0~100；拿不到总长度时为 null（界面显示不确定进度） */
  percent: number | null
}
