<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import PluginPanel from '@/components/PluginPanel.vue'
import ProgressBar from '@/components/ProgressBar.vue'
import VersionSelect, { type VersionOption } from '@/components/VersionSelect.vue'
import { useVersionsStore } from '@/stores/versions'
import { useUiStore } from '@/stores/ui'
import { api } from '@/api'
import type { DiagnosisResult } from '@shared/diagnose'

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
const ui = useUiStore()

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
/**
 * 「检查」：限时启动一次并解析 dsh 自己的失败诊断，只取 **Failed plugins** 那一段。
 *
 * 会**真的启动 dsh**（用完即停）—— 要抓"搞坏启动"的插件，harness 连它一起启动是唯一办法。
 * 所以由用户显式点按钮触发，不自动跑。
 */
const diagnosing = ref(false)
const diagnosis = ref<DiagnosisResult | null>(null)
const showDiag = ref(false)

/** 有问题的插件里，哪些是"你的插件"（可禁用）；dsh 自带的标出来但不给禁用 */
const installedNames = ref<Set<string>>(new Set())
const problems = computed(() =>
  (diagnosis.value?.problems ?? []).map((p) => ({
    ...p,
    isPlugin: p.pkg !== null && installedNames.value.has(p.pkg)
  }))
)

const disablable = computed(() => problems.value.filter((p) => p.isPlugin))

async function runCheck(): Promise<void> {
  // 这两个分支原本是静默 return —— 用户点了按钮却什么都没发生，必须给一句话
  if (diagnosing.value) {
    ui.showBubble(t('check.busy'))
    return
  }
  if (selected.value === '') {
    ui.showBubble(t('check.pickVersion'))
    return
  }
  diagnosing.value = true
  try {
    // 先取已装插件清单，用来判断 dsh 报出来的名字是不是"你的插件"
    const list = await api.getPlugins()
    installedNames.value = new Set(list.plugins.map((p) => p.name))
    diagnosis.value = await api.runDiagnosis(selected.value)
    showDiag.value = true
  } catch (cause) {
    ui.showBubble(cause instanceof Error ? cause.message : String(cause))
  } finally {
    diagnosing.value = false
  }
}

/** 一键关闭查出来的那些插件（可逆：插件页能再打开） */
async function disableProblems(): Promise<void> {
  const targets = disablable.value
  if (targets.length === 0) return
  for (const p of targets) {
    await api.setPluginEnabled(p.pkg ?? p.id, false)
  }
  await versions.load()
  showDiag.value = false
  ui.showBubble(t('check.disabled', { names: targets.map((p) => p.pkg ?? p.id).join(', ') }))
}

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
  // 桌面端启动时主进程会推「下载 / 安装」的进度，优先显示它
  if (versions.progressText) return versions.progressText
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
  <div id="view-control" class="view view-active home-stack">
    <div class="panel home">
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
        <div class="action-group">
          <!--
            只留主按钮（启动 / 停止）。原来的「更新」「重启」「卸载」已去掉：
            更新与卸载归到「版本」页（那里逐版本操作），重启可用「停止 → 启动」代替。
          -->
          <button
            class="action-button"
            :class="[isRunning ? 'mode-stop' : 'mode-play', { 'busy': mainLoading }]"
            id="primary-action"
            type="button"
            :disabled="versions.isBusy || selected === ''"
            :aria-label="isRunning ? t('home.actionStop') : t('home.actionStart')"
            :title="isRunning ? t('home.actionStop') : t('home.actionStart')"
            @click="onMainAction"
          >
            <span class="spin" aria-hidden="true"></span>
            <svg class="glyph action-icon-play" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M7 5.9v12.2c0 .74.81 1.2 1.45.82l9.9-6.1a.96.96 0 0 0 0-1.64l-9.9-6.1A.96.96 0 0 0 7 5.9Z"
              />
            </svg>
            <svg class="glyph action-icon-stop" viewBox="0 0 24 24" aria-hidden="true">
              <rect fill="currentColor" x="5" y="5" width="14" height="14" rx="2.6" />
            </svg>
          </button>
      <!-- 检查：限时启动一次并解析 dsh 自己的失败诊断（会真的起 dsh，用完即停） -->
      <button
        type="button"
        class="subtle-button"
        id="checkPlugins"
        :disabled="diagnosing"
        @click="runCheck"
      >
        {{ diagnosing ? t('check.running') : t('check.button') }}
      </button>
        </div>
      </div>
      <p class="status-line" id="status-line">
        <template v-if="showRunningLink">
          {{ t('status.running') }}
          <!-- web/tui 有就绪地址；桌面端（url=null）没有地址，只标明是什么在跑 -->
          <template v-if="versions.running?.url">
            ·
            <a :href="versions.running.url" target="_blank" rel="noreferrer">
              {{ versions.running.url }}
            </a>
          </template>
          <template v-else> · {{ t('status.desktop') }}</template>
        </template>
        <template v-else>{{ hintText }}</template>
      </p>
      <ProgressBar :visible="showProgress" :percent="null" />
    </div>

    <!-- 新增：插件开关（与插件页共用同一份数据；插件页本身保留不动） -->
    <div class="panel" id="homePlugins">
      <PluginPanel />
    </div>
  </div>

  <!--
    诊断结果弹窗。结构照抄 components/overlays/NoticeOverlay.vue，class 全部复用，
    不新增 CSS —— 否则又会变成"自己发明布局"那类问题。
    只列**有问题的插件名**（dsh 的 Failed plugins 那段）。
  -->
  <!--
    Teleport 到 body：祖先若带 transform / filter / backdrop-filter，
    position:fixed 会**相对那个祖先**定位 —— 弹窗因此被困在插件卡片里，
    并被卡片内容盖住，取消按钮点不到（用户实测）。Teleport 是标准解法。
  -->
  <Teleport to="body">
  <div v-if="showDiag && diagnosis" class="confirm-layer" id="diagLayer">
    <div class="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="diagTitle">
      <h2 class="confirm-title" id="diagTitle">{{ t('check.title') }}</h2>

      <!--
        被跳过的 bundle **优先展示**：桌面端模式下这就是唯一的诊断信息（dsh 的 CLI 不接
        desktop profile，拿不到 `Failed plugins` 段）；web 模式下它是"启动成功但有插件没加载"的原因。
      -->
      <template v-if="diagnosis.skipped.length > 0">
        <p class="banner-text">{{ t('check.skipped') }}</p>
        <ul class="banner-text" id="diagSkippedList">
          <li v-for="item in diagnosis.skipped" :key="item.name">
            {{ item.name }} —— {{ item.reason }}
          </li>
        </ul>
      </template>

      <template v-else-if="diagnosis.outcome === 'ready'">
        <p class="banner-text">{{ t('check.ok') }}</p>
      </template>

      <template v-else-if="problems.length > 0">
        <p class="banner-text">
          {{ diagnosis.outcome === 'timeout' ? t('check.timeout') : t('check.failed') }}
        </p>
        <ul class="banner-text" id="diagProblemList">
          <li v-for="p in problems" :key="p.id">
            {{ p.pkg || p.id }}<template v-if="!p.isPlugin">（{{ t('check.builtin') }}）</template>
            <template v-if="p.error"> —— {{ p.error }}</template>
          </li>
        </ul>
      </template>

      <template v-else>
        <p class="banner-text">{{ t('check.noPlugin') }}</p>
        <p class="banner-text" id="diagRawHint">{{ t('check.seeLog') }}</p>
      </template>

      <div class="confirm-actions">
        <button
          v-if="disablable.length > 0"
          type="button"
          class="main-button"
          id="diagDisable"
          @click="disableProblems"
        >
          {{ t('check.disable') }}
        </button>
        <button type="button" class="main-button" id="diagCancel" @click="showDiag = false">
          {{ t('check.cancel') }}
        </button>
      </div>
    </div>
  </div>
  </Teleport>
</template>
