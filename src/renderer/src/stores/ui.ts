import { defineStore } from 'pinia'
import { ref } from 'vue'
import { setLocale, type LocaleName } from '@/i18n'

/** 三个遮罩层。本阶段没有逻辑驱动，靠路由 query 预览：`#/home?overlay=ask`。 */
export type OverlayName = 'ask' | 'notice' | 'gone'

/**
 * 纯界面状态。
 *
 * 这里**不放**业务数据（版本、插件、设置都走 api 层）。等接逻辑时再按 contract.ts 的
 * 形状补 manager / plugins / log 这些 store。
 */
export const useUiStore = defineStore('ui', () => {
  /** 当前预览的遮罩；真实运行时由 api 事件驱动，不从这里进 */
  const overlay = ref<OverlayName | null>(null)

  const locale = ref<LocaleName>('zh-CN')

  function switchLocale(next: LocaleName): void {
    locale.value = next
    setLocale(next)
  }

  function showOverlay(name: OverlayName | null): void {
    overlay.value = name
  }

  return { overlay, locale, switchLocale, showOverlay }
})
