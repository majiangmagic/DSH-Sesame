import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { VersionOverview } from '@shared/versions'
import { api } from '@/api'

/** 生命周期动作。'idle' 之外都表示"正在忙"，界面据此显示对应文案与转圈。 */
export type VersionAction = 'idle' | 'starting' | 'stopping' | 'restarting' | 'updating'

/**
 * 版本状态 + 生命周期动作。
 *
 * 数据来自**真实实现**：`api.getVersionOverview()` → IPC → 主进程扫目录 + 拉 registry。
 * 控制页的版本下拉与「版本」页读的是同一份，所以放 store 里，避免两处不一致。
 */
export const useVersionsStore = defineStore('versions', () => {
  const overview = ref<VersionOverview | null>(null)
  const loading = ref(true)
  const error = ref('')

  /** 正在下载/卸载的版本号，用于把对应那行的按钮切成"下载中…/卸载中…" */
  const busy = ref<string | null>(null)
  /** 正在进行的生命周期动作 */
  const action = ref<VersionAction>('idle')
  /** 主进程推来的安装进度文本，界面在提示行显示 */
  const progressText = ref('')

  const installed = computed(() => overview.value?.installed ?? [])
  /** 给下拉用：只有已安装的版本号（控制页要求） */
  const installedNumbers = computed(() => installed.value.map((item) => item.version))
  const installedSet = computed(() => new Set(installedNumbers.value))

  /** 版本安装根目录（应用旁边的相对路径） */
  const root = computed(() => overview.value?.root ?? '')

  /** 远端版本表：**全部**版本，不只是"可下载的" */
  const remote = computed(() => overview.value?.remote ?? null)
  const remoteVersions = computed(() => remote.value?.versions ?? [])
  const remoteError = computed(() => overview.value?.remoteError ?? '')

  /** 跨 tag 取 semver 最高的那个（不是 dist-tags.latest） */
  const latest = computed(() => remote.value?.latest ?? '')
  /** dist-tags.latest 原值，单独留出来做对照 */
  const tagLatest = computed(() => remote.value?.tagLatest ?? '')

  const running = computed(() => installed.value.find((item) => item.status === 'running') ?? null)
  const runningVersion = computed(() => running.value?.version ?? '')
  const isRunning = computed(() => running.value?.status === 'running')

  const isStarting = computed(() => action.value === 'starting' || action.value === 'restarting')
  const isStopping = computed(() => action.value === 'stopping')
  const isBusy = computed(() => action.value !== 'idle' || busy.value !== null)
  /** 安装进度：主进程还没上报，先恒为 false */
  const installing = computed(() => false)

  function fail(cause: unknown): void {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      overview.value = await api.getVersionOverview()
      // 远端拉取失败不算致命：已装版本照常显示，只有远端那一列空着
      if (overview.value.remoteError === '') error.value = ''
    } catch (cause) {
      fail(cause)
    } finally {
      loading.value = false
    }
  }

  async function install(version: string): Promise<void> {
    if (isBusy.value) return
    busy.value = version
    progressText.value = ''
    error.value = ''
    try {
      await api.installVersion(version, (progress) => {
        progressText.value = progress.text
      })
      await load()
    } catch (cause) {
      fail(cause)
    } finally {
      busy.value = null
      progressText.value = ''
    }
  }

  async function uninstall(version: string): Promise<void> {
    if (isBusy.value) return
    busy.value = version
    error.value = ''
    try {
      await api.uninstallVersion(version)
      await load()
    } catch (cause) {
      fail(cause)
    } finally {
      busy.value = null
    }
  }

  async function start(version: string): Promise<void> {
    if (isBusy.value || version === '') return
    action.value = 'starting'
    error.value = ''
    progressText.value = ''
    try {
      // 桌面端会推「下载 → 安装 → 启动」的进度；web/tui 不推，progressText 保持空
      await api.startVersion(version, (progress) => {
        progressText.value = progress.text
      })
      await load()
      // 启动成功后默认用系统浏览器打开 web UI。
      // startVersion 会等到 dsh 打印就绪地址才 resolve，所以这里 url 通常已经在了；
      // 桌面端返回 url=null，不会走到 openExternal —— 桌面窗口本身就是反馈。
      const url = running.value?.url
      if (url) void window.sesame.openExternal(url)
    } catch (cause) {
      fail(cause)
    } finally {
      action.value = 'idle'
      progressText.value = ''
    }
  }

  async function stop(): Promise<void> {
    if (isBusy.value || !running.value) return
    action.value = 'stopping'
    error.value = ''
    try {
      await api.stopVersion()
      await load()
    } catch (cause) {
      fail(cause)
    } finally {
      action.value = 'idle'
    }
  }

  /** 重启 = 先停再启（原版也是这个次序） */
  async function restart(version: string): Promise<void> {
    if (isBusy.value || version === '') return
    action.value = 'restarting'
    error.value = ''
    try {
      await api.stopVersion()
      await api.startVersion(version)
      await load()
    } catch (cause) {
      fail(cause)
    } finally {
      action.value = 'idle'
    }
  }

  /** 更新 = 下载并安装远端"最新"（跨 tag 取最高，不是 dist-tags.latest） */
  async function update(): Promise<void> {
    if (isBusy.value || !latest.value) return
    action.value = 'updating'
    progressText.value = ''
    error.value = ''
    try {
      await api.installVersion(latest.value, (progress) => {
        progressText.value = progress.text
      })
      await load()
    } catch (cause) {
      fail(cause)
    } finally {
      action.value = 'idle'
      progressText.value = ''
    }
  }

  function clearError(): void {
    error.value = ''
  }

  return {
    overview,
    loading,
    busy,
    action,
    progressText,
    error,
    installed,
    installedNumbers,
    installedSet,
    root,
    remote,
    remoteVersions,
    remoteError,
    latest,
    tagLatest,
    running,
    runningVersion,
    isRunning,
    isStarting,
    isStopping,
    isBusy,
    installing,
    load,
    install,
    uninstall,
    start,
    stop,
    restart,
    update,
    clearError
  }
})
