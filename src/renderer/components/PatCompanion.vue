<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

/**
 * 摸头伴侣 —— 替代原来那个可点击的看板娘。
 *
 * **只复用素材，不内置插件。** 从 `dsh-whale-widget-bowl`（MIT，作者 Witherwithwinter）
 * 复制了三个图片文件到 `public/pat/`，没有把它加进依赖、也没有引入它的任何代码或功能：
 *   - `/pat/dsniang.png`  610×610  主立绘（待机）
 *   - `/pat/rua.gif`      128×128  摸头表情包
 *
 * 交互：点一下 → 角色**塌一下**（压扁回弹）＋ 头顶**弹出气泡**，表情包在气泡里。
 * 那个 gif 在原插件里本来就是气泡图（`bubble-petpet.gif`，与 `rua.gif` 同一个文件）。
 *
 * ── 为什么压扁用 WAAPI（`element.animate`）而不是加 class ──
 * 加 class 触发 CSS 动画时，**同一个 class 连续加是不会重播的**：computed `animation-name`
 * 没变化，浏览器就认为动画没换过。表现就是"第一下有效、连点没反应"。
 * `element.animate()` 每次调用都是一个**新动画**，天然从头播 —— 这正是这里的语义。
 * （CSS 里保留 `transform-origin: 50% 100%`，塌陷要从脚底压下去。）
 *
 * ── 气泡为什么带 `:key` ──
 * 气泡的淡出是 keyframe 按固定时刻排的。如果第二次点击时复用同一个元素，
 * 它的淡出仍按**第一次**点击的时刻触发，气泡会提前消失。`:key="key"` 让每次点击都重建气泡，
 * 弹出与淡出的计时因此都从本次点击重新开始。同理，GIF 靠重建元素才能从头播。
 *
 * **收尾的视觉仍然由 CSS 负责**（keyframe 的 `forwards`），下面的定时器只做 DOM 清理。
 * 实测窗口隐藏时 Electron 会把定时器节流到 1s 以上（`setTimeout(1500)` 实测跑了 1989ms），
 * 所以不能让"视觉上什么时候收"依赖 JS 定时器。
 */
const PAT_MS = 1500
const SQUASH_MS = 460

const key = ref(0)
const patting = ref(false)
const figureEl = ref<HTMLButtonElement | null>(null)
let timer: number | undefined
let squash: Animation | undefined

/** 与 CSS 里原来的 pat-squash 关键帧一致：先横向变宽、纵向压扁（塌），再轻微回弹 */
const SQUASH_KEYFRAMES: Keyframe[] = [
  { transform: 'scale(1, 1)' },
  { transform: 'scale(1.09, 0.84)', offset: 0.22 },
  { transform: 'scale(0.97, 1.05)', offset: 0.5 },
  { transform: 'scale(1.02, 0.98)', offset: 0.76 },
  { transform: 'scale(1, 1)' }
]

function pat(): void {
  key.value += 1
  patting.value = true

  // 压扁：每次点击都新建一个动画，所以连点也能重播。
  // 先取消上一个，避免连点时动画对象堆积（旧的仍会跑完，只是被新的覆盖）。
  squash?.cancel()
  const body = figureEl.value?.querySelector('.pat-body')
  if (body instanceof Element) {
    squash = body.animate(SQUASH_KEYFRAMES, {
      duration: SQUASH_MS,
      easing: 'cubic-bezier(0.3, 0.9, 0.4, 1)'
    })
  }

  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    patting.value = false
  }, PAT_MS)
}

onBeforeUnmount(() => {
  window.clearTimeout(timer)
  squash?.cancel()
})
</script>

<template>
  <!-- 纯装饰：容器不吃鼠标事件（pointer-events: none），只有角色本身可点 -->
  <div class="pat" aria-hidden="true">
    <button ref="figureEl" class="pat-figure" type="button" tabindex="-1" @click="pat">
      <img class="pat-body" src="/pat/dsniang.png" alt="" />
      <span v-if="patting" :key="key" class="pat-bubble">
        <img class="pat-bubble-gif" src="/pat/rua.gif" alt="" />
      </span>
    </button>
  </div>
</template>
