<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api'
import { useUiStore } from '@/stores/ui'
import type { SnapshotEntry, SnapshotPaths } from '@shared/snapshot'

/**
 * 快照管理。
 *
 * 规格（用户定）：文件清单照 dsh-plugin-guard 的 5 个、手动+自动触发、最多保留 10 份、
 * 存在 <userData>/snapshots（**不是安装目录** —— 覆盖安装会把安装目录清空）。
 *
 * 回退的安全性由主进程保证：**回退前会自动先存一份 pre-rollback**，所以回退本身可逆。
 */
const { t } = useI18n()
const ui = useUiStore()

const list = ref<SnapshotEntry[]>([])
const paths = ref<SnapshotPaths | null>(null)
const label = ref('')
const busy = ref(false)

async function refresh(): Promise<void> {
  list.value = await api.listSnapshots()
  paths.value = await api.snapshotPaths()
}

async function create(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await api.createSnapshot(label.value)
    label.value = ''
    await refresh()
    ui.showBubble(t('snap.created'))
  } catch (cause) {
    ui.showBubble(cause instanceof Error ? cause.message : String(cause))
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
    ui.showBubble(t('snap.restored', { n: r.restored.length, backup: r.backupId }))
  } catch (cause) {
    ui.showBubble(cause instanceof Error ? cause.message : String(cause))
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
          <button id="snapCreate" type="button" class="subtle-button" :disabled="busy" @click="create">
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
              <template v-if="s.dshVersion"> · dsh {{ s.dshVersion }}</template>
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
        </li>
      </ul>

      <p class="status-line" id="snapKeep">{{ t('snap.keep') }}</p>
    </div>
  </div>
</template>
