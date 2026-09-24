<script setup lang="ts">
/**
 * 背景层。
 *
 * 背景完全由 CSS 画（渐变 + 网格 + 氛围光 + 两团会漂移的霓虹），不依赖任何位图资源：
 * 任意分辨率都清晰，打包体积也不增加。
 *
 * 网格与氛围光在 `custom.css` 里定义（`.backdrop` / `.backdrop::before` / `body::after`）；
 * 这里只放网格的淡出遮罩，因为 `.backdrop` 的 `::before` / `::after` 已经被光斑和星点占用。
 */
</script>

<template>
  <div class="backdrop" aria-hidden="true">
    <div class="backdrop-grid-mask"></div>
  </div>
</template>
