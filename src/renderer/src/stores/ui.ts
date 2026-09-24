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

  /**
   * 轻提示（气泡）。用于"发生了你该知道、但不需要你点确定"的事 ——
   * 例如启动端口被占用后自动换了一个。
   *
   * 与 NoticeOverlay 的区别是刻意的：那个是**模态**（role=alertdialog，必须点"确定"），
   * 适合"操作失败"。端口回退不是失败，弹模态会打断人；气泡自动消失、不拦操作。
   */
  const bubble = ref<string>('')
  let bubbleTimer: ReturnType<typeof setTimeout> | null = null

  function showBubble(text: string, ms = 12000): void {
    if (bubbleTimer !== null) clearTimeout(bubbleTimer)
    bubble.value = text
    bubbleTimer = setTimeout(() => {
      bubbleTimer = null
      bubble.value = ''
    }, ms)
  }

  function showOverlay(name: OverlayName | null): void {
    overlay.value = name
  }

  return { overlay, locale, bubble, showBubble, switchLocale, showOverlay }
})
