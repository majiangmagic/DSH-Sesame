<script setup lang="ts">
import { useI18n } from 'vue-i18n'

/**
 * 无边框窗口的三个按钮。
 *
 * 整个应用就是无边框 Electron 窗口，所以这组按钮常驻显示。
 *
 * 注意：这里不做"最大化/还原换图标"。preload 里的 isMaximized / onMaximizedChanged 仍然可用，
 * 将来若要做这个效果直接取用即可。
 */
const { t } = useI18n()

// 模板里不能直接写 window（Vue 的模板全局白名单里没有它），包一层再绑到事件上
function minimize(): void {
  window.sesame.window.minimize()
}

function toggleMaximize(): void {
  window.sesame.window.toggleMaximize()
}

function close(): void {
  window.sesame.window.close()
}
</script>

<template>
  <div class="win-controls">
    <button
      type="button"
      class="win-btn"
      id="winMin"
      :title="t('window.minimize')"
      :aria-label="t('window.minimize')"
      @click="minimize"
    >
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M0 5.5h10" stroke="currentColor" stroke-width="1.1" fill="none" />
      </svg>
    </button>
    <button
      type="button"
      class="win-btn"
      id="winMax"
      :title="t('window.maximize')"
      :aria-label="t('window.maximize')"
      @click="toggleMaximize"
    >
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <rect x=".7" y=".7" width="8.6" height="8.6" fill="none" stroke="currentColor" stroke-width="1.1" />
      </svg>
    </button>
    <button
      type="button"
      class="win-btn close"
      id="winClose"
      :title="t('window.close')"
      :aria-label="t('window.close')"
      @click="close"
    >
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M.7.7l8.6 8.6M9.3.7L.7 9.3" stroke="currentColor" stroke-width="1.1" fill="none" />
      </svg>
    </button>
  </div>
</template>
