<script setup lang="ts">
/**
 * 进度条。
 *
 * 原版是两处各自独立的 DOM（控制页 `#progress`/`#progress-track`，更新弹窗
 * `#askProgress`/`#askProgressBar`），样式都走 `.progress` / `.progress-track`，
 * id 只被脚本用来改宽度，所以这里用组件复用、不再保留 id。
 * `.progress.indeterminate` 是原版已有的状态类，一并支持。
 */
withDefaults(
  defineProps<{
    visible?: boolean
    /** 0–100；为 null 时走 indeterminate（原版用 .indeterminate 类） */
    percent?: number | null
  }>(),
  { visible: false, percent: null }
)
</script>

<template>
  <div class="progress-shell" :class="{ 'progress-indeterminate': percent === null }" :hidden="!visible">
    <div
      class="progress-track"
      :style="percent === null ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }"
    ></div>
  </div>
</template>
