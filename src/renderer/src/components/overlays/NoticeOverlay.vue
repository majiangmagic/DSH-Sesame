<script setup lang="ts">
import { useI18n } from 'vue-i18n'

/**
 * 通知弹窗（原版 `#notice`）。
 *
 * 本阶段没有逻辑驱动，文案先给一个占位：接逻辑时把 `text` 换成 api 层返回的失败原因即可。
 * 结构逐字符照搬原版静态标记（含 role / aria-modal / aria-labelledby）。
 */
const { t } = useI18n()

defineProps<{ text?: string }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="ask" id="notice">
    <div class="ask-card" role="alertdialog" aria-modal="true" aria-labelledby="noticeTitle">
      <h2 class="ask-title" id="noticeTitle">{{ t('modal.actionFailed') }}</h2>
      <p class="notice-text" id="noticeText">{{ text }}</p>
      <div class="ask-actions">
        <button type="button" class="primary" id="noticeOk" @click="emit('close')">
          {{ t('modal.ok') }}
        </button>
      </div>
    </div>
  </div>
</template>
