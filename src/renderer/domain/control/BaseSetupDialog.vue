<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, type PluginBaseSource } from '@/api'

/**
 * 首次选择「插件基线」的弹窗。
 *
 * 插件现在只有一个写入点（母版）：装 / 升 / 卸 / 开关都只改它，启动 web 与桌面端前
 * 从它克隆到各自 profile。**母版没初始化就不允许启动 dsh** —— 否则用户会拿到一套
 * 来源不明的插件（今天是 web 的，明天可能被桌面端的覆盖）。
 *
 * 所以这个弹窗**没有"稍后再说"**：只有"选 web"、"选桌面端"和"先不启动"。
 * 关掉它 = 本次不启动，下次点启动还会再问，直到真的做出选择。
 */
const { t } = useI18n()
const emit = defineEmits<{ done: []; cancel: [] }>()

const busy = ref<PluginBaseSource | ''>('')
const error = ref('')

async function pick(source: PluginBaseSource): Promise<void> {
  if (busy.value !== '') return
  busy.value = source
  error.value = ''
  try {
    await api.initPluginBase(source)
    emit('done')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="confirm-layer" id="base-setup-layer">
    <div class="confirm-card" role="dialog" aria-modal="true" aria-labelledby="baseSetupTitle">
      <h2 class="confirm-title" id="baseSetupTitle">{{ t('baseSetup.title') }}</h2>

      <p class="confirm-risk">{{ t('baseSetup.intro') }}</p>

      <div class="confirm-items">
        <div class="confirm-item">
          <div class="confirm-target">
            <div class="confirm-name">{{ t('baseSetup.webName') }}</div>
          </div>
          <p class="confirm-risk">{{ t('baseSetup.webHint') }}</p>
        </div>
        <div class="confirm-item">
          <div class="confirm-target">
            <div class="confirm-name">{{ t('baseSetup.desktopName') }}</div>
          </div>
          <p class="confirm-risk">{{ t('baseSetup.desktopHint') }}</p>
        </div>
      </div>

      <p class="confirm-risk">{{ t('baseSetup.noSkip') }}</p>
      <p v-if="error" class="confirm-risk" style="color: var(--danger)">{{ error }}</p>

      <div class="confirm-actions">
        <button type="button" class="main-button" :disabled="busy !== ''" @click="pick('web')">
          {{ busy === 'web' ? t('baseSetup.working') : t('baseSetup.useWeb') }}
        </button>
        <button type="button" class="main-button" :disabled="busy !== ''" @click="pick('desktop')">
          {{ busy === 'desktop' ? t('baseSetup.working') : t('baseSetup.useDesktop') }}
        </button>
        <button type="button" class="subtle-button" :disabled="busy !== ''" @click="emit('cancel')">
          {{ t('baseSetup.cancelStart') }}
        </button>
      </div>
    </div>
  </div>
</template>
