/** 快照相关类型（渲染层与主进程共用） */

/*
 * 关于**为什么快照里不记 dsh 版本**（曾经有一个 `dshVersion` 字段，已去掉）：
 *
 * 快照的意义是"把 profile 的配置与 node_modules 还原回去"，而**版本不是配置的一部分** ——
 * 它是"存的那一刻恰好在跑什么"，与快照内容毫无因果关系。而插件与数据是**按 profile 隔离、
 * 不按 dsh 版本隔离**的（所有 dsh 版本共用 `~/.dsh/profiles/<name>`），所以同一个快照可以在
 * 任何版本下回退，那个字段既不影响回退、也不该影响用户的判断。
 *
 * 代价是它会让列表看起来像"这个快照只属于某个版本"，反而误导（截图里每行都拖着一个
 * `· dsh 0.2.0-rc.2`）。去掉它同时让 `domain/snapshots` 少一条对 `domain/control` 的依赖
 * （原先要 import `currentRun` 才能记下版本）。
 *
 * 老快照的 manifest 里仍留着那个字段，读的时候会被忽略 —— 不需要迁移。
 */

export type SnapshotTrigger = 'manual' | 'auto' | 'pre-rollback'

export interface SnapshotEntry {
  /** 目录名，同时用作 id */
  id: string
  /** ISO 时间 */
  at: string
  profile: string
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

/**
 * 存快照前的预演（弹窗里显示什么就是什么，点「确定」才真的存）。
 *
 * **刻意不做任何分类**：打包是全量的，所以只要把"有哪些插件"平铺列出来就行。
 * 之前加过 npm / 非 npm 的分类，那是多余的一层 —— 分类不准还会误导，
 * 而全量打包本来就不需要知道来源。
 */
export interface SnapshotPreview {
  /** 平铺的插件列表（来自 profile 的 package.json dependencies） */
  plugins: SnapshotPluginRef[]
  /** 会被一起存的配置文件 */
  configFiles: string[]
  /** 要打包的 node_modules 目录 */
  modulesDir: string
  /** 该目录当前的大小（字节；不存在为 0） */
  modulesBytes: number
  /** 该目录是否存在（不存在就没得打包） */
  willPack: boolean
  /** 上一份快照的时间（没有就空串）—— 让用户知道值不值得再存 */
  lastAt: string
  /** 上一份快照里整包的大小 */
  lastModulesBytes: number
}

/** 弹窗里插件列表的一行 */
export interface SnapshotPluginRef {
  name: string
  /** 已安装的版本（读不到就空串） */
  version: string
}
