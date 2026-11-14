import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { MarketCatalog, MarketPlugin, PluginEntry } from '@/api'
import { api } from '@/api'
import { compareVersionStrings } from '@utils/version'
import {
  resolveInstallTarget,
  specMatchesTarget,
  type InstallTarget
} from '@utils/pluginTarget'

/** 列表一页渲染多少行 —— 目录有四千余条，一次全渲染会把界面拖死 */
const PAGE_STEP = 120

/** 排序方式 */
export type MarketSort = 'default' | 'stars' | 'downloads' | 'name'

/**
 * 图片代理前缀。
 *
 * 写成**同源绝对路径**（页面在 `app://bundle`），所以不能带第二 host —— 实测
 * `app://img/…` 一律 0ms 失败，因为 Chromium 不把非 `bundle` host 的请求派发给自定义协议。
 * 服务端在 `src/main/platform/imageProxy.ts`，路由见 `src/main/platform/protocol.ts` 的 `IMAGE_PATH_PREFIX`。
 */
const IMAGE_PROXY = '/__img/?u='

/**
 * 「身份」：这条目录记录**唯一**代表哪个东西。
 *
 * 三层，逐层更弱但都保证唯一：
 *   ① npm 包名 —— 全局唯一，最可靠
 *   ② 仓库归属 `repo:owner/repo` —— 目录里一半条目没有 npm 字段，靠它区分
 *   ③ `name@owner` —— 连仓库地址都没有时的兜底（那类条目本来也装不了）
 *
 * 必须唯一：历史上用"短名"当身份，4183 行只有 3903 个不同短名、186 个重复，
 * `dsh-pet` 就有两位作者各一份 —— 结果"已装"判定把别人的包也算了进去，
 * 已装数量还算多了（曾经出现"已装 2 + 未收录 4 = 6 ≠ 5"）。
 *
 * ⚠️ 它**不是**安装目标。装什么由 `installTargetOf()` 决定 —— 两个概念曾经混在同一个
 * 函数里，结果"修撞名 bug"顺手把 5239 条只有 GitHub 的记录锁死了（无法安装）。
 */
export function identityOf(plugin: MarketPlugin): string {
  const npm = (plugin.npm ?? '').trim()
  if (npm !== '') return npm
  const target = installTargetOf(plugin)
  if (target !== null && target.repo !== null) return `repo:${target.repo}`
  return `${plugin.name}@${plugin.owner}`
}

/**
 * 「安装目标」：真正传给 `dsh plugin add` 的那串东西。
 *
 * 三段式，与 dsh 自己的市场一致（`dshmarket/lib/sources.js` 的 `installTargetFor`）：
 * npm 包名 → 同仓库的 Release 产物 → `github:owner/repo`（子包带 `#path:`）。
 *
 * @returns 装不了时返回 null（`url` 不是 GitHub 仓库，且没有合法的 npm 名）
 */
export function installTargetOf(plugin: MarketPlugin): InstallTarget | null {
  return resolveInstallTarget({
    npm: plugin.npm,
    url: plugin.url,
    tarball: plugin.tarball
  })
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
  /**
   * 只看已装。
   *
   * 市场有四千多条且**默认按星数降序**，而已装的包星数往往不高 —— 不加这个筛选，
   * 用户自己的插件会沉到几十上百位之后，"更新"按钮等于够不着。
   */
  const onlyInstalled = ref(false)
  /**
   * 正在安装 / 卸载 / 更新的**安装目标**集合。
   *
   * 曾经是单个 `string | null`，并且"忙就 return" —— 一个安装跑着的时候，别的插件
   * 点了也**没有任何反应**（点击被丢弃），观感像"整页锁死、只能等"。
   * 现在：按目标记住哪些行在忙，点击**排队**（真正的互斥在主进程的 `withPluginWriteLock`），
   * 界面只禁用正在跑的那一行。
   */
  const busyTargets = ref<Set<string>>(new Set())
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
   * 已被目录**认领**的已装插件名。
   *
   * 这是「已装 N 个」与「未被目录收录」两个统计的唯一依据，判据与 `isInstalled` 同源：
   *   · npm 条目 → 目录的 npm 名就是已装包名
   *   · 只有 GitHub 的条目 → 反查 profile 里哪个依赖的规格串指向那个仓库
   *
   * 之前这里拿"已装包名"去撞 `identityOf`（npm 名）。对 `npm` 为空的目录条目（占目录
   * 一半）永远撞不上 —— 于是从 GitHub Release 装的插件（例如
   * `dsh-purge-community`，目录里的名字叫 `dsh-purge`）被误报成"未被目录收录"。
   */
  const claimedNames = computed(() => {
    const claimed = new Set<string>()
    for (const plugin of plugins.value) {
      if (!isInstalled(plugin)) continue
      const target = installTargetOf(plugin)
      if (target === null) continue
      const name = installedNameFor(target)
      // 统一小写：`installedNames` 也是小写，两边必须同一种写法，
      // 否则名字带大写的插件（目录里确有 `DSH-better-sidebar`）会被误报成"未被目录收录"
      if (name !== '') claimed.add(name.toLowerCase())
    }
    return claimed
  })

  /**
   * 已装数量：按**被目录认领的插件**数，不是按目录行数。
   * （曾经的 bug：遍历目录行去数命中，同名两行就被数成 2 个。）
   */
  const installedCount = computed(() => claimedNames.value.size)

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
   * 已装、但**目录里确实没有**的插件。
   *
   * 需要在界面上说出来：市场页只列目录收录的东西，所以"已装 N 个"可能小于 profile 里的
   * 实际数量，不解释的话看起来像漏算。
   *
   * ⚠️ 判据必须是 `claimedNames`（与 isInstalled 同源），不能拿包名去撞 npm 名 ——
   * 那会把所有 git 来源的插件都误报成"未收录"。
   */
  const unlistedInstalled = computed(() =>
    [...installedNames.value].filter((name) => !claimedNames.value.has(name)).sort()
  )

  /** 搜索 + 分类筛选后的结果 */
  const filtered = computed<MarketPlugin[]>(() => {
    const needle = query.value.trim().toLowerCase()
    const picked = category.value
    const list = plugins.value.filter((plugin) => {
      // 「只看已装」必须与 isInstalled 用**同一套判定**（曾经两处不一致 → 实测仍是 6 行）
      if (onlyInstalled.value && !isInstalled(plugin)) return false
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
      installedNames.value = new Set(plugins.plugins.map((plugin) => plugin.name.toLowerCase()))
      installedVersions.value = new Map(plugins.plugins.map((plugin) => [plugin.name.toLowerCase(), plugin.version]))
      installedPlugins.value = plugins.plugins
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

  /** 切换"只看已装"。换筛选条件要回到第一页，否则会停在上一轮的窗口大小上 */
  function setOnlyInstalled(value: boolean): void {
    onlyInstalled.value = value
    pageSize.value = PAGE_STEP
  }

  function loadMore(): void {
    pageSize.value += PAGE_STEP
  }

  /**
   * 已装插件的完整清单（`name` / `version` / `spec`）。
   *
   * 只有 GitHub 的目录记录要靠 `spec` 认领 —— 装完后 key 是包自己的 name，
   * 与目录里的短名无关，只能比对规格串里的仓库归属。
   */
  const installedPlugins = ref<PluginEntry[]>([])

  /** 这条记录**能不能从市场安装**（判据是"有没有安装目标"，不是"有没有 npm 名"） */
  function installable(plugin: MarketPlugin): boolean {
    return installTargetOf(plugin) !== null
  }

  /**
   * 「已装」两条判据，缺一不可：
   *   · npm 条目 → profile 里有同名依赖（包名全局唯一，最可靠）
   *   · 只有 GitHub 的条目 → 已装依赖的**规格串**指向同一个仓库
   *     （装完后 pnpm 写的 key 是包自己的 name，与目录里的短名对不上）
   */
  function isInstalled(plugin: MarketPlugin): boolean {
    const target = installTargetOf(plugin)
    if (target === null) return false
    if (target.kind === 'npm') return installedNames.value.has(target.target.toLowerCase())
    return installedPlugins.value.some((item) => specMatchesTarget(item.spec, target))
  }

  /**
   * 已装依赖里对应这个安装目标的那一条的**名字**（卸载要用）。
   *
   * @returns 没装过时返回空串
   */
  function installedNameFor(target: InstallTarget): string {
    if (target.kind === 'npm') {
      const key = target.target.toLowerCase()
      if (!installedNames.value.has(key)) return ''
      // 必须返回 **profile 里的原始大小写**：卸载命令要拿它去 pnpm remove，
      // 而目录里的写法可能和已装的不一致（目录里确有 `DSH-better-sidebar` 这种）。
      return installedPlugins.value.find((item) => item.name.toLowerCase() === key)?.name ?? target.target
    }
    const hit = installedPlugins.value.find((plugin) => specMatchesTarget(plugin.spec, target))
    return hit === undefined ? '' : hit.name
  }

  /**
   * 行上显示的**版本文案**（自带 `v` 前缀）。
   *
   * 三种情况，顺序不能反：
   *   ① 已装且有更新 → `v0.4.4 → v0.4.6`（一眼看出"现在是什么、能升到什么"）
   *   ② 已装、无更新 → `v0.4.4`（**已装版本**，不是目录版本）
   *   ③ 未装 → 目录里的版本
   *
   * 之前这里优先用目录版本，于是已装插件的行显示的是"最新版"，而更新按钮也说同一个
   * 数字 —— 看起来像"更新到一模一样的版本"。实际上装的是旧的，只是没显示出来。
   */
  function versionLabel(plugin: MarketPlugin): string {
    const installed = installedVersionOf(plugin)
    const target = updateTarget(plugin)
    if (installed !== '' && target !== '') return `v${installed} → v${target}`
    if (installed !== '') return `v${installed}`
    const fromCatalog = String(plugin.version ?? '').trim()
    return fromCatalog === '' ? '' : `v${fromCatalog}`
  }

  /** 这条记录在「已装」里的显示版本；只有 GitHub 的条目目录不给版本，回落到已装版本 */
  function installedVersionOf(plugin: MarketPlugin): string {
    const target = installTargetOf(plugin)
    if (target === null) return ''
    if (target.kind === 'npm') return installedVersions.value.get(target.target.toLowerCase()) ?? ''
    const hit = installedPlugins.value.find((item) => specMatchesTarget(item.spec, target))
    return hit === undefined ? '' : hit.version
  }

  /**
   * 有更新时返回目标版本号，否则返回空串。
   *
   * 只在**两边都能比**的时候给答案：没装过、目录没给版本、目录的 version 不是版本号形状
   * （比如某些条目写的是范围或占位）—— 一律返回空串，不猜。
   *
   * 只有 npm 条目有版本语义：git / tarball 来源的"更新"取决于仓库的 commit，
   * 目录不提供可比版本，硬给按钮只会装成同一份。这类要更新请用卸载再安装。
   *
   * 比较用 `@utils/version`（与主进程**同一份**实现）。这里原先是个"只比数字段"的
   * 简化版，注释还写着"目录里的 version 基本是正式版" —— 但 dsh 的新版本常常只挂在
   * alpha / next 上，那个简化版会把 `0.2.0-rc.2` 判成比 `0.2.0` 新（其实更旧），
   * 于是界面会推一个降级。
   */
  function updateTarget(plugin: MarketPlugin): string {
    const target = installTargetOf(plugin)
    if (target === null || target.kind !== 'npm') return ''
    const current = installedVersions.value.get(target.target.toLowerCase())
    if (!current) return ''
    const latest = String(plugin.version ?? '').trim()
    const diff = compareVersionStrings(latest, current)
    return diff !== null && diff > 0 ? latest : ''
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
  /**
   * 结果提示的存活时间。
   *
   * 这个功能的两次修正值得记下来：最初在 finally 里直接清空 → 用户**永远看不到**
   * "成功还是失败"；改成不清 → 提示**永远挂在页面上**（"dshmarket 已更新到 1.61.0"
   * 一直显示）。现在折中：显示够看清，然后自己消失。
   * 错误留得久一些（要读、要照做），成功短一些。完整输出在终端页里始终可查。
   */
  const RESULT_TTL_MS = 8000
  const ERROR_TTL_MS = 20000
  let resultTimer: ReturnType<typeof setTimeout> | null = null

  function cancelResultClear(): void {
    if (resultTimer !== null) {
      clearTimeout(resultTimer)
      resultTimer = null
    }
  }

  /** 操作结束后调用：延时把提示收掉。错误留得比成功久。 */
  function scheduleResultClear(): void {
    cancelResultClear()
    const delay = error.value === '' ? RESULT_TTL_MS : ERROR_TTL_MS
    resultTimer = setTimeout(() => {
      resultTimer = null
      progressText.value = ''
      error.value = ''
    }, delay)
  }

  /** 这条目录记录是否正在被改动（只有它会被禁用） */
  function busyFor(plugin: MarketPlugin): boolean {
    const target = installTargetOf(plugin)
    return target === null ? false : busyTargets.value.has(target.target)
  }

  /** 是否有任何一条在改动（用于列表整体的淡化效果，不影响可点） */
  const anyBusy = computed(() => busyTargets.value.size > 0)

  /**
   * 安装一条目录记录。
   *
   * 入参是**目录条目本身**，不是预先算好的字符串 —— 安装目标的三段式解析
   * （npm / Release 产物 / github:owner/repo）在 `installTargetOf` 里做一次，
   * 按钮标题与真正执行的内容必然一致。
   *
   * 忙的时候**不丢弃点击**：调用会排进主进程的串行队列，界面只是把这一行标成"安装中"。
   */
  async function install(plugin: MarketPlugin): Promise<void> {
    const target = installTargetOf(plugin)
    if (target === null) {
      error.value = `${plugin.name} 没有可用的安装来源（既没有 npm 包名，也没有 GitHub 仓库地址）`
      scheduleResultClear()
      return
    }
    // 同一目标重复点击才忽略（避免重复排队）；不同目标各自排队，互不影响
    if (busyTargets.value.has(target.target)) return
    busyTargets.value.add(target.target)
    cancelResultClear()
    progressText.value = ''
    error.value = ''
    try {
      await api.installPlugin(target.target, (progress) => {
        progressText.value = progress.text
      })
      await load(true)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busyTargets.value.delete(target.target)
      scheduleResultClear()
    }
  }

  /**
   * 把一个已装插件更新到指定版本。
   *
   * 与安装同一个通道（`add <包>@<版本>`），目标版本由 `updateTarget` 从目录里取，
   * 不在这里自己判断"哪个是最新"。忙的时候排队，不丢弃点击。
   */
  async function update(name: string, target: string): Promise<void> {
    if (busyTargets.value.has(name)) return
    busyTargets.value.add(name)
    cancelResultClear()
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
      busyTargets.value.delete(name)
      scheduleResultClear()
    }
  }

  /**
   * 卸载一条目录记录对应的插件（**先把条目解析成真实的依赖名**）。
   *
   * npm 条目直接用包名；只有 GitHub 的条目要反查 profile 里哪个依赖的规格串指向它 ——
   * 装完之后 pnpm 写的 key 是包自己的 name，与目录里的短名无关。
   */
  async function uninstall(plugin: MarketPlugin): Promise<void> {
    const target = installTargetOf(plugin)
    const name = target === null ? '' : installedNameFor(target)
    if (name === '') {
      error.value = `${plugin.name} 不在已装依赖里，无法卸载`
      scheduleResultClear()
      return
    }
    if (busyTargets.value.has(target?.target ?? name)) return
    busyTargets.value.add(target?.target ?? name)
    cancelResultClear()
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
      busyTargets.value.delete(target?.target ?? name)
      scheduleResultClear()
    }
  }

  return {
    catalog,
    loading,
    loaded,
    error,
    query,
    category,
    sort,
    updateTarget,
    update,
    onlyInstalled,
    setOnlyInstalled,
    busyTargets,
    busyFor,
    anyBusy,
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
    installable,
    installTargetOf,
    installedVersionOf,
    versionLabel,
    sameIdentityCount,
    install,
    uninstall
  }
})
