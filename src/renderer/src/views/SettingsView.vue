<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SampleTag from '@/components/SampleTag.vue'
import { api, SAMPLE_DATA, type SettingsPayload } from '@/api'
import { useUiStore } from '@/stores/ui'
import type { LocaleName } from '@/i18n'

/**
 * 设置页（原版 `#page-settings`）。
 *
 * ── 为什么只剩四项 ──
 * 原版这一页有九项，其中四项**对这个启动器没有对应物**，已删除：
 *   · 管理页端口 —— 原版的界面本身是本地 HTTP 服务（`http://127.0.0.1:3780/`），端口可能被占所以要能改。
 *     本应用的界面是 Electron 窗口，**没有自己的服务**；dsh 的 web 端口用 `--port 0` 由系统挑，也不该让用户填。
 *   · 版本目录 —— 版本池刻意固定在应用旁边（`<app>/dsh`），这是"便携、可整份删掉重建"的前提，不该开放修改。
 *   · 兼容模式 —— 对应原版"启动失败自动禁用插件并重试"，那套逻辑没有移植，留着是空开关。
 *   · 插件市场 —— 市场是内置库（dshmarket），不是能开关的东西。
 *
 * 剩下四项里，**界面语言是立即生效的**（接到 UI store 的 locale），
 * 另外三项（自启 / 额外参数 / 启动 profile）等主进程的设置存储落地后才是真的 ——
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
  <div id="page-settings" class="page active">
    <div class="card settings" v-if="draft">
      <div class="settings-head">
        <SampleTag v-if="SAMPLE_DATA.settings" />
      </div>

      <label class="field">
        <span>{{ t('settings.profile') }}</span>
        <select id="profile" v-model="draft.profile">
          <option v-for="item in PROFILES" :key="item.value" :value="item.value" :disabled="!item.available">
            {{ item.value }}
          </option>
        </select>
      </label>

      <label class="toggle">
        <span>{{ t('settings.autoStart') }}</span>
        <input id="autoStart" type="checkbox" v-model="draft.autoStart" />
      </label>

      <label class="field">
        <span>{{ t('settings.uiLang') }}</span>
        <select id="uiLang" v-model="draft.lang">
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </label>

      <label class="field wide">
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
      <p class="hint">{{ t('settings.argsHint') }}</p>

      <label class="field">
        <span>{{ t('settings.profile') }}</span>
        <select id="profile" v-model="draft.profile">
          <option v-for="item in PROFILES" :key="item.value" :value="item.value" :disabled="!item.available">
            {{ item.value }}
          </option>
        </select>
      </label>

      <button class="primary" id="saveSettings" type="button" style="margin-top: 22px" @click="save">
        {{ t('settings.save') }}
      </button>
      <p class="hint" id="settingsHint">{{ savedHint }}</p>
    </div>
  </div>
</template>
