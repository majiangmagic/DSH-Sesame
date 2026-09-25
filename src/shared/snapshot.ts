/** 快照相关类型（渲染层与主进程共用） */

export type SnapshotTrigger = 'manual' | 'auto' | 'pre-rollback'

export interface SnapshotEntry {
  /** 目录名，同时用作 id */
  id: string
  /** ISO 时间 */
  at: string
  profile: string
  /** 存的时候在跑的 dsh 版本，可能为空 */
  dshVersion: string
  trigger: SnapshotTrigger
  /** 用户备注（手动存时可填） */
  label: string
  /** 实际存到的文件（配置文件本来就可能缺，缺的不记） */
  files: string[]
  /** 配置文件的总字节数 */
  bytes: number
  /**
   * `node_modules` 的整包（全量压缩）。
   *
   * 不做"哪些插件是 npm、哪些是私有"的判定 —— 全都打包，稳且不会漏。
   * 代价是每份上百 MB，所以下面用指纹去重：内容没变就不再存一份整包。
   */
  modules: SnapshotModules | null
  /**
   * 内容指纹（node_modules 的文件清单 + 大小 + 修改时间）。
   *
   * 打包一次要几十秒，所以先算这个便宜的比较；和上一份相同就跳过整包。
   */
  fingerprint: string
  /**
   * 仅出现在**返回值**上：这次因为"内容与上一份完全相同"而没有新建。
   * 不写进 manifest（写进去就没意义了）。
   */
  reused?: boolean
}

/** 一份快照里的 node_modules 整包 */
export interface SnapshotModules {
  /** 相对快照目录的文件名，如 modules.tgz */
  file: string
  bytes: number
  /** 压缩包的 sha256 —— 内容的身份 */
  sha256: string
}

export interface RestoreResult {
  /** 写回去的文件 */
  restored: string[]
  /** 快照里没有、因而没动的文件 */
  skipped: string[]
  /** 回退前自动存的那份（便于反悔） */
  backupId: string
  /** node_modules 整包是否也解回去了（快照里没有整包时为 false） */
  modulesRestored: boolean
}

/** 界面上要展示的路径信息 */
export interface SnapshotPaths {
  profileDir: string
  root: string
  home: string
}
