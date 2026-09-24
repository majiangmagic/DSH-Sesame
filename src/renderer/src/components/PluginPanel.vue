<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import PluginRow from '@/components/PluginRow.vue'
import SampleTag from '@/components/SampleTag.vue'
import { SAMPLE_DATA } from '@/api'
import { usePluginsStore } from '@/stores/plugins'

/**
 * 插件列表（标题 + 副标题 + 刷新 + 列表）。
 *
 * 控制页新加的"插件开关"块和原来的插件页长得一样、动作也一样，所以抽成一个组件：
 * 两个页面共用，改了不会只改一边。**插件页本身保持不变**，只是改用这个组件渲染。
 *
 * 卡片外壳由调用方提供（插件页用 `.card.plugins`，控制页用普通 `.card`），
 * 这里只负责卡片内部——因为两处的卡片布局约束不同（插件页要撑满高度并内部滚动）。
 */
const { t } = useI18n()
const store = usePluginsStore()

/** 副标题：有插件时「{profile} profile · 共 {total} 个 · {on} 个启用」，空列表只显示 profile */
const subtitle = computed(() => {
  const data = store.summary
  if (!data) return ''
  if (!data.total) return `${data.profile} profile`
  return t('plugins.subtitle', data)
})

onMounted(() => {
  // 插件页可能先于控制页被打开，两边都可能触发首次加载，store 里已有数据就不重复拉
  if (!store.data) void store.load()
})
</script>

<template>
  <div class="module-head">
    <div>
      <div class="module-title">
        {{ t('plugins.title') }}
        <SampleTag v-if="SAMPLE_DATA.plugins" />
      </div>
      <div class="module-sub" id="pluginSub">{{ subtitle }}</div>
    </div>
    <button class="ghost" id="pluginRefresh" type="button" :disabled="store.loading" @click="store.load()">
      {{ t('plugins.refresh') }}
    </button>
  </div>
  <div class="module-list" id="pluginList">
    <div v-if="store.loading" class="module-empty">{{ t('common.loading') }}</div>
    <div v-else-if="!store.plugins.length" class="module-empty">{{ t('plugins.empty') }}</div>
    <PluginRow
      v-for="plugin in store.plugins"
      :key="plugin.name"
      :plugin="plugin"
      :busy="store.toggling === plugin.name"
      @toggle="store.setEnabled"
    />
  </div>
  <p class="hint" id="pluginHint">{{ store.error }}</p>
</template>
