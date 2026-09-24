/**
 * 主进程与渲染层共用的版本相关类型。
 *
 * 放在 shared/ 是因为两边都要用：主进程产出这些结构，渲染层的 api 层消费它们。
 * 渲染层自己的 API 契约（contract.ts）在这里之上再做一层面向界面的包装。
 */

export type VersionStatus = 'stopped' | 'starting' | 'running' | 'stopping'

/**
 * 一个已安装的版本。
 *
 * **只包含本应用自己装的**（`<应用目录>/dsh/<版本号>`）。
 *
 * 刻意不收录机器上 npm 全局安装的 dsh：版本池的意义是"这个启动器自己的东西、可整份删掉重建"，
 * 而 npm 全局是全机器共享的、也不归本应用管 —— 混进来会让"独立"破一半，还会让同一个列表里
 * 出现两种卸载语义。需要在机器上共用一份 dsh 时，那是另一件事，不该做进版本池。
 */
export interface InstalledVersion {
  version: string
  status: VersionStatus
  /** 运行中时的访问地址 */
  url: string | null
  /** 入口脚本绝对路径（lib/bin.js），界面上不显示，供诊断 */
  bin: string
}

export interface RemoteVersionInfo {
  /** 按 semver 从高到低 */
  versions: string[]
  tags: Record<string, string>
  /** 跨 tag 取 semver 最高的，**不是** dist-tags.latest */
  latest: string
  /** dist-tags.latest 原值，单独呈现，避免和上面的"最新"混淆 */
  tagLatest: string
}

/** 版本总览：一次 IPC 拿全，避免界面分两次请求出现不一致 */
export interface VersionOverview {
  /** 版本安装根目录（应用旁边的相对路径） */
  root: string
  installed: InstalledVersion[]
  remote: RemoteVersionInfo | null
  /** 拉远端失败时的原因；成功时为空串 */
  remoteError: string
}
