/**
 * 插件相关类型：主进程读 `cordis.patch.yml` 产出，渲染层消费。
 */

/**
 * 不可开关的原因码。
 *
 * 原版后端直接返回中文整句，前端再把这句中文当作 i18n 的 key 去查英文 —— 后端于是被迫知道
 * 界面语言。这里只回原因码，文案交给前端 locale。
 *
 * 判定顺序是 `no-rows` → `official` → `market-owned`，顺序不能换：官方包若没有可开关的加载行，
 * 报的应该是"没有可开关的加载行"，因为那才是它当下不可开关的真实原因。
 */
export type PluginReason = '' | 'no-rows' | 'official' | 'market-owned'

export interface PluginEntry {
  name: string
  version: string
  /**
   * profile 的 package.json 里写的版本范围或来源，例如 `^0.19.1`、`~1.2.0`、
   * `github:owner/repo#<sha>`。用来判断"能不能用版本号更新"：
   * git / file / link 这类来源没有"更新到某版本"的语义，界面上不该给更新按钮。
   */
  spec: string
  /** 这个包拥有的 loader 行 id；空数组意味着没有可写的行 */
  ids: string[]
  enabled: boolean
  toggleable: boolean
  reason: PluginReason
  /** `@deepseek-ai/*`：官方运行时，界面默认不展示 */
  official: boolean
}

export interface PluginList {
  profile: string
  profileDir: string
  patchPath: string
  plugins: PluginEntry[]
  /** 补丁层里当前写着 disabled: true 的行 id */
  disables: string[]
}
