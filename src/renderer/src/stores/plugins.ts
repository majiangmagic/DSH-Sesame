import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, type PluginEntry, type PluginList } from '@/api'

/**
 * 插件状态。
 *
 * 控制页新加的"插件开关"块和原来的插件页是同一份数据、同一套动作，所以提到 store：
 * 在任一页开关插件，另一页立刻同步，也不会出现两处各拉一次导致状态打架。
 */
export const usePluginsStore = defineStore('plugins', () => {
  const data = ref<PluginList | null>(null)
  const loading = ref(true)
  /** 正在切换的插件包名，用于禁用它的开关避免连点 */
  const toggling = ref<string | null>(null)
  const error = ref('')

  const plugins = computed<PluginEntry[]>(() => data.value?.plugins ?? [])

  /**
   * 副标题所需的**数据**（profile 名、总数、启用数）。
   * 这里刻意不返回拼好的句子：文案属于界面，store 不该知道 i18n，也不该决定用什么语言。
   *
   * 数量从 `plugins` 现算而不是读后端的字段：界面拿到的是过滤后的第三方清单，
   * 若沿用后端的总数，会和实际列出的行数对不上。
   */
  const summary = computed(() => {
    const list = data.value
    if (!list) return null
    const items = list.plugins
    return {
      profile: list.profile || 'web',
      total: items.length,
      on: items.filter((plugin) => plugin.enabled).length
    }
  })

  async function load(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      data.value = await api.getPlugins()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  async function setEnabled(name: string, enabled: boolean): Promise<void> {
    if (toggling.value) return
    toggling.value = name
    error.value = ''
    try {
      await api.setPluginEnabled(name, enabled)
      await load()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      // 失败时把列表拉回真实状态，避免开关停在用户点过的位置上
      await load()
    } finally {
      toggling.value = null
    }
  }

  return { data, loading, toggling, error, plugins, summary, load, setEnabled }
})
