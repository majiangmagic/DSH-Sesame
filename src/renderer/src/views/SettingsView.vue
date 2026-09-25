<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SampleTag from '@/components/SampleTag.vue'
import { api, SAMPLE_DATA, type SettingsPayload } from '@/api'
import { useUiStore } from '@/stores/ui'
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
const ui = useUiStore()

const draft = ref<SettingsPayload | null>(null)
const savedHint = ref('')

/**
 * 可选的启动 profile。
 *
 * **`tui` 已放开为可选**（按需求），但选了它启动会**明确失败** ——
 * tui 是终端界面，需要一个真正的终端窗口（TTY），启动器这个窗口里没有终端。
 * 主进程在 spawn 之前就会拦下并给出该敲的命令（见 `src/main/runner.ts` 的守卫），
 * 而不是让它干等 180 秒超时。
 *
 * acp / sdk / headless 同理不能放进启动器，所以这里仍然只列 web 与 tui。
 */
const PROFILES: Array<{ value: string; available: boolean }> = [
  { value: 'web', available: true },
  { value: 'tui', available: true },
  { value: 'headless', available: false }
]

/** 语言下拉的取值与原版一致（'zh' / 'en'），到 locale 名要过一次映射 */
const LANG_TO_LOCALE: Record<string, LocaleName> = { zh: 'zh-CN', en: 'en-US' }

watch(
  () => draft.value?.lang,
  (lang) => {
    const locale = lang ? LANG_TO_LOCALE[lang] : undefined
    if (locale && locale !== ui.locale) ui.switchLocale(locale)
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

onMounted(async () => {
  draft.value = await api.getSettings()
})
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
            {{ item.value }}
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
    </div>
  </div>
</template>
