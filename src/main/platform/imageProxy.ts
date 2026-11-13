import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { app } from 'electron'
import { loadMarket } from '../domain/plugins/market'

/**
 * 图片代理 —— 渲染层要显示远端图片时，一律通过 `app://img/?u=<编码后的 URL>` 走这里。
 *
 * **为什么不直接在渲染层 `<img src="https://…">`**：
 * 实测本应用的渲染层**发不出任何远程请求**（`fetch` 与 `<img>` 都在 0–1ms 内失败，
 * 而主进程访问同样的地址完全正常）。所以远端图片只能由主进程取回来再交给页面。
 *
 * 这样反而更好：
 *  - 不受 CORS / CSP 影响；
 *  - 能**落盘缓存** —— 一页 120 行、每张截图几百 KB，不缓存每次翻页都要重下；
 *  - 主进程可以统一做超时、体积上限与内网地址拦截。
 *
 * 安全边界（这是个"按 URL 取字节"的接口，必须有边界）：
 *  - 只允许 **https**；
 *  - 拒绝环回 / 私有 / 链路本地地址（`127.*`、`10.*`、`192.168.*`、`169.254.*`、`localhost`、`::1` …），
 *    避免把本机服务当成图片源；
 *  - 单张上限 8 MB，超时 15s；
 *  - 缓存目录总量超过上限时按最旧清理。
 */

const TIMEOUT_MS = 15_000
const MAX_BYTES = 8 * 1024 * 1024
/** 缓存目录上限；超出后删最旧的，避免无限增长 */
const CACHE_MAX_BYTES = 256 * 1024 * 1024

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/x-icon': '.ico'
}

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'image-cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 私有 / 环回 / 链路本地地址——不允许作为图片源 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0.0.0.0') return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^(fc|fd|fe80)/i.test(host)) return true
  return false
}

function cacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

/** 缓存目录超限时按最旧清理（尽力而为，失败不影响返回图片） */
function pruneCache(dir: string): void {
  try {
    const files = readdirSync(dir)
      .map((name) => {
        const path = join(dir, name)
        try {
          const info = statSync(path)
          return { path, size: info.size, at: info.mtimeMs }
        } catch {
          return null
        }
      })
      .filter((item): item is { path: string; size: number; at: number } => item !== null)

    let total = files.reduce((sum, file) => sum + file.size, 0)
    if (total <= CACHE_MAX_BYTES) return
    files.sort((a, b) => a.at - b.at)
    for (const file of files) {
      if (total <= CACHE_MAX_BYTES) break
      try {
        unlinkSync(file.path)
        total -= file.size
      } catch {
        // 忽略：清不掉就留着
      }
    }
  } catch {
    // 忽略
  }
}

function findByKey(dir: string, key: string): { body: Buffer; type: string } | null {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(key)) continue
      const path = join(dir, name)
      const body = readFileSync(path)
      const ext = extname(name).toLowerCase()
      const type = Object.entries(MIME_EXT).find(([, value]) => value === ext)?.[0] ?? 'application/octet-stream'
      return { body, type }
    }
  } catch {
    // 忽略，走网络
  }
  return null
}

/**
 * 把目标 URL 展开成**有序候选列表**。
 *
 * 目录里的截图全部指向 `raw.githubusercontent.com`，而**实测国内直连不通**
 * （10s 后 fetch failed）。市场自己为此配了区域路由，`githubRoutesFor('raw', 'china')`
 * 返回 `["https://gh-proxy.com", "https://ghfast.top", null]` —— 按代理优先、直连兜底的顺序。
 * 实测其中 `gh-proxy.com` 可用（HTTP 200 / image/png）。
 *
 * 所以这里**借用市场自己的区域配置**去改写 URL，而不是自己硬编码代理域名：
 * 市场换代理时这里跟着变，且与它在 dsh 内的行为一致。
 */
function candidatesFor(target: string): string[] {
  const direct = [target]
  if (!/^https:\/\/raw\.githubusercontent\.com\//i.test(target)) return direct
  try {
    const handle = loadMarket()
    const routes = handle.modules.regions?.githubRoutesFor
    if (typeof routes !== 'function') return direct
    let region = 'china'
    try {
      const active = handle.modules.regions?.activeRegion?.()
      if (typeof active === 'string' && active !== '') region = active
    } catch {
      // 取不到就用 china —— 本应用界面是中文，用户大概率在国内
    }
    const list = routes('raw', region) as Array<string | null>
    const via = list
      .filter((item): item is string => typeof item === 'string' && item !== '')
      .map((proxy) => `${proxy.replace(/\/$/, '')}/${target}`)
    // 代理优先、直连兜底；去重避免同一地址试两次
    return [...new Set([...via, ...direct])]
  } catch {
    return direct
  }
}

/**
 * 取回一张远端图片。
 *
 * 会**依次尝试候选地址**（区域代理 → 直连）直到有一张真的是图片 ——
 * 实测这些代理本身也不稳定（同一地址一会儿通一会儿不通），所以不能只试第一个。
 *
 * @param target - 已经过校验的 https URL
 * @returns 可直接交给 `protocol.handle` 的 Response
 */
export async function fetchImage(target: string): Promise<Response> {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return new Response('bad url', { status: 400 })
  }
  if (parsed.protocol !== 'https:') return new Response('only https', { status: 400 })
  if (isPrivateHost(parsed.hostname)) return new Response('refused', { status: 403 })

  const dir = cacheDir()
  const key = cacheKey(target)
  const cached = findByKey(dir, key)
  if (cached) {
    return new Response(new Uint8Array(cached.body), { status: 200, headers: { 'content-type': cached.type } })
  }

  const failures: string[] = []
  for (const candidate of candidatesFor(target)) {
    try {
      const res = await fetch(candidate, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'dsh-sesame/0.1.0' }
      })
      if (!res.ok) {
        failures.push(`${candidate.slice(0, 60)} → HTTP ${res.status}`)
        continue
      }
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
      if (!type.startsWith('image/')) {
        failures.push(`${candidate.slice(0, 60)} → 非图片 (${type || '无 content-type'})`)
        continue
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.byteLength > MAX_BYTES) {
        failures.push(`${candidate.slice(0, 60)} → 超过 ${MAX_BYTES / 1024 / 1024}MB`)
        continue
      }
      try {
        writeFileSync(join(dir, key + (MIME_EXT[type] ?? '.bin')), bytes)
        pruneCache(dir)
      } catch {
        // 缓存写不进去不影响这次返回
      }
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } })
    } catch (error) {
      failures.push(`${candidate.slice(0, 60)} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return new Response(`all candidates failed:\n${failures.join('\n')}`, { status: 502 })
}
