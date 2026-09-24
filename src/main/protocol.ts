import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { protocol } from 'electron'
import { fetchImage } from './imageProxy'

export const APP_SCHEME = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://bundle`
/**
 * 图片代理的**保留路径前缀**，页面里写成同源的 `/__img/?u=<编码后的 https URL>`。
 *
 * ⚠️ 这里是路径，**不是第二个 host**。曾经用 `app://img/…`，结果一律 `Failed to fetch`（0ms）——
 * 实测 `app://otherhost/index.html` 同样不通，说明 Chromium 压根不把非 `bundle` host 的请求
 * 派发给自定义协议的处理器（自定义 scheme 未开 `corsEnabled` 时跨 host 直接被拒）。
 * 同源路径没有这个问题，也完全不涉及 CORS。
 */
export const IMAGE_PATH_PREFIX = '/__img'

/** 产物里渲染层的根目录。dev 与打包后相对位置一致：<app>/out/main → <app>/out/renderer */
function rendererRoot(): string {
  return resolve(__dirname, '../renderer')
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

/**
 * 用自定义协议承载渲染层，而不是 file://。
 *
 * 原因是产物里的资源引用可能是**绝对路径**（例如 CSS 里的 `url("/x.png")`）。
 * 这类字符串位于 public/ 目录、不经过 Vite 处理，会原样进产物；
 * 如果页面走 file:// 加载，`/x.png` 会被解析成磁盘根目录而 404。
 * 换成 `app://bundle/` 之后，`/x` 就等于产物根下的 x，绝对路径照常可用。
 *
 * 必须在 app ready **之前**调用。
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // 允许该 scheme 参与 CORS —— 现在只同源取图，用不到；但少这一项会让将来任何
        // 跨 host 的 app:// 请求在 0ms 内失败，且报的是没有信息量的 "Failed to fetch"
        corsEnabled: true
      }
    }
  ])
}

/** 注册 app:// 的处理器。必须在 app ready **之后**调用。 */
export function serveAppScheme(): void {
  const root = rendererRoot()

  protocol.handle(APP_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad request', { status: 400 })
    }

    // 远端图片走主进程代理（渲染层发不出远程请求，原因见 imageProxy.ts）。
    // 判据是**同源路径前缀**，不是 host —— 见 IMAGE_PATH_PREFIX 的说明。
    if (url.pathname === IMAGE_PATH_PREFIX || url.pathname.startsWith(`${IMAGE_PATH_PREFIX}/`)) {
      const target = url.searchParams.get('u')
      if (!target) return new Response('missing u', { status: 400 })
      return fetchImage(target)
    }

    let relative: string
    try {
      const pathname = decodeURIComponent(url.pathname)
      relative = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '')
    } catch {
      return new Response('bad request', { status: 400 })
    }

    const target = resolve(join(root, relative))
    // 目录穿越防护：解析后的路径必须落在渲染层根目录内
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response('forbidden', { status: 403 })
    }

    try {
      const body = await readFile(target)
      return new Response(body, {
        status: 200,
        headers: { 'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
