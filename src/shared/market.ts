/**
 * 插件市场相关类型：主进程把 dshmarket 的目录数据收窄成这些形状，渲染层消费。
 *
 * 目录条目来自市场的 `loadRegistry()`，实测约 4183 条，字段比这里多得多；
 * 只声明我们用到的部分，避免把内部字段当成契约。
 */

/** 目录里的一个插件 */
export interface MarketPlugin {
  /**
   * 目录里的**短名**（通常等于仓库名），例如 `dsh-j-space`。
   * 注意它**不是** npm 包名 —— 那是下面的 `npm` 字段。
   */
  name: string
  owner: string
  /** 仓库地址 */
  url: string
  /** 市场的详情页 */
  page: string
  category: string[]
  /**
   * 市场给的多语言简介。实测形状是 `{ zh: '…', en: '…' }`，但也可能缺字段或是纯字符串
   * （目录是社区维护的，形状不保证统一），所以按最宽的情形声明，读取处再收窄。
   */
  description: Record<string, string> | string | null

  /* ---- 之前漏掉的字段（实测 4183 条全部携带；丢掉它们等于白拿数据） ---- */

  /**
   * 真正的 npm 包名，可能带 scope（`@anonyjcy/dsh-j-space`）。
   *
   * **「已装」判断必须用它**，不能用 `name`：目录里存在不同作者的同名短名
   * （实测 186 个短名重复，`dsh-pet` 就有两位作者各一份），按短名匹配会把别人的包也标成已装。
   */
  npm: string
  version: string
  /** GitHub 星数 */
  stars: number
  /** 区间下载量（统计窗口见 downloadsStart/End） */
  downloads: number
  /** 目录给出的现成安装命令，形如 `dsh plugin --profile web add <npm>` */
  install: string
  /** 收录日期 */
  added: string
  /** 截图地址；**只有 811/4183 条有**，其余要靠占位图 */
  screenshots: string[]
  /** 直装 tarball（302 条有） */
  tarball: string
}

export interface MarketCatalog {
  region: 'china' | 'global'
  /** 目录来源（诊断用，界面上不展示原始 URL） */
  source: string
  updated: string
  count: number
  plugins: MarketPlugin[]
}

/** 内置市场库的探测结果 */
export interface MarketCapabilities {
  available: boolean
  version: string
  root: string
  modules: Record<string, string[]>
  /** 期望存在但缺失的内部导出 —— 非空说明市场改了内部 API */
  missing: string[]
  error: string
}

/** 「更新自己」所需的数据 */
export interface MarketSelfUpdate {
  /** 内置版本 */
  bundled: string
  /** 市场判定的更新目标；受它的策略约束，可能为 null */
  target: string | null
  /** 裸查注册表的实际最新版，只用来解释"为什么市场说没有更新" */
  registryLatest: string | null
  errors: string[]
}
