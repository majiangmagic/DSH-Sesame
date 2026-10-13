<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api'

/**
 * 终端页（原版 `#view-console`）。
 *
 * **真实数据**：来源是主进程的日志环形缓冲（`src/main/domain/terminal/logbus.ts`），内容是
 *   1. dsh 子进程的 stdout/stderr —— 启动、就绪地址、插件加载报错、退出码；
 *   2. 启动器的操作事件 —— 启停版本、插件增删。
 * 进入页面时取一次快照，之后靠主进程推送逐行追加，所以切走再回来不丢历史。
 *
 * 「清空」清的是**主进程那份缓冲**（`api.clearLog()`），不只是清视图 ——
 * 否则下次进入页面历史又"复活"，看起来像清空没生效。
 */
const { t } = useI18n()

const lines = ref<string[]>([])
const preEl = ref<HTMLElement | null>(null)

/** 与主进程缓冲同一个上限，避免两边不一致 */
const LIMIT = 3000

function scrollToBottom(): void {
  void nextTick(() => {
    const el = preEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function clear(): Promise<void> {
  await api.clearLog()
  lines.value = []
}

let off: (() => void) | null = null

onMounted(async () => {
  lines.value = await api.getLog()
  scrollToBottom()
  // 用新数组而不是 push：ref 数组原地改动不会触发更新
  off = api.onLogLine((line) => {
    const next = [...lines.value, line]
    lines.value = next.length > LIMIT ? next.slice(next.length - LIMIT) : next
    scrollToBottom()
  })
})

onBeforeUnmount(() => off?.())
</script>

<template>
  <div id="view-console" class="view view-active">
    <div class="log-toolbar">
      <button type="button" id="clear" @click="clear">{{ t('terminal.clear') }}</button>
    </div>
    <pre id="console-output" ref="preEl">{{ lines.join('\n') }}</pre>
  </div>
</template>
