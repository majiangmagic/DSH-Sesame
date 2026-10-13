/**
 * 「桌面端的插件集合与 web 差在哪」—— **纯计算，不做任何 IO，也不决定任何行为**。
 *
 * ## 它现在是"报告"，不是"判断"
 *
 * 早先它决定过"要不要重建"（一致就跳过重建）。**那个用法已经去掉了** ——
 * 它只能看清单与磁盘上的版本号，`node_modules` 里坏掉、缺文件、装了一半的包
 * 在清单上完全看不出来，于是它会说"一致"、然后桌面端带着一个坏掉的依赖启动。
 * 判断一旦有漏，表现就是用户看到的"没同步"。
 *
 * 现在 `syncWebToDesktop` **每次启动都无条件重建**（先把桌面端插件全卸掉，
 * 再按 web 一比一装回来）。这个模块只负责把"差在哪"说清楚，写进进度与终端页 ——
 * 让用户知道那一两分钟花在哪，也方便排查"某个插件怎么又没装上"。
 *
 * ## 为什么单独一个文件、且不 import 任何东西
 *
 *   1. **可脱离 Electron 验证。** 判断规则（比哪几样、怎么算不同）只在这里定义一次，
 *      而它不依赖 electron，所以能用一个普通 Node 脚本直接拿真实 profile 的数据跑它
 *      —— 见 `scripts/check-desktop-mirror.mjs`（`npm run check:mirror`）。
 *   2. **报告与搬运分开。** `control/sync.ts` 负责读盘、跑 dsh CLI、写日志；
 *      "两边到底差在哪"这件事不散落在它里面。
 */

/**
 * 非 registry 来源（git / file / link / tarball）。
 *
 * 这类**必须原样透传**给 pnpm：给它加 `名字@` 前缀会变成"去 npm 装同名的另一个包"
 * （例如 web 里 `dsh-infinite-gen-4` 装的是某个 fork 的具体 commit，按版本号去 npm
 * 装会装成官方那份）。判断集合是否一致时也要单独比它们的规格串 ——
 * 同一个包名可以指向不同 commit，而版本号可能没变。
 */
const NON_REGISTRY_RE = /^(github:|git\+|git:|file:|link:|https?:|\.{0,2}\/)/

export function isNonRegistry(spec: string): boolean {
  return NON_REGISTRY_RE.test(spec)
}

/** 一个 profile 的插件视图 —— 由调用方读好传进来（本模块不碰文件系统）。 */
export interface PluginView {
  /** 清单里的规格串（`package.json` 的 `dependencies`） */
  specs: Record<string, string>
  /** `node_modules` 里**实际装上**的版本；读不到为 null */
  versions: Record<string, string | null>
}

/**
 * 两边的差异，按"差在哪"分类。
 *
 * 注意这些分类**不驱动任何动作**（重建是无条件的），只用于把差异说清楚。
 * 所以文案是"缺 / 多"，而不是"要装 / 要卸"。
 */
export interface MirrorDiff {
  /** web 有、桌面端没有 */
  missing: string[]
  /** **桌面端有、web 没有** —— 就是"临时装的插件"，也正是当初那个"永远清不掉"的 bug */
  extra: string[]
  /** 两边都有，但实际装上的版本不同 */
  versionMismatch: string[]
  /** 两边都有、版本也相同，但非 registry 来源的规格串不同（可能是不同 commit） */
  specMismatch: string[]
}

/**
 * 算出桌面端相对 web 的差异。
 *
 * 比四样东西：
 *   ① 包名集合（多一个、少一个都算）；
 *   ② **实际装上的版本** —— 不能只看清单里写的范围：pnpm 的最小发布年龄闸
 *      会"静默保留旧版本、以退出码 0 结束"，清单写着新版而磁盘上还是旧版；
 *   ③ 非 registry 来源的**规格串本身** —— 同一个包名可以指向不同 commit。
 *
 * ⚠️ **它看不到的东西**：`node_modules` 里坏掉、缺文件、装了一半的包 ——
 * 清单和 `package.json` 的 `version` 字段都是好的。这正是"一致就跳过重建"被去掉的原因：
 * 那种情况恰恰最需要重建，而这个判断会说"一致"。
 */
export function diffMirror(web: PluginView, desktop: PluginView): MirrorDiff {
  const webNames = Object.keys(web.specs).sort()
  const desktopNames = Object.keys(desktop.specs).sort()

  const missing: string[] = []
  const extra: string[] = []
  const versionMismatch: string[] = []
  const specMismatch: string[] = []

  for (const name of webNames) {
    if (!Object.hasOwn(desktop.specs, name)) {
      missing.push(name)
      continue
    }
    if ((web.versions[name] ?? null) !== (desktop.versions[name] ?? null)) {
      versionMismatch.push(name)
      continue
    }
    const spec = web.specs[name] ?? ''
    if (isNonRegistry(spec) && spec !== desktop.specs[name]) specMismatch.push(name)
  }
  for (const name of desktopNames) {
    if (!Object.hasOwn(web.specs, name)) extra.push(name)
  }

  return { missing, extra, versionMismatch, specMismatch }
}

/** 差异为空 = 桌面端在**清单层面**看起来已与 web 一比一（不代表 `node_modules` 是健康的）。 */
export function isEmptyDiff(diff: MirrorDiff): boolean {
  return (
    diff.missing.length === 0 &&
    diff.extra.length === 0 &&
    diff.versionMismatch.length === 0 &&
    diff.specMismatch.length === 0
  )
}

/** 一句话说明差在哪 —— 用于进度与日志，让"这一两分钟花在哪"一眼可见。 */
export function describeDiff(diff: MirrorDiff): string {
  const parts: string[] = []
  if (diff.extra.length > 0) parts.push(`桌面端多 ${diff.extra.length} 个（${diff.extra.join('、')}）`)
  if (diff.missing.length > 0) parts.push(`缺 ${diff.missing.length} 个（${diff.missing.join('、')}）`)
  if (diff.versionMismatch.length > 0) {
    parts.push(`版本不同 ${diff.versionMismatch.length} 个（${diff.versionMismatch.join('、')}）`)
  }
  if (diff.specMismatch.length > 0) {
    parts.push(`来源不同 ${diff.specMismatch.length} 个（${diff.specMismatch.join('、')}）`)
  }
  return parts.join('；')
}
