import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 三个遮罩层。 */
export type OverlayName = 'ask' | 'notice' | 'gone'

/**
 * 全局遮罩层的显隐。
 *
 * **应用级**状态（不属于任何页面）：`app/App.vue` 按路由 query 驱动它，
 * `components/overlays/` 下的三个遮罩消费它。
 *
 * 原先它和 `bubble`、`locale` 挤在同一个 `stores/ui.ts` 里 —— 那三个 ref 各自
 * 只服务不同的使用者，导致那个文件"放哪个目录都只对三分之一"。拆开后每个都有唯一归属。
 */
export const useOverlayStore = defineStore('overlay', () => {
  /** 当前展示的遮罩；真实运行时由 api 事件驱动，也可以靠路由 query 预览 */
  const overlay = ref<OverlayName | null>(null)

  function showOverlay(name: OverlayName | null): void {
    overlay.value = name
  }

  return { overlay, showOverlay }
})
