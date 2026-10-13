import { defineStore } from 'pinia'
import { ref } from 'vue'
import { setLocale, type LocaleName } from '@/i18n'

/**
 * 界面语言。
 *
 * **应用级**状态而不是"设置页的状态"：它改的是全局 i18n 实例与
 * `document.documentElement.lang`，影响所有页面；设置页只是它的**编辑入口**。
 * （所以它放在 `app/`，而不是 `domain/settings/` —— 否则改语言这件事会显得
 * 像是设置页的私事，而实际上每个页面都在消费它。）
 */
export const useLocaleStore = defineStore('locale', () => {
  const locale = ref<LocaleName>('zh-CN')

  function switchLocale(next: LocaleName): void {
    locale.value = next
    setLocale(next)
  }

  return { locale, switchLocale }
})
