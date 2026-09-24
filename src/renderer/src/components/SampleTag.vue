<script setup lang="ts">
import { useI18n } from 'vue-i18n'

/**
 * 「样例数据」标注。
 *
 * 插件 / 设置 / 终端三块目前仍由样例数据驱动（实现在 api/mock.ts）。
 * 挂这个标注是为了**不骗人** —— 尤其插件页，很容易被误认为已经读到了真实插件。
 * 等这些区域也接上真实逻辑后，把对应的 SAMPLE_DATA 开关关掉即可，标注自动消失。
 */
const { t } = useI18n()
</script>

<template>
  <span class="tag muted" :title="t('common.sampleHint')">{{ t('common.sampleData') }}</span>
</template>
