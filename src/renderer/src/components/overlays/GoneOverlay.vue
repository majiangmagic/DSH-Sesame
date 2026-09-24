<script setup lang="ts">
import { useI18n } from 'vue-i18n'

/**
 * 「管理器已停止」提示（原版 `#gone`）。
 *
 * 原版这个块负责告诉用户"后端没了、这个页面可以关了"。在 Electron 里它的去向待定
 * （窗口还活着但后台进程退出时弹它），先按原样复刻结构与样式。
 */
const { t } = useI18n()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="gone" id="gone">
    <div>
      <div class="empty-title">{{ t('gone.title') }}</div>
      <p class="empty-sub">{{ t('gone.sub') }}</p>
      <button type="button" class="ghost" id="goneClose" @click="emit('close')">
        {{ t('gone.close') }}
      </button>
    </div>
  </div>
</template>
