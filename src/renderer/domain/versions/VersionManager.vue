<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useVersionsStore } from '@/domain/versions/stores/versions'

/**
 * 版本管理。
 *
 * 数据是**真实的**：主进程扫 `<应用目录>/dsh/<版本号>` 与 npm 全局根目录得到"已安装"，
 * 再从 npm registry 拉**全部**远端版本。本页按要求列出所有远端版本，并标注每一行的状态。
 *
 * 「最新」用的是跨 tag 取 semver 最高的那个，不是 dist-tags.latest ——
 * 实测 dsh 的 latest 标签(0.1.5-rc.3)比 alpha(0.1.7-alpha.2)还旧，直接信 latest 会推出降级。
 */
const { t } = useI18n()
const store = useVersionsStore()

interface Row {
  version: string
  installed: boolean
  running: boolean
  latest: boolean
  /** 是否出现在远端列表里；不在的是本地残留/手工放置的 */
  fromRemote: boolean
}

/** 合并：远端全部版本 + 本地已装但远端没有的（不能因为远端没有就把本地版本藏起来） */
const rows = computed<Row[]>(() => {
  const installedMap = new Map(store.installed.map((item) => [item.version, item]))
  const list: Row[] = store.remoteVersions.map((version) => {
    const hit = installedMap.get(version)
    return {
      version,
      installed: Boolean(hit),
      running: hit?.status === 'running',
      latest: version === store.latest,
      fromRemote: true
    }
  })
  for (const item of store.installed) {
    if (store.remoteVersions.includes(item.version)) continue
    list.push({
      version: item.version,
      installed: true,
      running: item.status === 'running',
      latest: item.version === store.latest,
      fromRemote: false
    })
  }
  return list
})

const subtitle = computed(() => {
  if (store.loading) return ''
  return t('versions.subtitle', {
    installed: store.installed.length,
    remote: store.remoteVersions.length
  })
})

/** 版本池只有本应用自己装的，所以"已装"就一定能卸 —— 唯一例外是它正在跑 */
function canUninstall(row: Row): boolean {
  return row.installed && !row.running && !store.isBusy
}

function uninstallTitle(row: Row): string {
  return row.running ? t('versions.uninstallRunningHint') : t('versions.uninstall')
}

onMounted(() => {
  void store.load()
})
</script>

<template>
  <div class="module-head">
    <div>
      <div class="module-title">{{ t('versions.title') }}</div>
      <div class="module-sub" id="versionSub">{{ subtitle }}</div>
    </div>
    <button
      class="subtle-button"
      id="versionRefresh"
      type="button"
      :disabled="store.loading || store.isBusy"
      @click="store.load()"
    >
      {{ t('versions.refresh') }}
    </button>
  </div>

  <div class="module-list" id="versionList">
    <div v-if="store.loading" class="module-empty">{{ t('common.loading') }}</div>
    <div v-else-if="!rows.length" class="module-empty">{{ t('versions.noRemote') }}</div>
    <div v-for="row in rows" v-else :key="row.version" class="version-row" :data-version="row.version">
      <span class="version-main">
        <span class="version-name">
          {{ row.version }}
          <span v-if="row.running" class="tag">{{ t('status.running') }}</span>
          <span v-else-if="row.latest" class="tag">{{ t('status.latest') }}</span>
          <span v-if="row.installed" class="tag muted">{{ t('status.installed') }}</span>
        </span>
        <span class="version-meta">
          {{ row.installed ? t('versions.managedMeta') : row.fromRemote ? t('versions.notInstalled') : t('versions.localOnly') }}
        </span>
      </span>
      <button
        v-if="row.installed"
        class="subtle-button danger"
        type="button"
        :disabled="!canUninstall(row)"
        :title="uninstallTitle(row)"
        @click="store.uninstall(row.version)"
      >
        {{ store.busy === row.version ? t('versions.uninstalling') : t('versions.uninstall') }}
      </button>
      <button
        v-else
        class="subtle-button"
        type="button"
        :disabled="store.isBusy"
        @click="store.install(row.version)"
      >
        {{ store.busy === row.version ? t('versions.downloading') : t('versions.download') }}
      </button>
    </div>
  </div>

  <p class="status-line" id="versionHint">
    <template v-if="store.error">{{ store.error }}</template>
    <template v-else-if="store.busy && store.progressText">{{ store.progressText }}</template>
    <template v-else-if="store.remoteError">
      {{ t('versions.remoteFailed', { message: store.remoteError }) }}
    </template>
  </p>
</template>
