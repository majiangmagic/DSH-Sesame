import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { MarketCatalog, MarketPlugin } from '@/api'
import { api } from '@/api'

/** 列表一页渲染多少行 —— 目录有四千余条，一次全渲染会把界面拖死 */
const PAGE_STEP = 120

/** 排序方式 */
export type MarketSort = 'default' | 'stars' | 'downloads' | 'name'

/**
 * 图片代理前缀。
 *
 * 写成**同源绝对路径**（页面在 `app://bundle`），所以不能带第二 host —— 实测
 * `app://img/…` 一律 0ms 失败，因为 Chromium 不把非 `bundle` host 的请求派发给自定义协议。
 * 服务端在 `src/main/imageProxy.ts`，路由见 `src/main/protocol.ts` 的 `IMAGE_PATH_PREFIX`。
 */
const IMAGE_PROXY = '/__img/?u='

/**
 * 「已装」判断用的标识：**优先真 npm 包名**（`plugin.npm`），没有才退回短名。
 *
 * 必须这样做的原因（实测）：目录里存在**不同作者的同名短名** —— 4183 行只有 3903 个不同短名，
 * 186 个重复；`dsh-pet` 就有 `ysyyhhh` 与 `zealot00` 两位作者各一份。
 * 按短名匹配会把别人那份也标成"已装"，而且把已装数量算多（曾经出现"已装 2 + 未收录 4 = 6 ≠ 5"）。
 * npm 包名是全球唯一的，用它才能唯一定位。
 */
export function identityOf(plugin: MarketPlugin): string {
  return plugin.npm !== '' ? plugin.npm : plugin.name
}

/** 取第一张可用的截图，包成图片代理地址；没有截图返回空串 */
export function thumbUrl(plugin: MarketPlugin): string {
  const first = (plugin.screenshots ?? []).find((url) => /^https:\/\//i.test(url))
  return first ? IMAGE_PROXY + encodeURIComponent(first) : ''
}

/** 没有截图时的占位：取作者名首字母（本地生成，不联网） */
export function initialOf(plugin: MarketPlugin): string {
  const source = plugin.owner || plugin.name
  return (source[0] ?? '?').toUpperCase()
}

/** 取插件的简介：优先中文，退回英文，都没有就空串 */
export function descriptionOf(plugin: MarketPlugin): string {
  const value = plugin.description
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return value.zh ?? value.en ?? Object.values(value)[0] ?? ''
}

/**
 * 插件市场。
 *
 * 数据来自**真实目录**（内置的 dshmarket 库 → `loadRegistry()`，实测约 4183 条）。
 * 界面需要三样东西，这里各管一样：
 *  - 目录本身（`catalog`）
 *  - profile 里已装了哪些（`installedNames`，来自真实的插件读取）
 *  - 搜索与分类筛选（`query` / `category`）
 *
 * 「已装」是拿**包名**对比得到的，不是目录里的字段 —— 目录不知道你的 profile 装了什么。
 */
export const useMarketStore = defineStore('market', () => {
  const catalog = ref<MarketCatalog | null>(null)
  const installedNames = ref<Set<string>>(new Set())
  /** npm 包名 → 已装版本。市场里的版本比它高，就是"有更新" */
  const installedVersions = ref<Map<string, string>>(new Map())
  const loading = ref(false)
  const error = ref('')

  const query = ref('')
  const category = ref('')
  const sort = ref<MarketSort>('stars')
  /** 正在安装或卸载的包名（两者不会同时发生，共用一个字段） */
  const busyName = ref<string | null>(null)
  /** 主进程推回来的进度文案（pnpm 的输出行） */
  const progressText = ref('')
  /** 当前渲染窗口大小，点「加载更多」时增长 */
  const pageSize = ref(PAGE_STEP)

  /** 是否已加载过（用于避免切页时重复拉目录） */
  const loaded = ref(false)

  const plugins = computed<MarketPlugin[]>(() => catalog.value?.plugins ?? [])
  const total = computed(() => plugins.value.length)

  /**
   * 每个**标识**（npm 包名）在目录里出现几次。
   *
   * 用来发现真正的同名冲突 —— 界面要把这件事说出来，否则"两行都标已装"看起来像 bug。
   */
  const identityCounts = computed(() => {
    const counts = new Map<string, number>()
    for (const plugin of plugins.value) {
      const id = identityOf(plugin)
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  })

  /** 短名重复的包名个数（用于底部说明） */
  const duplicateNameCount = computed(() => {
    const counts = new Map<string, number>()
    for (const plugin of plugins.value) counts.set(plugin.name, (counts.get(plugin.name) ?? 0) + 1)
    let n = 0
    for (const count of counts.values()) if (count > 1) n += 1
    return n
  })

  /**
   * 已装数量：按**不同标识**数，不是按目录行数。
   * （曾经的 bug：遍历目录行去数命中，同名两行就被数成 2 个。）
   */
  const installedCount = computed(() => {
    const inCatalog = new Set(plugins.value.map(identityOf))
    let n = 0
    for (const name of installedNames.value) if (inCatalog.has(name)) n += 1
    return n
  })

  /** 从插件自身汇总分类及数量（目录另有 categories 字段，形状不保证，自己算更稳） */
  const categories = computed(() => {
    const counts = new Map<string, number>()
    for (const plugin of plugins.value) {
      for (const name of plugin.category ?? []) {
        if (!name) continue
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  })

  /**
   * 已装、但**不在目录里**的插件。
   *
   * 需要在界面上说出来：市场页只列目录收录的东西，所以"已装 N 个"永远小于 profile 里的实际数量，
   * 不解释的话看起来像漏算（实测：装了 5 个，目录只收录 2 个）。
   */
  const unlistedInstalled = computed(() => {
    const inCatalog = new Set(plugins.value.map(identityOf))
    return [...installedNames.value].filter((name) => !inCatalog.has(name)).sort()
  })

  /** 搜索 + 分类筛选后的结果 */
  const filtered = computed<MarketPlugin[]>(() => {
    const needle = query.value.trim().toLowerCase()
    const picked = category.value
    const list = plugins.value.filter((plugin) => {
      if (picked !== '' && !(plugin.category ?? []).includes(picked)) return false
      if (needle === '') return true
      // 名称、作者与简介都参与匹配：目录里中文简介往往比包名更好搜
      return (
        plugin.name.toLowerCase().includes(needle) ||
        (plugin.owner ?? '').toLowerCase().includes(needle) ||
        descriptionOf(plugin).toLowerCase().includes(needle)
      )
    })
    // 排序：目录顺序大致是收录顺序，未必好找；星数与下载量是目录自带的两个客观指标
    if (sort.value === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name))
    if (sort.value === 'stars') return [...list].sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name))
    if (sort.value === 'downloads') {
      return [...list].sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name))
    }
    return list
  })

  /** 实际渲染的那一窗 —— 其余靠「加载更多」逐页展开，不做虚拟滚动 */
  const visible = computed(() => filtered.value.slice(0, pageSize.value))
  /** 因超出当前窗口而未渲染的条数 */
  const hidden = computed(() => Math.max(0, filtered.value.length - pageSize.value))
  const canLoadMore = computed(() => hidden.value > 0)

  async function load(force = false): Promise<void> {
    if (loading.value) return
    if (loaded.value && !force) return
    loading.value = true
    error.value = ''
    try {
      const [cat, plugins] = await Promise.all([api.getMarketCatalog('china'), api.getPlugins()])
      catalog.value = cat
      installedNames.value = new Set(plugins.plugins.map((plugin) => plugin.name))
      installedVersions.value = new Map(plugins.plugins.map((plugin) => [plugin.name, plugin.version]))
      loaded.value = true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  function setQuery(value: string): void {
    query.value = value
    // 换筛选条件就回到第一页，否则会停在"上一轮的窗口大小"上
    pageSize.value = PAGE_STEP
  }

  function setCategory(value: string): void {
    category.value = value
    pageSize.value = PAGE_STEP
  }

  function setSort(value: MarketSort): void {
    sort.value = value
    pageSize.value = PAGE_STEP
  }

  function loadMore(): void {
    pageSize.value += PAGE_STEP
  }

  /** 「已装」按 npm 包名判断（见 identityOf 的说明） */
  function isInstalled(plugin: MarketPlugin): boolean {
    return installedNames.value.has(identityOf(plugin))
  }

  /**
   * 比较两个版本号。只认数字段，够用即可 —— 这里只回答"目录里的是不是更新"。
   * 返回 >0 表示 a 更新。不处理 pre-release 的复杂排序（目录里的 version 基本是正式版）。
   */
  function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0)
    const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  }

  /**
   * 有更新时返回目标版本号，否则返回空串。
   *
   * 只在**两边都能比**的时候给答案：没装过、目录没给版本、目录的 version 不是数字开头
   * （比如某些条目写的是范围或占位）—— 一律返回空串，不猜。
   */
  function updateTarget(plugin: MarketPlugin): string {
    const current = installedVersions.value.get(identityOf(plugin))
    if (!current) return ''
    const latest = String(plugin.version ?? '').trim()
    if (!/^\d/.test(latest)) return ''
    return compareVersions(latest, current) > 0 ? latest : ''
  }

  /** 这个标识在目录里有几个条目（>1 表示确实撞了） */
  function sameIdentityCount(plugin: MarketPlugin): number {
    return identityCounts.value.get(identityOf(plugin)) ?? 1
  }

  /**
   * 安装一个插件。
   *
   * 走 dsh 自己的插件命令（`dsh plugin --profile <name> add <pkg>` → pnpm），
   * **不是**我们自己 npm install —— profile 用的是 pnpm 布局，混用会把依赖树搞坏。
   */
  async function install(name: string): Promise<void> {
    if (busyName.value !== null) return
    busyName.value = name
    progressText.value = ''
    error.value = ''
    try {
      await api.installPlugin(name, (progress) => {
        progressText.value = progress.text
      })
      await load(true)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busyName.value = null
      progressText.value = ''
    }
  }

  /**
   * 更新一个插件到指定版本。
   *
   * 与安装同一个通道（`add <包>@<版本>`），所以同样用 busyName 表示"这个包正在被改动"。
   * 目标版本由 `updateTarget` 从目录里取，不在这里自己判断"哪个是最新"。
   */
  async function update(name: string, target: string): Promise<void> {
    if (busyName.value !== null) return
    busyName.value = name
    progressText.value = ''
    error.value = ''
    try {
      await api.updatePlugin(name, target, (progress) => {
        progressText.value = progress.text
      })
      await load(true)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busyName.value = null
      progressText.value = ''
    }
  }

  /**
   * 卸载一个插件。
   *
   * 入参是**真 npm 包名**（`identityOf`），不是目录短名。
   * `busyName`（原 `installing`）同时用于安装和卸载 —— 它表达的是"这个包正在被改动"，
   * 两种操作不会同时发生，共用一个字段就够了。
   */
  async function uninstall(name: string): Promise<void> {
    if (busyName.value !== null) return
    busyName.value = name
    progressText.value = ''
    error.value = ''
    try {
      await api.uninstallPlugin(name, (progress) => {
        progressText.value = progress.text
      })
      await load(true)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busyName.value = null
      progressText.value = ''
    }
  }

  return {
    catalog,
    loading,
    loaded,
    error,
    query,
    category,
    sort,    updateTarget,    update,
    busyName,
    progressText,
    plugins,
    total,
    installedCount,
    identityCounts,
    duplicateNameCount,
    categories,
    unlistedInstalled,
    filtered,
    visible,
    hidden,
    canLoadMore,
    load,
    setQuery,
    setCategory,
    setSort,
    loadMore,
    isInstalled,
    sameIdentityCount,
    install,
    uninstall
  }
})
