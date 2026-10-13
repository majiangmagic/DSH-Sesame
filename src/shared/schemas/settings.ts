import type { LauncherSettingsPayload } from '@shared/types/settings'

/**
 * 启动器设置的**运行时校验**。
 *
 * 为什么在 `shared/`：`LauncherSettingsPayload` 是跨进程共享的类型，
 * 而"这个载荷是不是合法"这件事两边都关心 —— 主进程写入前必须验，
 * 渲染层也可以在提交前先挡一道（目前只有主进程在验）。
 *
 * 为什么单独一份而不是散在 IPC 处理函数里：那个函数原本是 8 个展开的
 * `typeof x === ...` 三元表达式，混在通道注册里，看通道注册时得先把校验读完。
 * 现在"形状"归这里、"编排"归 `main/domain/settings/apply.ts`、"通道"归 `main/ipc/settings.ts`。
 *
 * 注意这里的校验是**逐字段宽容**的：认不出的字段直接丢掉，不报错。
 * 因为渲染层可能比主进程新（比如前端先加了字段），报错会让整个保存失败 ——
 * 而丢掉一个新字段只是"这次没存上"，下次前端与后端对齐后自然就好了。
 */

/** 端口必须是 1024~65535 的整数；1024 以下需要管理员权限 */
export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535
}

/** 界面语言只有两种 */
export function isValidLang(value: unknown): value is LauncherSettingsPayload['lang'] {
  return value === 'zh' || value === 'en'
}

/** 非空字符串，且去掉首尾空白 */
function trimmedNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/**
 * 把一个来路不明的补丁收敛成**可以安全写盘的**部分设置。
 *
 * 只保留认得出的字段；每个字段各自校验，某一项不合法**不影响其它项** ——
 * 所以界面上一项填错不会导致整次保存失败。
 */
export function normalizeSettingsPatch(input: unknown): Partial<LauncherSettingsPayload> {
  if (input === null || typeof input !== 'object') return {}
  const patch = input as Record<string, unknown>
  const out: Partial<LauncherSettingsPayload> = {}

  if (typeof patch['autoStart'] === 'boolean') out.autoStart = patch['autoStart']
  if (isValidLang(patch['lang'])) out.lang = patch['lang']
  if (typeof patch['args'] === 'string') out.args = patch['args']
  if (trimmedNonEmpty(patch['profile']) !== null) out.profile = trimmedNonEmpty(patch['profile']) as string

  // 这三个目录**允许空串**（空 = 用默认位置），所以不能用 trimmedNonEmpty
  for (const key of ['dshHome', 'snapshotDir', 'poolDir'] as const) {
    if (typeof patch[key] === 'string') out[key] = (patch[key] as string).trim()
  }

  if (isValidPort(patch['port'])) out.port = patch['port']

  return out
}
