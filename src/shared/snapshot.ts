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
  bytes: number
}

export interface RestoreResult {
  /** 写回去的文件 */
  restored: string[]
  /** 快照里没有、因而没动的文件 */
  skipped: string[]
  /** 回退前自动存的那份（便于反悔） */
  backupId: string
}

/** 界面上要展示的路径信息 */
export interface SnapshotPaths {
  profileDir: string
  root: string
  home: string
}
