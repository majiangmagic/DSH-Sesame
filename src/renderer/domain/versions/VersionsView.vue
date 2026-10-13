<script setup lang="ts">
import VersionManager from '@/domain/versions/VersionManager.vue'

/**
 * 版本管理页（DSH-Sesame 新增的独立标签页）。
 *
 * 版本管理单独成页：控制页只回答"启哪个版本"，这里提供按版本号的**下载**与**卸载**。
 *
 * 卡片外壳沿用 `.card` 的视觉，但需要能内部滚动 —— `#view-releases` 的布局规则写在
 * assets/styles/custom.css。
 */
</script>

<template>
  <div id="view-releases" class="view view-active">
    <div class="panel versions">
      <VersionManager />
    </div>
  </div>
</template>
