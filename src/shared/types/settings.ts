/**
 * 启动器设置的**共享形状**。
 *
 * 与主进程 `src/main/infrastructure/settings.ts` 的 `LauncherSettings` 必须一致 ——
 * 那边是读写的真身，这里是跨进程传的那一份。渲染层自己的 `SettingsPayload`
 * （见 `src/renderer/api/contract.ts`）再在其上做面向界面的包装。
 *
 * 刻意与 dsh 的 profile 配置分开：这几项只关于"启动器怎么启动 dsh"，
 * 放进 `~/.dsh` 会让那个目录的含义变模糊。
 */
export interface LauncherSettingsPayload {
  autoStart: boolean
  lang: 'zh' | 'en'
  /** 额外启动参数，原样字符串（主进程负责拆分成 argv） */
  args: string
  /** 启动方式。`web` / `tui` 是 dsh 的 profile；`desktop` 是另一个 Electron 应用（不 spawn dsh） */
  profile: string
  /**
   * **dsh 的端口**（web / tui 用；1024~65535，默认 3080，被占用时回退到系统分配的空闲端口）。
   *
   * **桌面端不受它影响** —— 桌面端由自己内置的 `webserver.config.port` 决定（默认 19387），
   * 启动器既不传、也不该传这个值。
   */
  port: number
  /** dsh 数据目录（DSH_HOME）。空串 = 用环境变量或默认的 ~/.dsh */
  dshHome: string
  snapshotDir: string
  poolDir: string
}
