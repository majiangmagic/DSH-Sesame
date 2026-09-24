<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import PluginPanel from '@/components/PluginPanel.vue'
import ProgressBar from '@/components/ProgressBar.vue'
import VersionSelect, { type VersionOption } from '@/components/VersionSelect.vue'
import { useVersionsStore } from '@/stores/versions'

/**
 * 控制页。
 *
 * 与原版的差别（本次新增需求）：
 *   1. 顶部版本下拉**只列已安装的版本** —— 原版列的是「远端全部版本 + 最新/已装徽标」；
 *   2. 下方新增「插件开关」卡片（与插件页共用同一份数据；插件页本身保留不动）；
 *   3. 页面根节点加了 `home-stack`，让 #view-control 从"居中单卡"变成"顶部纵向卡片流"，
 *      否则两张卡片会叠在一起。样式在 assets/styles/custom.css；
 *   4. **动作按钮只留主按钮（启动 / 停止）**。原版这里有四个（更新 / 重启 / 卸载 / 启动），
 *      现在"更新"和"卸载"都归到「版本」页 —— 那里本来就是逐版本的下载与卸载。
 *      这一页只回答"启哪个版本"，不再承担版本管理。
 *
 * 版本管理**不在这一页**，它是独立的「版本」标签页（views/VersionsView.vue）。
 */
const { t } = useI18n()
const versions = useVersionsStore()

const selected = ref('')

/**
 * 下拉选项：只取已安装版本。
 * 徽标只标"运行中"——列表里已经没有未安装的版本，"已装/可下载"这类徽标就没意义了。
 */
const options = computed<VersionOption[]>(() =>
  versions.installedNumbers.map((version) => ({
    value: version,
    text: version,
    badge: version === versions.runningVersion ? t('status.running') : ''
  }))
)

const isRunning = computed(() => versions.isRunning)

/** 主按钮：在跑就是停止，否则是启动 */
function onMainAction(): void {
  if (isRunning.value) void versions.stop()
  else void versions.start(selected.value)
}

const mainLoading = computed(() => versions.isStarting || versions.isStopping)
const showProgress = computed(() => versions.isBusy)

/**
 * 提示行。优先报错，其次报当前动作，再其次显示运行中的访问地址，最后退回原版那句说明。
 * `runningLink` 单独拎出来是因为那一条里带 <a>，不能当纯文本渲染。
 */
const showRunningLink = computed(
  () => !versions.error && versions.action === 'idle' && versions.busy === null && isRunning.value
)

const hintText = computed(() => {
  if (versions.error) return versions.error
  switch (versions.action) {
    case 'starting':
      return t('progress.starting')
    case 'stopping':
      return t('progress.stopping')
    case 'restarting':
      return t('progress.restarting')
    case 'updating':
      return t('progress.updating')
    default:
      break
  }
  if (isRunning.value) return ''
  return t('home.hint')
})

onMounted(async () => {
  await versions.load()
  // 默认选中正在运行的版本，没有就跑第一个已装的
  selected.value = versions.runningVersion || versions.installedNumbers[0] || ''
})
</script>

<template>
  <div id="view-control" class="page active home-stack">
    <div class="card home">
      <div class="control-bar">
        <div class="control-main">
          <label for="versionTrigger">{{ t('home.versionLabel') }}</label>
          <VersionSelect
            v-model="selected"
            :options="options"
            :disabled="versions.loading || versions.isBusy"
            :placeholder="versions.loading ? t('home.loadingVersion') : t('home.noVersions')"
          />
        </div>
        <div class="controls">
          <!--
            只留主按钮（启动 / 停止）。原来的「更新」「重启」「卸载」已去掉：
            更新与卸载归到「版本」页（那里逐版本操作），重启可用「停止 → 启动」代替。
          -->
          <button
            class="action-button"
            :class="[isRunning ? 'stop' : 'play', { loading: mainLoading }]"
            id="main"
            type="button"
            :disabled="versions.isBusy || selected === ''"
            :aria-label="isRunning ? t('home.actionStop') : t('home.actionStart')"
            :title="isRunning ? t('home.actionStop') : t('home.actionStart')"
            @click="onMainAction"
          >
            <span class="spin" aria-hidden="true"></span>
            <svg class="ico action-icon-play" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M7 5.9v12.2c0 .74.81 1.2 1.45.82l9.9-6.1a.96.96 0 0 0 0-1.64l-9.9-6.1A.96.96 0 0 0 7 5.9Z"
              />
            </svg>
            <svg class="ico action-icon-stop" viewBox="0 0 24 24" aria-hidden="true">
              <rect fill="currentColor" x="5" y="5" width="14" height="14" rx="2.6" />
            </svg>
          </button>
        </div>
      </div>
      <p class="hint" id="hint">
        <template v-if="showRunningLink">
          {{ t('status.running') }} ·
          <a :href="versions.running?.url ?? ''" target="_blank" rel="noreferrer">
            {{ versions.running?.url }}
          </a>
        </template>
        <template v-else>{{ hintText }}</template>
      </p>
      <ProgressBar :visible="showProgress" :percent="null" />
    </div>

    <!-- 新增：插件开关（与插件页共用同一份数据；插件页本身保留不动） -->
    <div class="card" id="homePlugins">
      <PluginPanel />
    </div>
  </div>
</template>
