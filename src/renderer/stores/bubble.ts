import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 轻提示（气泡）。用于"发生了你该知道、但不需要你点确定"的事 ——
 * 例如启动端口被占用后自动换了一个。
 *
 * 与 `components/overlays/NoticeOverlay` 的区别是刻意的：那个是**模态**
 * （role=alertdialog，必须点"确定"），适合"操作失败"。端口回退不是失败，
 * 弹模态会打断人；气泡自动消失、不拦操作。
 *
 * **应用级**状态：挂在 `app/layouts/AppShell.vue` 上，任何页面都能看到 ——
 * 端口回退发生在"启动"那一刻，而那时用户可能已经切到别的标签页了。
 */
export const useBubbleStore = defineStore('bubble', () => {
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

  return { bubble, showBubble }
})
