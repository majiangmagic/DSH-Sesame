import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { registryUrl } from '../../infrastructure/registry'

/**
 * 把 dshmarket 当**库**调用。
 *
 * 为什么走这条路（而不是嵌它的界面）：
 *  - 它的界面是 dsh 的客户端插件，依赖 `window.__ModuleLoader__` + React + dsh 的 ui-primitives，
 *    并注册进 dsh 的 slot 系统，**没有独立挂载点**，搬不出来；
 *  - 而它的 `lib/` 是**纯 Node 库**：实测 0 处 `import @deepseek-ai/*`，只依赖 `undici` + `js-yaml`。
 *    所以能在启动器主进程里直接跑，**不需要 dsh 在跑** —— 全新安装、一个版本都没有时照样能用。
 *
 * 这样拿到的是"市场的真算法"（安装、更新、快照回滚、兼容性判定），界面由我们自己写。
 *
 * ⚠️ **已知风险，必须记住**：
 *  1. `lib/*` 是**内部实现，没有任何稳定性承诺**（只有 `update-api-v1` 那个 HTTP 接口承诺 beta，
 *     而它需要 dsh 在跑，我们用不了）。市场升级可能改函数签名 —— 所以下面所有调用都先**探测**，
 *     缺什么就禁用对应能力并如实上报，**不让它把整个应用打挂**；
 *  2. `exports` 只暴露了 `.` / `./update-api-v1` / `./client` / `./package.json`，
 *     `./lib/*` **不在其中**。所以只能先 resolve 包目录，再用**绝对路径** require 子模块。
 *     这是在用它没承诺导出的路径，属于上面第 1 条风险的一部分。
 */

/** 载入后能用什么。探测结果如实反映，界面据此隐藏做不到的功能。 */
export interface MarketCapabilities {
  /** 包是否载入成功 */
  available: boolean
  version: string
  /** 包目录（诊断用） */
  root: string
  /** 各模块实际导出的名字，用于确认内部 API 没变 */
  modules: Record<string, string[]>
  /** 期望存在但缺失的导出，形如 `registry.loadRegistry` */
  missing: string[]
  error: string
}

export type MarketRegion = 'global' | 'china'

/** 目录里一个插件条目（只列我们用到的字段）。 */
export interface MarketPlugin {
  name: string
  owner: string
  url: string
  page: string
  category: string[]
  description: Record<string, string> | string | null
  /** 真正的 npm 包名（可能带 scope）——「已装」判断要用它 */
  npm: string
  version: string
  stars: number
  downloads: number
  install: string
  added: string
  screenshots: string[]
  tarball: string
}

export interface MarketCatalog {
  region: MarketRegion
  source: string
  updated: string
  count: number
  categories: unknown
  plugins: MarketPlugin[]
}

export type { MarketCatalog as MarketCatalogResult }

/**
 * 期望的内部导出。
 *
 * 这张表就是"我们依赖了市场内部 API"的清单 —— 它是**故意的**，因为探测要有个基准。
 * 市场升级后如果这里出现 missing，说明内部 API 变了，对应能力必须降级，而不是崩。
 */
const REQUIRED: Record<string, string[]> = {
  profile: ['profileDir', 'readManifestDeps', 'readInstalled', 'readProfileBundles'],
  registry: ['loadRegistry'],
  updates: ['fetchNpmLatest', 'checkUpdates'],
  compatibility: ['assessProfile'],
  snapshot: ['createProfileSnapshot', 'listSnapshots', 'restoreSnapshot'],
  /**
   * 区域路由。用途见 imageProxy：目录里的截图全指向 `raw.githubusercontent.com`，
   * **实测国内直连不通**，必须按市场配置的代理路由改写。
   */
  regions: ['githubRoutesFor', 'activeRegion']
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 市场内部模块没有类型保证，边界处收到 any 后立刻收窄 */
type AnyModule = Record<string, any>

interface MarketHandle {
  capabilities: MarketCapabilities
  modules: Record<string, AnyModule>
}

let cached: MarketHandle | null = null

function resolveMarketRoot(require_: NodeJS.Require): string {
  // `./package.json` 在 exports 里，所以这一步是正规解析；lib/* 不在，只能自己拼绝对路径
  return dirname(require_.resolve('dshmarket/package.json'))
}

/**
 * 载入内置的市场库并探测能力。结果缓存 —— 载入是同步的，但没必要每次 IPC 都做一遍。
 *
 * **任何失败都不抛**：返回 `available: false` 并带上原因，界面照常能用其它功能。
 */
export function loadMarket(): MarketHandle {
  if (cached) return cached

  const capabilities: MarketCapabilities = {
    available: false,
    version: '',
    root: '',
    modules: {},
    missing: [],
    error: ''
  }
  const modules: Record<string, AnyModule> = {}

  try {
    const require_ = createRequire(import.meta.url)
    const root = resolveMarketRoot(require_)
    capabilities.root = root
    capabilities.version = String((require_(join(root, 'package.json')) as { version?: string }).version ?? '')

    for (const [name, expected] of Object.entries(REQUIRED)) {
      let mod: AnyModule
      try {
        mod = require_(join(root, 'lib', `${name}.js`)) as AnyModule
      } catch (error) {
        capabilities.missing.push(...expected.map((fn) => `${name}.${fn}`))
        capabilities.error = `${name}.js 载入失败：${error instanceof Error ? error.message : String(error)}`
        continue
      }
      modules[name] = mod
      capabilities.modules[name] = Object.keys(mod)
      for (const fn of expected) {
        if (typeof mod[fn] !== 'function') capabilities.missing.push(`${name}.${fn}`)
      }
    }

    // 只要最核心的目录能力在，就认为可用；其余缺失由 missing 反映
    capabilities.available = typeof modules.registry?.loadRegistry === 'function'
    if (!capabilities.available && capabilities.error === '') {
      capabilities.error = '市场的 registry 模块不可用'
    }
  } catch (error) {
    capabilities.error = error instanceof Error ? error.message : String(error)
  }

  cached = { capabilities, modules }
  return cached
}

/** 读插件目录。
 * @throws 目录能力缺失时抛出可读错误（界面据此提示，不是静默空列表）
 */
export async function loadCatalog(region: MarketRegion = 'china'): Promise<MarketCatalog> {
  const handle = loadMarket()
  const fn = handle.modules.registry?.loadRegistry
  if (typeof fn !== 'function') {
    throw new Error(`市场的目录能力不可用：${handle.capabilities.error || 'loadRegistry 缺失'}`)
  }
  const raw = (await fn(region)) as {
    url?: string
    source?: string
    updated?: string
    count?: number
    categories?: unknown
    plugins?: Array<Record<string, unknown>>
  }
  const rows = Array.isArray(raw?.plugins) ? raw.plugins : []

  /**
   * 收窄成界面要用的形状。
   *
   * 这里**逐个字段显式取值**而不是把整条 loadRegistry 的结果透传给渲染层：
   * 那些对象是市场内部结构的投影，透传等于让界面依赖我们没有承诺过的字段。
   * 显式列出来的代价是市场新增字段时要改这里，但那正是"知道自己在依赖什么"。
   */
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
  const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const asStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

  const plugins: MarketPlugin[] = rows.map((row) => ({
    name: asString(row.name),
    owner: asString(row.owner),
    url: asString(row.url),
    page: asString(row.page),
    category: asStringArray(row.category),
    description: (row.description ?? null) as MarketPlugin['description'],
    npm: asString(row.npm),
    version: asString(row.version),
    stars: asNumber(row.stars),
    downloads: asNumber(row.downloads),
    install: asString(row.install),
    added: asString(row.added),
    screenshots: asStringArray(row.screenshots),
    tarball: asString(row.tarball)
  }))

  return {
    region,
    source: String(raw?.source ?? ''),
    updated: String(raw?.updated ?? ''),
    count: typeof raw?.count === 'number' ? raw.count : plugins.length,
    categories: raw?.categories ?? null,
    plugins
  }
}

/**
 * 查市场的更新目标 —— **以市场的判断为准**。
 *
 * 顺序很重要，不能反：
 *  1. **先问市场**（`updates.fetchNpmLatest`）。它带**发布冷却策略**：实测 `dshmarket@1.58.0`
 *     发布于 12 小时前，市场返回 null —— 因为它在 24 小时 release-age 窗口内
 *     （`UPDATE-API-V1.md` 的 `RELEASE_TOO_FRESH` / "release-age wait"）。
 *     若让裸 fetch 优先，启动器就会推荐市场自己判定"太新"的版本，**违背"与市场逻辑一致"**。
 *  2. **再用裸 fetch 做解释**。市场函数把异常和"太新"都压成 null，界面无法区分。裸注册表查询
 *     能补上这一层：于是能给用户"注册表已有 1.58.0，但市场认为发布太新，冷却中"这种市场自己
 *     都说不清的提示 —— 这是启动器相对市场的**增量价值**，不是绕过它。
 */
export async function checkMarketUpdate(
  packageName: string
): Promise<{ target: string | null; registryLatest: string | null; errors: string[] }> {
  const errors: string[] = []
  let target: string | null = null

  // 1. 市场说了算
  const handle = loadMarket()
  const fn = handle.modules.updates?.fetchNpmLatest
  if (typeof fn === 'function') {
    try {
      const value = await fn(packageName)
      if (typeof value === 'string' && value !== '') target = value
    } catch (error) {
      errors.push(`市场的 fetchNpmLatest：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    errors.push('市场的 fetchNpmLatest 缺失')
  }

  // 2. 裸查询只做解释（注册表实际有什么）
  let registryLatest: string | null = null
  try {
    const res = await fetch(`${registryUrl()}/${encodeURIComponent(packageName)}/latest`, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-sesame/0.1.0' }
    })
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown }
      if (typeof body.version === 'string' && body.version !== '') registryLatest = body.version
      else errors.push('自有 fetch：响应里没有 version 字段')
    } else {
      errors.push(`自有 fetch：HTTP ${res.status}`)
    }
  } catch (error) {
    errors.push(`自有 fetch：${error instanceof Error ? error.message : String(error)}`)
  }

  return { target, registryLatest, errors }
}

/** 兼容性评估：拿 profile 里真实装的插件与 peer 范围比对。 */
export function assessProfile(profile = 'web'): unknown {
  const handle = loadMarket()
  const fn = handle.modules.compatibility?.assessProfile
  if (typeof fn !== 'function') {
    throw new Error(`市场的兼容性能力不可用：${handle.capabilities.error || 'assessProfile 缺失'}`)
  }
  return fn(profile)
}

/** 列出 profile 的快照（市场自己的快照机制，用于更新前回滚）。 */
export function listSnapshots(profileDirectory: string): unknown {
  const handle = loadMarket()
  const fn = handle.modules.snapshot?.listSnapshots
  if (typeof fn !== 'function') return []
  return fn(profileDirectory)
}
