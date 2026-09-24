<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PluginEntry, PluginReason } from '@/api'

/**
 * 插件列表的一行（原版由脚本拼 HTML 生成，模板见 docs/reference/markup-templates.md）。
 *
 * 结构要点：整行本身是个 `<label class="toggle">`，右侧的 checkbox 就是原生的开关；
 * 不可开关时给 checkbox 加 disabled、并在 meta 里说明原因。禁用状态给整行加 `off` 类，
 * 让名字与 meta 变灰（`.module-row.off`）。
 */
const props = withDefaults(
  defineProps<{
    plugin: PluginEntry
    /** 该插件正在切换中：禁用开关，避免连点 */
    busy?: boolean
  }>(),
  { busy: false }
)
const emit = defineEmits<{ toggle: [name: string, enabled: boolean] }>()

const { t } = useI18n()

/** 原因码 → 文案。码到 key 的映射集中在这里，避免散落在模板里。 */
const REASON_KEY: Record<Exclude<PluginReason, ''>, string> = {
  'no-rows': 'plugins.reason.noRows',
  official: 'plugins.reason.official',
  'market-owned': 'plugins.reason.market'
}

/**
 * 「为什么不能关」的长文案，挂整行的 `title`。
 *
 * 行内那行 `.module-meta` 还要放版本号、行 id、禁用状态，塞不下解释；所以短原因留在行里，
 * 完整理由放悬浮 —— 这样"不支持关闭"是个可追问的结论，而不是一句没有出处的断言。
 */
const REASON_WHY_KEY: Record<Exclude<PluginReason, ''>, string> = {
  'no-rows': 'plugins.reason.noRowsWhy',
  official: 'plugins.reason.officialWhy',
  'market-owned': 'plugins.reason.marketWhy'
}

/** 悬浮提示：能关的说清点它会怎样，不能关的说清为什么 */
const title = computed(() => {
  const plugin = props.plugin
  if (plugin.reason) return t(REASON_WHY_KEY[plugin.reason])
  if (!plugin.toggleable) return plugin.name
  return plugin.enabled ? t('plugins.willDisable', { name: plugin.name }) : t('plugins.willEnable', { name: plugin.name })
})

/**
 * meta 串的拼法与原版一致：
 * `v{version} · 行 {ids} · 已禁用 · {不可开关的原因}`，空的段落直接不出现。
 */
const meta = computed(() => {
  const plugin = props.plugin
  const reason = plugin.reason ? t(REASON_KEY[plugin.reason]) : ''
  return [
    plugin.version ? `v${plugin.version}` : '',
    plugin.ids.length ? t('plugins.rows', { ids: plugin.ids.join(', ') }) : '',
    plugin.enabled ? '' : t('plugins.disabled'),
    plugin.toggleable ? '' : reason
  ]
    .filter(Boolean)
    .join(' · ')
})

function onToggle(event: Event): void {
  emit('toggle', props.plugin.name, (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <label
    class="toggle module-row"
    :class="{ off: !plugin.enabled }"
    :title="title"
  >
    <span class="module-main">
      <span class="module-name">{{ plugin.name }}</span>
      <span class="module-meta">{{ meta }}</span>
    </span>
    <input
      type="checkbox"
      :data-plugin="plugin.name"
      :checked="plugin.enabled"
      :disabled="!plugin.toggleable || busy"
      @change="onToggle"
    />
  </label>
</template>
