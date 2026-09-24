<script setup lang="ts">
import SnapshotManager from '@/components/SnapshotManager.vue'

/**
 * 快照页（用户要求新增的标签页）。
 *
 * 存的是 profile 的 5 个配置文件：手动可存、插件变更前自动存、保留最多 10 份、可回退。
 * 位置在 <userData>/snapshots —— 刻意不放安装目录（覆盖安装会清空它）。
 */
</script>

<template>
  <SnapshotManager />
</template>
