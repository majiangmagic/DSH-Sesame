/**
 * 启动器设置的**共享形状**。
 *
 * 与主进程 `src/main/platform/settings.ts` 的 `LauncherSettings` 必须一致 ——
 * 那边是读写的真身，这里是跨进程传的那一份。渲染层自己的 `SettingsPayload`
 * （见 `src/renderer/api/contract.ts`）再在其上做面向界面的包装。
 *
 * 刻意与 dsh 的 profile 配置分开：这几项只关于"启动器怎么启动 dsh"，
 * 放进 `~/.dsh` 会让那个目录的含义变模糊。
 */
export interface LauncherSettingsPayload {  autoStart: boolean
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
  /**
   * **插件母版目录**。空串 = 关闭母版模式（各 profile 自己管自己的插件，即旧行为）。
   *
   * 非空时它是"唯一写入点"：
   *   · 安装 / 更新 / 卸载 / 开关插件都只改这里（pnpm 只在这里跑）；
   *   · 启动 web 与桌面端之前，从它**克隆**到各自的 profile（整棵 node_modules +
   *     package.json + lockfile，补丁层按行合并）。
   *
   * 形态与 dsh 的 profile 目录一致（`package.json` / `pnpm-lock.yaml` /
   * `cordis.patch.yml` / `node_modules`），但**不含任何 dsh 运行时**，也不被 dsh 直接使用。
   */
  pluginsDir: string
}

/**
 * 各项目录**解析后的真实路径**。
 *
 * 设置里那几项留空表示"用默认"；默认值随安装位置与数据根变化，所以由主进程算好给界面，
 * 而不是让界面去拼一句"默认<某目录>/xxx"（那种文案与实际位置对不上，用户没法判断数据在哪）。
 */
export interface SettingsPaths {
  /** dsh 数据目录（DSH_HOME） */
  dshHome: string
  /** 版本池（<数据根>/dsh） */
  poolDir: string
  /** 快照根（<数据根>/snapshots） */
  snapshotDir: string
  /** 插件母版（<DSH_HOME>/profiles/base，可能是指向自定义位置的链接） */
  pluginsDir: string
}