<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SampleTag from '@/components/SampleTag.vue'
import { api, SAMPLE_DATA, type SettingsPayload, type LauncherUpdateInfo } from '@/api'
import { useLocaleStore } from '@/stores/locale'
import type { LocaleName } from '@/i18n'

/**
 * 设置页（原版 `#view-preferences`）。
 *
 * ── 为什么只剩四项 ──
 * 原版这一页有九项，其中四项**对这个启动器没有对应物**，已删除：
 *   · 管理页端口 —— 原版的界面本身是本地 HTTP 服务（`http://127.0.0.1:3780/`），端口可能被占所以要能改。
 *     本应用的界面是 Electron 窗口、**没有自己的服务**，所以那一项没有对应物。
 *     取而代之的是下面的**启动端口**：它管的是 dsh web 服务绑哪个端口。
 *     （原来是 `--port 0` 让系统随便挑 —— 永远不会冲突，但每次地址都不一样，用户没法收藏、
 *       也没法记住。现在固定，默认 3080；被占用时自动回退并说明原因。）
 *   · 版本目录 —— 版本池刻意固定在应用旁边（`<app>/dsh`），这是"便携、可整份删掉重建"的前提，不该开放修改。
 *   · 兼容模式 —— 对应原版"启动失败自动禁用插件并重试"，那套逻辑没有移植，留着是空开关。
 *   · 插件市场 —— 市场是内置库（dshmarket），不是能开关的东西。
 *
 * 剩下五项里，**界面语言是立即生效的**（接到 UI store 的 locale），
 * 另外四项（自启 / 额外参数 / 启动 profile / 启动端口）等主进程的设置存储落地后才是真的 ——
 * 所以这一页挂着 `SAMPLE_DATA.settings` 的标注，界面会明确写出"仍是样例"，不假装保存成功。
 *
 * 「启动 profile」保留为下拉框是**刻意的占位**：目前只有 `web` 可用，`tui` 作为不可选项列出，
 * 将来官方支持时把它改成可选即可（dsh 目前随包的是 web / acp / sdk / headless）。
 */
const { t } = useI18n()
const uiLang = useLocaleStore()

const draft = ref<SettingsPayload | null>(null)
const savedHint = ref('')

/**
 * 可选的「启动方式」。
 *
 * - `web` / `tui` 是 dsh 的 profile，直接 spawn `node bin.js <profile>`；
 * - `desktop` 不是 dsh 的 profile，而是官方桌面端（另一个 Electron 应用），
 *   由主进程「下载对应版本安装包 → 静默安装 → 启动」；
 * - `headless` 等不能在启动器窗口里跑，保持禁用。
 */
const PROFILES: Array<{ value: string; available: boolean; label: string }> = [
  { value: 'web', available: true, label: 'web' },
  { value: 'tui', available: true, label: 'tui' },
  { value: 'desktop', available: true, label: t('settings.modeDesktop') },
  { value: 'headless', available: false, label: 'headless' }
]

/** 语言下拉的取值与原版一致（'zh' / 'en'），到 locale 名要过一次映射 */
const LANG_TO_LOCALE: Record<string, LocaleName> = { zh: 'zh-CN', en: 'en-US' }

watch(
  () => draft.value?.lang,
  (lang) => {
    const locale = lang ? LANG_TO_LOCALE[lang] : undefined
    if (locale && locale !== uiLang.locale) uiLang.switchLocale(locale)
  }
)

/**
 * 选数据目录。走主进程的原生选择器（渲染层没有 Node）。
 * 取消时**不要清空**已有值 —— 用户按了取消，不是要清掉。
 */
/**
 * 选快照目录。默认位置在应用目录下的 snapshots，C 盘紧张时用户可以挪走。
 * 同样：取消时不要清空已有值。
 */
/** 选版本池位置。留空 = 默认位置（应用目录隔壁），界面里不显示任何绝对路径 */
async function pickPoolDir(): Promise<void> {
  const picked = await window.sesame.window.pickDirectory()
  if (picked !== null && draft.value) draft.value.poolDir = picked
}

async function pickSnapshotDir(): Promise<void> {
  const picked = await window.sesame.window.pickDirectory()
  if (picked !== null && draft.value) draft.value.snapshotDir = picked
}

async function pickDshHome(): Promise<void> {
  const picked = await window.sesame.window.pickDirectory()
  if (picked !== null && draft.value) draft.value.dshHome = picked
}

async function save(): Promise<void> {
  if (!draft.value) return
  const next = await api.saveSettings({ ...draft.value })
  draft.value = next
  savedHint.value = t('settings.saved')
}

/* ---------------- 启动器自己的更新 ---------------- */

/**
 * 更新状态。
 *
 * 与上面那些"设置项"分开：它们写进 `settings.json`，而这些是**每次打开页面重新查的**
 * 临时状态（远端有没有新版），不该落盘。
 */
const updateInfo = ref<LauncherUpdateInfo | null>(null)
const updateChecking = ref(false)
/** 正在下载/安装 —— 此时按钮禁用、进度可见 */
const updateInstalling = ref(false)
const updateProgress = ref('')
const updateError = ref('')

/** 安装包大小，给用户一个"要下多久"的预期；读不到就不显示 */
const updateSizeMb = computed(() => {
  const bytes = updateInfo.value?.assetBytes ?? 0
  return bytes > 0 ? Math.round(bytes / 1024 / 1024) : 0
})

/**
 * 检查更新。**不抛异常**（主进程那边也不会）——
 * 失败时把原因放进 `updateError`，页面照常可用。
 */
async function checkUpdate(): Promise<void> {
  updateChecking.value = true
  updateError.value = ''
  try {
    updateInfo.value = await api.checkLauncherUpdate()
    if (updateInfo.value.error !== '') updateError.value = updateInfo.value.error
  } catch (cause) {
    updateError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    updateChecking.value = false
  }
}

/**
 * 下载并安装。
 *
 * **成功时这个 await 不会返回** —— 主进程会让应用退出，安装器接着把新版拉起来。
 * 所以这里只处理失败分支，不写"更新成功"这种提示。
 */
async function runUpdate(): Promise<void> {
  if (updateInstalling.value) return
  updateInstalling.value = true
  updateError.value = ''
  try {
    await api.installLauncherUpdate()
  } catch (cause) {
    updateError.value = cause instanceof Error ? cause.message : String(cause)
    updateInstalling.value = false
    updateProgress.value = ''
  }
}

/**
 * 进度订阅。挂在组件生命周期上，离开设置页就退订。
 *
 * 订阅放在 `onMounted` 而不是 `runUpdate` 里：进度可能在"安装"阶段才到，
 * 那时 `runUpdate` 已经在等 Promise 了 —— 先订阅不会漏。
 */
let offUpdateProgress: (() => void) | null = null

onMounted(async () => {
  draft.value = await api.getSettings()
  offUpdateProgress = api.onLauncherUpdateProgress((event) => {
    updateProgress.value = event.text
  })
  // 打开页面就查一次：这样按钮上直接显示"更新到 x.y.z"，不用用户先点一下
  void checkUpdate()
})

onBeforeUnmount(() => offUpdateProgress?.())
</script>

<template>
  <div id="view-preferences" class="view view-active">
    <div class="panel preferences" v-if="draft">
      <div class="settings-head">
        <SampleTag v-if="SAMPLE_DATA.settings" />
      </div>

      <label class="form-row">
        <span>{{ t('settings.profile') }}</span>
        <select id="profile" v-model="draft.profile">
          <option v-for="item in PROFILES" :key="item.value" :value="item.value" :disabled="!item.available">
            {{ item.label }}
          </option>
        </select>
      </label>

      <!--
        启动端口。固定端口的意义是"地址可预期"：能存书签、能记住。
        被占用时**自动回退**到系统分配的空闲端口，但会在终端页写明"哪个被占、为什么、换到了哪"
      -->
      <!--
        数据目录（DSH_HOME）。留空 = 用 DSH_HOME 环境变量或默认的 ~/.dsh。
        改它等于换一整套数据目录 —— 界面会像"一个插件都没有"，那不是坏了，
        是看的是另一个目录。正在运行的 dsh 要重启才会用新路径。
      -->
      <label class="form-row wide">
        <span>{{ t('settings.dshHome') }}</span>
        <!-- 输入框 + 浏览按钮并排：用原版就有的 .inline-input 结构，不自己发明布局 -->
        <div class="inline-input">
          <input
            id="dshHome"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('settings.dshHomePlaceholder')"
            v-model="draft.dshHome"
          />
          <button class="subtle-button" id="pickDshHome" type="button" @click="pickDshHome">
            {{ t('settings.browse') }}
          </button>
        </div>
      </label>

      <label class="form-row wide">
        <span>{{ t('settings.snapshotDir') }}</span>
        <div class="inline-input">
          <input
            id="snapshotDir"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('settings.snapshotDirPlaceholder')"
            v-model="draft.snapshotDir"
          />
          <button class="subtle-button" id="pickSnapshotDir" type="button" @click="pickSnapshotDir">
            {{ t('settings.browse') }}
          </button>
        </div>
      </label>

      <label class="form-row wide">
        <span>{{ t('settings.poolDir') }}</span>
        <div class="inline-input">
          <input
            id="poolDir"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('settings.poolDirPlaceholder')"
            v-model="draft.poolDir"
          />
          <button class="subtle-button" id="pickPoolDir" type="button" @click="pickPoolDir">
            {{ t('settings.browse') }}
          </button>
        </div>
      </label>

      <label class="form-row">
        <span>{{ t('settings.port') }}</span>
        <input id="port" type="number" min="1024" max="65535" step="1" v-model.number="draft.port" />
      </label>

      <label class="toggle">
        <span>{{ t('settings.autoStart') }}</span>
        <input id="autoStart" type="checkbox" v-model="draft.autoStart" />
      </label>

      <label class="form-row">
        <span>{{ t('settings.uiLang') }}</span>
        <select id="uiLang" v-model="draft.lang">
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </label>

      <label class="form-row wide">
        <span>{{ t('settings.args') }}</span>
        <input
          id="args"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('settings.argsPlaceholder')"
          v-model="draft.args"
        />
      </label>

      <button class="main-button" id="saveSettings" type="button" style="margin-top: 22px" @click="save">
        {{ t('settings.save') }}
      </button>
      <p class="status-line" id="settingsHint">{{ savedHint }}</p>

      <!--
        启动器自己的更新。与上面那些设置项分开：
        那些写进 settings.json，这个是"远端有没有新版"的临时状态。
      -->
      <div class="settings-update" id="launcherUpdate">
        <div class="update-head">
          <strong>{{ t('settings.updateSection') }}</strong>
          <span class="update-current">
            {{ t('settings.updateCurrent', { version: updateInfo?.current ?? '…' }) }}
          </span>
        </div>

        <!--
          主按钮：有新版时是"更新到 x.y.z"，否则是"检查更新"。
          正在安装时禁用 —— 更新过程中不能再点。
        -->
        <div class="update-actions">
          <button
            v-if="updateInfo?.available"
            class="main-button"
            id="updateInstall"
            type="button"
            :disabled="updateInstalling"
            @click="runUpdate"
          >
            {{ updateInstalling ? t('settings.updateInstalling') : t('settings.updateInstall', { version: updateInfo.latest }) }}
          </button>
          <button
            v-else
            class="subtle-button"
            id="updateCheck"
            type="button"
            :disabled="updateChecking || updateInstalling"
            @click="checkUpdate"
          >
            {{ updateChecking ? t('settings.updateChecking') : t('settings.updateCheck') }}
          </button>
        </div>

        <!-- 进度 / 结果 / 失败原因：有哪个显示哪个，都没有就显示一句引导 -->
        <p class="status-line" id="updateStatus">
          <template v-if="updateInstalling && updateProgress">{{ updateProgress }}</template>
          <template v-else-if="updateError">{{ updateError }}</template>
          <template v-else-if="updateInfo?.available">
            {{ updateSizeMb > 0 ? t('settings.updateSizeHint', { mb: updateSizeMb }) : '' }}
          </template>
          <template v-else-if="updateInfo">{{ t('settings.updateLatest') }}</template>
          <template v-else>{{ t('settings.updateIdle') }}</template>
        </p>

        <!-- 查看更新内容：走主进程开系统浏览器（渲染层没有网络、也不能开外链） -->
        <button
          v-if="updateInfo?.available && updateInfo.releaseUrl"
          class="subtle-button"
          id="updateNotes"
          type="button"
          @click="api.openExternal(updateInfo.releaseUrl)"
        >
          {{ t('settings.updateSection') }} ↗
        </button>
      </div>
    </div>
  </div>
</template>
