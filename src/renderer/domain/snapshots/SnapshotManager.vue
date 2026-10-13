<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api'
import { useBubbleStore } from '@/stores/bubble'
import type { SnapshotEntry, SnapshotPaths, SnapshotPreview } from '@shared/types/snapshots'

/**
 * 快照管理。
 *
 * 规格（用户定）：文件清单照 dsh-plugin-guard 的 5 个、手动+自动触发、最多保留 10 份、
 * 存在 <userData>/snapshots（**不是安装目录** —— 覆盖安装会把安装目录清空）。
 *
 * 回退的安全性由主进程保证：**回退前会自动先存一份 pre-rollback**，所以回退本身可逆。
 */
const { t } = useI18n()
const toast = useBubbleStore()

const list = ref<SnapshotEntry[]>([])
const paths = ref<SnapshotPaths | null>(null)
const label = ref('')
const busy = ref(false)
/** 存之前的预演（平铺的插件列表 + node_modules 大小） */
const preview = ref<SnapshotPreview | null>(null)
const showPreview = ref(false)

async function refresh(): Promise<void> {
  list.value = await api.listSnapshots()
  paths.value = await api.snapshotPaths()
}

/** 字节 → MB（界面只显示整数兆） */
function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0) + ' MB'
}

/**
 * 点「存一份」：**先弹窗让用户看一眼**，不直接开存。
 *
 * 因为存一次要把整个 node_modules 压缩（几百 MB、几十秒），
 * 让用户先知道"会打包哪些插件、多大"再确认，比点完等半天好。
 */
async function askCreate(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    preview.value = await api.snapshotPlan()
    showPreview.value = true
  } catch (cause) {
    toast.showBubble(cause instanceof Error ? cause.message : String(cause))
  } finally {
    busy.value = false
  }
}

/** 弹窗里那个**唯一**的「确定」：真正开始存 */
async function confirmCreate(): Promise<void> {
  if (busy.value) return
  busy.value = true
  // **先关弹窗**再开存：压缩整个 node_modules 要几十秒，不该让用户盯着一个卡住的弹窗。
  // 之前是存完才关，实测发现弹窗会一直留在那里。
  showPreview.value = false
  try {
    const entry = await api.createSnapshot(label.value)
    label.value = ''
    await refresh()
    toast.showBubble(entry.reused ? t('snap.reused') : t('snap.created'))
  } catch (cause) {
    toast.showBubble(cause instanceof Error ? cause.message : String(cause))
  } finally {
    busy.value = false
  }
}

async function restore(id: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const r = await api.restoreSnapshot(id)
    await refresh()
    toast.showBubble(t('snap.restored', { n: r.restored.length, backup: r.backupId }))
  } catch (cause) {
    toast.showBubble(cause instanceof Error ? cause.message : String(cause))
  } finally {
    busy.value = false
  }
}

/** 删除一份快照。只删它，不动 profile；列表随之刷新 */
async function remove(id: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await api.deleteSnapshot(id)
    await refresh()
    toast.showBubble(t('snap.removed'))
  } catch (cause) {
    toast.showBubble(cause instanceof Error ? cause.message : String(cause))
  } finally {
    busy.value = false
  }
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

onMounted(refresh)
</script>

<template>
  <div id="view-snapshots" class="view view-active">
    <div class="panel snapshots">
      <h3 class="card-title">{{ t('snap.title') }}</h3>

      <div class="form-row wide">
        <span>{{ t('snap.label') }}</span>
        <div class="inline-input">
          <input
            id="snapLabel"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('snap.labelPlaceholder')"
            v-model="label"
          />
          <button id="snapCreate" type="button" class="subtle-button" :disabled="busy" @click="askCreate">
            {{ t('snap.create') }}
          </button>
        </div>
      </div>

      <ul class="plugin-list" id="snapList" v-if="list.length > 0">
        <li class="plugin-row" v-for="s in list" :key="s.id">
          <div class="plugin-meta">
            <strong>{{ s.label || s.id }}</strong>
            <span>
              {{ when(s.at) }} · {{ s.trigger }} · {{ s.files.length }} {{ t('snap.files') }}
            </span>
          </div>
          <button
            type="button"
            class="subtle-button"
            :disabled="busy"
            @click="restore(s.id)"
          >
            {{ t('snap.restore') }}
          </button>
          <button
            type="button"
            class="subtle-button"
            :disabled="busy"
            @click="remove(s.id)"
          >
            {{ t('snap.remove') }}
          </button>
        </li>
      </ul>

      <p class="status-line" id="snapKeep">{{ t('snap.keep') }}</p>
    </div>
  </div>

  <!--
    存之前的确认弹窗。
    规格（用户定）：**平铺列出插件**（不做 npm / 非 npm 分类）+ **只有一个「确定」**。
    结构照抄 components/overlays/NoticeOverlay.vue 的 class，不新增 CSS；
    Teleport 到 body —— 祖先带 transform 时 position:fixed 会相对祖先定位（踩过）。
  -->
  <Teleport to="body">
    <div v-if="showPreview && preview" class="confirm-layer" id="snapPreview">
      <div class="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="snapPreviewTitle">
        <h2 class="confirm-title" id="snapPreviewTitle">{{ t('snap.previewTitle') }}</h2>

        <p class="banner-text" id="snapPreviewModules">
          <template v-if="preview.willPack">
            {{ t('snap.willPack', { n: preview.plugins.length, size: mb(preview.modulesBytes) }) }}
          </template>
          <template v-else>{{ t('snap.noModules') }}</template>
        </p>

        <ul class="banner-text" id="snapPreviewPlugins" v-if="preview.plugins.length > 0">
          <li v-for="p in preview.plugins" :key="p.name">{{ p.name }}{{ p.version ? '  ' + p.version : '' }}</li>
        </ul>

        <div class="confirm-actions">
          <button type="button" class="main-button" id="snapConfirm" :disabled="busy" @click="confirmCreate">
            {{ t('snap.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
