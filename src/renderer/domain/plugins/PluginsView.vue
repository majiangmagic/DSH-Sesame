<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  descriptionOf,
  identityOf,
  initialOf,
  thumbUrl,
  useMarketStore,
  type MarketSort
} from '@/domain/plugins/stores/market'
import type { MarketPlugin } from '@/api'

/**
 * 插件市场（原版这一页只是"插件开关"列表，本页是 DSH-Sesame 的新增）。
 *
 * 数据是**真实目录**：内置的 dshmarket 库 → `loadRegistry()`，实测约 4183 条。
 * 目录每条带 17 个字段，这里用到了：短名 / 作者 / 仓库 / 市场页 / 分类 / 中英简介 /
 * **npm 包名** / 版本 / 星数 / 下载量 / 安装命令 / 截图。**不需要 dsh 在跑。**
 *
 * 两个必须记住的坑：
 *  1. 「已装」要用 **npm 包名**判断，不能用短名 —— 目录里存在不同作者的同名短名
 *     （4183 行只有 3903 个不同短名，`dsh-pet` 有两位作者各一份）。见 `identityOf`。
 *  2. 截图要走 **`app://img`** 主进程代理 —— 实测渲染层发不出任何远程请求。见 `thumbUrl`。
 */
const { t } = useI18n()
const market = useMarketStore()

/**
 * 缩略图加载失败的时间戳（URL → 失败时刻）。
 *
 * **必须限时，不能永久黑名单**：实测这些 GitHub 代理时通时不通，一次抖动就把缩略图
 * 永久换成占位图，直到重启应用 —— 那是我第一版的做法，属于真 UX 缺陷。
 * 现在超过 TTL 就允许重试（`thumb()` 里只读判断，不在渲染中改动响应式数据，避免渲染循环）。
 */
const brokenThumbs = reactive(new Map<string, number>())
const BROKEN_TTL_MS = 60_000

const subtitle = computed(() => {
  if (market.loading && !market.loaded) return ''
  return t('market.subtitle', { total: market.total, installed: market.installedCount })
})

const shown = computed(() =>
  t('market.showing', { shown: market.visible.length, matched: market.filtered.length })
)

/** 排序按钮文案：循环 目录顺序 → 星数 → 下载量 → 名称 */
const SORT_KEY: Record<MarketSort, string> = {
  default: 'market.sortDefault',
  stars: 'market.sortStars',
  downloads: 'market.sortDownloads',
  name: 'market.sortName'
}
const SORT_ORDER: MarketSort[] = ['default', 'stars', 'downloads', 'name']
const sortLabel = computed(() => t(SORT_KEY[market.sort]))

function cycleSort(): void {
  const next = SORT_ORDER[(SORT_ORDER.indexOf(market.sort) + 1) % SORT_ORDER.length]
  market.setSort(next as MarketSort)
}

function clearFilters(): void {
  market.setQuery('')
  market.setCategory('')
}

/** 在系统浏览器里打开链接。模板里拿不到 `window`，所以包一层 setup 函数。 */
function openLink(url: string): void {
  if (url) void window.sesame.openExternal(url)
}

/** 分类切换后把选中的那颗滚进视野 —— 分类条是横向滚动的，靠后的分类点不到也看不见 */
function pickCategory(name: string, event: MouseEvent): void {
  /*
   * 点**已选中**的分类 = 取消它（等同于点「全部」）。
   *
   * 原来是直接 `setCategory(name)` —— 只会"设"不会"清"：选中一个分类之后就没办法
   * 取消，只能换成另一个、或者去点「全部」。而旁边的「已装」是
   * `setOnlyInstalled(!…)`，能直接点掉 —— 两者行为不一致，会被当成坏掉。
   * 传 `''`（「全部」那颗 chip）时这个表达式仍然得到 `''`，行为不变。
   */
  market.setCategory(market.category === name ? '' : name)
  ;(event.currentTarget as HTMLElement | null)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/** 缩略图地址；没有截图，或最近一次失败尚未过期时返回空串，交给字母占位 */
function thumb(plugin: MarketPlugin): string {
  const url = thumbUrl(plugin)
  if (url === '') return ''
  const failedAt = brokenThumbs.get(url)
  if (failedAt !== undefined && Date.now() - failedAt < BROKEN_TTL_MS) return ''
  return url
}

function onThumbError(plugin: MarketPlugin): void {
  const url = thumbUrl(plugin)
  if (url !== '') brokenThumbs.set(url, Date.now())
}

/** 下载量上万时缩短，否则一行放不下 */
function compact(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}w`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/**
 * 安装命令的提示文案。
 *
 * 优先用目录给的 `install`（作者自带的那行命令）；目录没给时，用**与按钮实际执行同一份**
 * 解析结果拼 —— 两者同源于 `installTargetOf`，不会出现"标题写 A、实际装 B"。
 */
function installCommand(plugin: MarketPlugin): string {
  if (plugin.install) return plugin.install
  const target = market.installTargetOf(plugin)
  return target === null ? '' : `dsh plugin --profile web add ${target.target}`
}

/** 卸载命令的提示文案：卸载要用**真实的依赖名**，不是目录短名 */
function uninstallCommand(plugin: MarketPlugin): string {
  const target = market.installTargetOf(plugin)
  const name = target !== null && target.kind === 'npm' ? target.target : plugin.npm || plugin.name
  return `dsh plugin --profile web remove ${name}`
}

/**
 * 行上显示的版本号。
 *
 * 优先目录给的（npm 条目都有）；只有 GitHub 的条目目录不给版本，退回**已装版本** ——
 * 否则装完之后那一行连版本都没有，看起来像没装好。
 */
/**
 * 行上显示的版本号。
 *
 * 由 store 的 `versionLabel` 统一决定（已装 → 显示已装版本；有更新 → `旧 → 新`），
 * 组件不自己挑字段 —— 之前这里优先取目录版本，导致已装插件的行和更新按钮显示同一个数字。
 */
function displayVersion(plugin: MarketPlugin): string {
  return market.versionLabel(plugin)
}

onMounted(() => {
  void market.load()
})
</script>

<template>
  <div id="view-store" class="view view-active">
    <div class="panel module-panel market">
      <div class="module-head">
        <div>
          <div class="module-title">{{ t('market.title') }}</div>
          <div class="module-sub" id="marketSub">{{ subtitle }}</div>
        </div>
        <button
          class="subtle-button"
          id="marketRefresh"
          type="button"
          :disabled="market.loading"
          @click="market.load(true)"
        >
          {{ t('market.refresh') }}
        </button>
      </div>

      <div class="market-tools">
        <div class="market-search-row">
          <input
            class="market-search"
            id="marketSearch"
            type="search"
            :value="market.query"
            :placeholder="t('market.searchPlaceholder')"
            @input="market.setQuery(($event.target as HTMLInputElement).value)"
          />
          <button
            class="subtle-button market-sort"
            id="marketSort"
            type="button"
            :title="t('market.sortHint')"
            @click="cycleSort"
          >
            {{ sortLabel }}
          </button>
        </div>
        <div class="market-cats" id="marketCats">
          <button
            class="chip"
            type="button"
            :class="{ 'state-enabled': market.category === '' }"
            @click="pickCategory('', $event)"
          >
            {{ t('market.allCategories') }}<span class="chip-n">{{ market.total }}</span>
          </button>
          <!--
            「已装」筛选。市场有四万多条且默认按星数降序，已装的包星数往往不高，
            不加这一项用户自己的插件会沉到几十上百位之后，"更新"按钮等于够不着。
          -->
          <button
            class="chip"
            type="button"
            :class="{ 'state-enabled': market.onlyInstalled }"
            @click="market.setOnlyInstalled(!market.onlyInstalled)"
          >
            {{ t('status.installed') }}<span class="chip-n">{{ market.installedCount }}</span>
          </button>
          <button
            v-for="item in market.categories"
            :key="item.name"
            class="chip"
            type="button"
            :class="{ 'state-enabled': market.category === item.name }"
            @click="pickCategory(item.name, $event)"
          >
            {{ item.name }}<span class="chip-n">{{ item.count }}</span>
          </button>
        </div>
      </div>

      <!--
        错误与结果提示：**挂在列表上方，不替换列表**。
        原先这里是 `<div v-else-if="market.error">`，和下面的列表同一个 v-if 链 ——
        更新一失败整列表就被这行字顶掉，用户看到的是"插件全没了"，而且分不清
        是成功还是失败。现在失败只红一条横幅，行照旧显示、还能继续操作。
      -->
      <div v-if="market.error" class="market-banner is-error">{{ market.error }}</div>
      <div
        v-else-if="market.progressText"
        class="market-banner"
        :class="{ 'is-busy': market.anyBusy }"
      >
        {{ market.progressText }}
      </div>

      <div class="module-list" id="marketList">
        <div v-if="market.loading && !market.loaded" class="module-empty">{{ t('common.loading') }}</div>
        <div v-else-if="!market.visible.length" class="module-empty">
          <span>{{ t('market.noMatch') }}</span>
          <button class="subtle-button" type="button" @click="clearFilters">{{ t('market.clearFilters') }}</button>
        </div>
        <div
          v-for="plugin in market.visible"
          v-else
          :key="identityOf(plugin) || `${plugin.name}@${plugin.owner}@${plugin.url}`"
          class="market-row"
          :data-plugin="plugin.name"
          :data-identity="identityOf(plugin)"
        >
          <!-- 截图走主进程代理；没有截图（目录只有 811/4183 条带图）就用作者首字母占位 -->
          <div class="market-thumb">
            <img
              v-if="thumb(plugin)"
              class="market-thumb-img"
              :src="thumb(plugin)"
              :alt="''"
              loading="lazy"
              decoding="async"
              @error="onThumbError(plugin)"
            />
            <span v-else class="market-thumb-text" aria-hidden="true">{{ initialOf(plugin) }}</span>
          </div>

          <div class="market-main">
            <div class="market-name">
              <span class="market-pkg">{{ plugin.name }}</span>
              <span v-if="displayVersion(plugin)" class="market-version">{{ displayVersion(plugin) }}</span>
              <span v-if="market.isInstalled(plugin)" class="tag muted">{{ t('status.installed') }}</span>
              <span v-if="market.sameIdentityCount(plugin) > 1" class="tag muted" :title="t('market.sameNameHint')">
                {{ t('market.sameName', { count: market.sameIdentityCount(plugin) }) }}
              </span>
            </div>
            <div class="market-owner">
              @{{ plugin.owner }}
              <span v-if="plugin.npm && plugin.npm !== plugin.name" class="market-npm">{{ plugin.npm }}</span>
            </div>
            <p class="market-desc">{{ descriptionOf(plugin) }}</p>
            <div class="market-tags">
              <span v-for="name in plugin.category" :key="name" class="tag muted">{{ name }}</span>
              <span v-if="plugin.stars > 0" class="tag muted" :title="t('market.starsHint')">★ {{ compact(plugin.stars) }}</span>
              <span v-if="plugin.downloads > 0" class="tag muted" :title="t('market.downloadsHint')">↓ {{ compact(plugin.downloads) }}</span>
            </div>
          </div>

          <div class="market-actions">
            <button
              v-if="plugin.page"
              class="subtle-button"
              type="button"
              :title="t('market.openPage')"
              @click="openLink(plugin.page)"
            >
              {{ t('market.page') }}
            </button>
            <button
              v-if="plugin.url"
              class="subtle-button"
              type="button"
              :title="t('market.openRepo')"
              @click="openLink(plugin.url)"
            >
              {{ t('market.repo') }}
            </button>
            <!--
              装了但市场里版本更新 → 先给「更新到 x.y.z」。
              目标版本由 store 的 updateTarget() 判定（只认两边都能比的情况），
              这里不自己算。更新与卸载可以并存：想升就升，想撤就撤。
              只有 npm 来源有版本语义，git / tarball 条目 updateTarget 恒为空串。
            -->
            <button
              v-if="market.updateTarget(plugin)"
              class="subtle-button"
              type="button"
              :disabled="market.busyFor(plugin)"
              :title="t('market.updateTitle', { version: market.updateTarget(plugin) })"
              @click="market.update(identityOf(plugin), market.updateTarget(plugin))"
            >
              {{
                market.busyFor(plugin)
                  ? t('market.updating')
                  : `${t('market.update')} ${market.updateTarget(plugin)}`
              }}
            </button>

            <!-- 已装 → 卸载；未装 → 下载。两个按钮都接**目录条目本身**，由 store 解析真实目标 -->
            <button
              v-if="market.isInstalled(plugin)"
              class="subtle-button danger"
              type="button"
              :disabled="market.busyFor(plugin)"
              :title="t('market.uninstallTitle', { command: uninstallCommand(plugin) })"
              @click="market.uninstall(plugin)"
            >
              {{
                market.busyFor(plugin) ? t('market.uninstalling') : t('market.uninstall')
              }}
            </button>
            <!--
              下载入口的判据是「有没有安装目标」，不是「有没有 npm 名」。
              只有 GitHub 的条目走 github:owner/repo（或作者的同仓库 Release 产物），
              与 dsh 自己的市场同一套三段式；没有仓库也没有 npm 名的才禁用。
              只有**这一行自己**在忙时禁用，别的行照常可点（点击会排队）。
            -->
            <button
              v-else
              class="subtle-button"
              type="button"
              :disabled="market.busyFor(plugin) || !market.installable(plugin)"
              :title="
                market.installable(plugin)
                  ? t('market.installTitle', { command: installCommand(plugin) })
                  : t('market.noSourceHint')
              "
              @click="market.install(plugin)"
            >
              {{ market.busyFor(plugin) ? t('market.installing') : t('market.install') }}
            </button>
          </div>
        </div>
      </div>

      <div class="market-foot">
        <p class="status-line" id="marketHint">
          <!-- 正在安装/卸载时优先显示主进程推回来的 pnpm 输出行，否则显示计数 -->
          <template v-if="market.progressText">{{ market.progressText }}</template>
          <template v-else-if="market.canLoadMore">
            {{ t('market.hidden', { count: market.hidden }) }}
          </template>
          <template v-else>{{ shown }}</template>
        </p>
        <button
          v-if="market.canLoadMore"
          class="subtle-button"
          id="marketMore"
          type="button"
          @click="market.loadMore()"
        >
          {{ t('market.loadMore', { count: Math.min(market.hidden, 120) }) }}
        </button>
      </div>

      <!--
        目录只收录了一部分插件，所以"已装 N 个"会小于 profile 里的实际数量。
        不说明的话看起来像漏算，所以把未被收录的那几个点名出来。
      -->
      <p v-if="market.unlistedInstalled.length" class="status-line market-unlisted" id="marketUnlisted">
        {{ t('market.unlisted', { count: market.unlistedInstalled.length, names: market.unlistedInstalled.join('、') }) }}
      </p>
    </div>
  </div>
</template>
