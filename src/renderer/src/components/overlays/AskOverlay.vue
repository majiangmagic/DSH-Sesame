<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import ProgressBar from '@/components/ProgressBar.vue'
import { useVersionsStore } from '@/stores/versions'

/**
 * 更新询问弹窗（原版 `#ask`）。
 *
 * 装配方式与原版一致：`askRow()` 造出 `.confirm-item`（含 what / risk / notes），**动作按钮不进**
 * 条目，而是统一塞到底栏 `.confirm-actions` 里和「暂不更新」并排（原脚本 1982 行的注释写明了）。
 *
 * 数据现在来自真实的版本 store：远端"最新"（跨 tag 取 semver 最高）存在且尚未安装时才弹。
 * 更新内容（原版 `renderNotes`）需要 changelog 接口，还没进契约，先渲染一句说明。
 */
const { t } = useI18n()
const emit = defineEmits<{ close: [] }>()

const versions = useVersionsStore()

const pending = computed(() => {
  const latest = versions.latest
  if (!latest || versions.installedSet.has(latest)) return null
  const from = versions.runningVersion || versions.installedNumbers[0] || ''
  return { from, to: latest }
})

const busy = computed(() => versions.action === 'updating')

onMounted(() => {
  if (!versions.overview) void versions.load()
})
</script>

<template>
  <div class="confirm-layer" id="confirm-layer">
    <div class="confirm-card" role="dialog" aria-modal="true" aria-labelledby="askTitle">
      <h2 class="confirm-title" id="askTitle">{{ t('modal.updateAvailable') }}</h2>
      <div class="confirm-items" id="askItems">
        <div v-if="pending" class="confirm-item">
          <div class="confirm-target">
            <div class="confirm-name">{{ t('ask.dshItself') }}</div>
            <div class="confirm-version">{{ pending.from }} → <b>{{ pending.to }}</b></div>
          </div>
          <p class="confirm-risk">{{ t('ask.risk') }}</p>
          <div class="confirm-notes">{{ t('ask.notesUnavailable') }}</div>
        </div>
      </div>
      <p class="confirm-note" id="askNote" hidden></p>
      <ProgressBar :visible="busy" :percent="null" />
      <div class="confirm-actions" id="askActions">
        <button v-if="pending" type="button" class="main-button" :disabled="busy" @click="versions.update()">
          {{ t('ask.updateTo', { latest: pending.to }) }}
        </button>
        <button type="button" class="subtle-button" id="askSkip" @click="emit('close')">
          {{ t('modal.notNow') }}
        </button>
      </div>
    </div>
  </div>
</template>
