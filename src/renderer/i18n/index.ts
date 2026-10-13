import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

export const LOCALES = ['zh-CN', 'en-US'] as const
export type LocaleName = (typeof LOCALES)[number]

/**
 * 双语。
 *
 * 这里用语义化 key（而不是拿中文原文当 key），便于改文案与复用。
 * 好处是文案改动不必回头改调用点、英文缺失一眼能看出来；代价是移植时必须逐个对照
 * 原词典，不能机械替换。对照表见 docs/migration-map.md。
 */
export const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN' satisfies LocaleName,
  fallbackLocale: 'zh-CN' satisfies LocaleName,
  messages: { 'zh-CN': zhCN, 'en-US': enUS }
})

export function setLocale(locale: LocaleName): void {
  i18n.global.locale.value = locale
  document.documentElement.lang = locale === 'en-US' ? 'en' : 'zh-CN'
}
