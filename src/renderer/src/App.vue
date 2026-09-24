<script setup lang="ts">
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import BackdropLayer from '@/components/BackdropLayer.vue'
import PatCompanion from '@/components/PatCompanion.vue'
import AskOverlay from '@/components/overlays/AskOverlay.vue'
import NoticeOverlay from '@/components/overlays/NoticeOverlay.vue'
import GoneOverlay from '@/components/overlays/GoneOverlay.vue'
import { useUiStore, type OverlayName } from '@/stores/ui'

/**
 * 根组件。
 *
 * DOM 层序与原版一致：背景层（fixed）→ header/main → 三个遮罩（fixed）。
 * 遮罩的显隐在原版由脚本控制；本阶段没有逻辑，用路由 query 预览：
 *   `#/home?overlay=notice` · `?overlay=ask` · `?overlay=gone`
 * 接逻辑后由 api 事件驱动，这个预览入口留着也不冲突（方便单独校对样式）。
 *
 * `PatCompanion` 是新增的摸头伴侣，替代原来那只可点击的看板娘 ——
 * 它必须在 `BackdropLayer` **之上**（背景层 `pointer-events: none`，收回来的点击要落到它身上）。
 */
const route = useRoute()
const ui = useUiStore()

const OVERLAYS: readonly OverlayName[] = ['ask', 'notice', 'gone']

watch(
  () => route.query.overlay,
  (value) => {
    const name = typeof value === 'string' && (OVERLAYS as readonly string[]).includes(value)
      ? (value as OverlayName)
      : null
    ui.showOverlay(name)
  },
  { immediate: true }
)
</script>

<template>
  <BackdropLayer />
  <PatCompanion />
  <AppShell />
  <AskOverlay v-if="ui.overlay === 'ask'" @close="ui.showOverlay(null)" />
  <NoticeOverlay v-if="ui.overlay === 'notice'" @close="ui.showOverlay(null)" />
  <GoneOverlay v-if="ui.overlay === 'gone'" @close="ui.showOverlay(null)" />
</template>
