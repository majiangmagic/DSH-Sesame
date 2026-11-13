/**
 * 远端版本信息。从 npm registry 读 `@deepseek-ai/dsh` 的 packument。
 *
 * 两个踩过坑的地方：
 *  1. 预发布段比较必须逐段按 semver 规则来（`alpha.10` 比 `alpha.2` 大），整段当字符串比会错；
 *  2. "最新版"**不能信 dist-tags.latest** —— dsh 的新版本常常只挂在 alpha / next 上。
 *     实测：latest=0.1.5-rc.3，而 alpha=0.1.7-alpha.2，直接信 latest 会把降级当升级推给用户。
 *
 * 解析与比较的实现在 `@utils/version` —— 渲染层也要用同一份（它原先自己写了个
 * "只比数字段"的简化版，会把预发布版判成更新）。
 */
import { cmpVer, parseVer, type ParsedVersion } from '@utils/version'

const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'
const PKG = '@deepseek-ai/dsh'

export function registryUrl(): string {
  return (process.env.npm_config_registry || DEFAULT_REGISTRY).replace(/\/$/, '')
}

export type { ParsedVersion }

export interface RemoteInfo {
  /** 按 semver 从高到低排好的全部版本 */
  versions: string[]
  tags: Record<string, string>
  /** 跨 tag 取 semver 最高的那个，不是 dist-tags.latest */
  latest: string
  /** dist-tags.latest 原值，界面上可能想显示"官方标为 latest" */
  tagLatest: string
  source: string
}

/**
 * "最新版"的算法：把 `latest` / `next` / `alpha` 三个 tag 的值**加上全部版本**一起比，
 * 取 semver 最高的一个。
 *
 * 加上"全部版本"是因为：只比 tag 会漏掉"比 latest 新、但没打 tag"的版本；
 * 而 dsh 的发布习惯正是把新版本挂在 alpha / next 上。
 */
export function latestRemoteFor(tags: Record<string, string>, versions: readonly string[]): string {
  const candidates: string[] = []
  for (const name of ['latest', 'next', 'alpha']) {
    const value = typeof tags[name] === 'string' ? tags[name].trim() : ''
    if (value) candidates.push(value)
  }
  for (const item of versions) if (item) candidates.push(item)

  let best = ''
  let bestParsed: ParsedVersion | null = null
  for (const item of candidates) {
    const parsed = parseVer(item)
    if (!parsed) continue
    if (!bestParsed || cmpVer(parsed, bestParsed) > 0) {
      best = parsed.raw
      bestParsed = parsed
    }
  }
  return best
}

/** 更高才算更新；相等或更低都不打扰（避免把降级当升级）。 */
export function isNewer(latest: string, current: string): boolean {
  const next = parseVer(latest)
  const cur = parseVer(current)
  return Boolean(next && cur && cmpVer(next, cur) > 0)
}

interface Packument {
  name?: string
  'dist-tags'?: Record<string, string>
  versions?: Record<string, unknown>
}

/** 拉取远端版本表。失败重试 4 次（与原版一致），最终失败就抛，由调用方决定怎么呈现。 */
export async function fetchRemote(): Promise<RemoteInfo> {
  const url = `${registryUrl()}/${PKG.replace('/', '%2f')}`
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/vnd.npm.install-v1+json, application/json',
          'user-agent': 'dsh-sesame/0.1.0'
        }
      })
      if (!res.ok) throw new Error(`registry ${res.status}`)
      const body = (await res.json()) as Packument
      const tags = body['dist-tags'] ?? {}
      const all = Object.keys(body.versions ?? {})
      const sorted = all
        .map((item) => parseVer(item))
        .filter((item): item is ParsedVersion => item !== null)
        .sort((a, b) => cmpVer(b, a))
        .map((item) => item.raw)

      return {
        versions: sorted,
        tags,
        latest: latestRemoteFor(tags, sorted),
        tagLatest: typeof tags.latest === 'string' ? tags.latest : '',
        source: url
      }
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
