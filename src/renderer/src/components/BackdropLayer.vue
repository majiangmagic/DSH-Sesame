<script setup lang="ts">
/**
 * 背景层。
 *
 * 背景完全由 CSS 画（渐变 + 网格 + 氛围光 + 会漂移的霓虹光球），不依赖任何位图资源：
 * 任意分辨率都清晰，打包体积也不增加。
 *
 * 光球分两类：
 *   - **两团大光团**：`.backdrop-grid-mask` 的 `::before` / `::after`，负责整体氛围；
 *   - **四颗小光球**：下面这几个 `.grid-orb`（真正的 DOM 元素）。伪元素只有两个，
 *     想再加就必须用元素。它们更小更亮，职责是"让眼睛看到有东西在游动"。
 *
 * 每颗的位置、颜色、周期都不同，所以永远不会同步成一片；漂移方向也刻意取不同的轴 ——
 * 方向相反的两团会互相抵消（实测过质心变化 <1px，行程再大也看不出移动）。
 *
 * 样式全部在 `assets/styles/custom.css` 的 `.grid-orb*` 一段。
 */
</script>

<template>
  <div class="stage" aria-hidden="true">
    <div class="backdrop-grid-mask"></div>
    <div class="grid-orb grid-orb-c"></div>
    <div class="grid-orb grid-orb-d"></div>
    <div class="grid-orb grid-orb-e"></div>
    <div class="grid-orb grid-orb-f"></div>
  </div>
</template>
