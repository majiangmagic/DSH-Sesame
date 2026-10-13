/**
 * semver 的解析与比较。
 *
 * 为什么放在 `utils/` 而不是主进程里：**渲染层也要用同一份**。
 * 原先有两套实现 —— `main/infra/registry.ts` 里是完整版（含预发布段逐段比较），
 * 渲染层的 `domain/plugins/stores/market.ts` 里是个"只比数字段"的简化版，
 * 而它的注释明说"不处理 pre-release 的复杂排序"。但 dsh 的新版本**常常只挂在
 * alpha / next 上**（实测 `latest=0.1.5-rc.3` 而 `alpha=0.1.7-alpha.2`），
 * 于是那个简化版会把预发布版判成"更新"、甚至把降级当升级 —— 插件页的"有更新"
 * 提示因此可能算错。现在两边共用这一份。
 *
 * 放在 `utils/` 的准入条件（本项目约定）：**不用 Node、不用 DOM、不用 Electron**。
 * 所以主进程与渲染层的 tsconfig 都能 include 它，且不会把 Node 全局泄漏进渲染层。
 *
 * 注意：完整 semver 语义以 `semver` 包为准（诊断模块用它的 `satisfies` 判范围）；
 * 这里只实现**排序与比较**，够用来回答"哪个更新"。
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布段（`-` 之后），无则为空串 */
  pre: string
  raw: string
}

/** 解析版本号；不是版本号形状（比如写了范围或占位）返回 null，调用方据此"不猜"。 */
export function parseVer(version: unknown): ParsedVersion | null {
  const match = String(version).trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    pre: match[4] || '',
    raw: String(version).trim()
  }
}

/** 预发布段逐段比较：数字段按数值比，其它按字典序，数字段小于字母数字段。 */
function cmpPre(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i]
    const r = right[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    if (ln && rn) return Number(l) < Number(r) ? -1 : 1
    if (ln !== rn) return ln ? -1 : 1
    return l < r ? -1 : 1
  }
  return 0
}

/** 返回 >0 表示 a 更新。预发布版**小于**同号正式版（semver 规则）。 */
export function cmpVer(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre && b.pre) return cmpPre(a.pre, b.pre)
  if (a.pre) return -1
  if (b.pre) return 1
  return 0
}

/**
 * 比较两个版本字符串的便利封装。
 *
 * 任一边解析不出来就返回 null —— **刻意不返回 0**：调用方需要区分
 * "相等"和"比不出来"，后者应当保持沉默（不提示更新），而不是当成没差别。
 */
export function compareVersionStrings(a: unknown, b: unknown): number | null {
  const left = parseVer(a)
  const right = parseVer(b)
  if (left === null || right === null) return null
  return cmpVer(left, right)
}
