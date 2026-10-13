/**
 * `latest.yml` 的解析 —— **纯函数，不依赖 Electron**。
 *
 * electron-builder 每次打包都会生成这个文件（见 `scripts/publish-release.mjs`），
 * 发版时和安装包一起传到 GitHub Releases。启动器靠它知道"最新版是哪个、装哪个文件、
 * sha512 是多少"。
 *
 * 为什么单独一个文件、且不 import 任何东西：
 *
 *   1. **它是整条更新链上最容易悄悄坏掉的一环。** electron-builder 改了输出格式、
 *      或者我们正则写错，表现都是"检查更新永远失败"或"下载了错的包"——
 *      而这两件事在类型层面完全看不出来（解析结果全是 string）。
 *   2. **不依赖 Electron 才能拿真文件验证。** `scripts/check-update.mjs` 直接
 *      import 这个文件，抓 GitHub 上**真实的** `latest.yml` 跑一遍 ——
 *      这是"我无法运行打包后的应用"时唯一能做的端到端验证。
 *
 * 所以这里的规矩和 `pluginMirror.ts` 一样：**纯计算，不做 IO，不 import 任何东西**。
 */

/** `latest.yml` 里我们需要的四个字段 */
export interface ReleaseMeta {
  version: string
  /** 安装包文件名（相对资产名，不是完整 URL） */
  file: string
  /** 安装包的 sha512（base64）；文件里没有就是空串 */
  sha512: string
  /** 安装包字节数；读不到为 0（那时以下载响应的 Content-Length 为准） */
  size: number
}

/**
 * 解析 electron-builder 的 `latest.yml`。
 *
 * **手写正则而不是引 YAML 库**：这个文件是 electron-builder 自己生成的固定形状，
 * 我们只取四个键；为它加一条依赖不划算。真实形状长这样：
 *
 *     version: 0.1.6
 *     files:
 *       - url: DSH-Sesame-Setup-0.1.6.exe
 *         sha512: 1IRxyX+Ssfl...
 *         size: 143733628
 *     path: DSH-Sesame-Setup-0.1.6.exe
 *     sha512: 1IRxyX+Ssfl...
 *     releaseDate: '2026-10-02T19:10:13.063Z'
 *
 * 关键点：**顶层键在第 0 列，嵌套的在缩进里**。所以 `^sha512:` 只会命中顶层那一个
 * （与 `path` 同级、代表"要装的那个包"），不会误取 `files[]` 里的。
 * `size` 反过来只有嵌套的那一份，所以它专门匹配缩进形式。
 *
 * 形状不符（缺 version / path）返回 null，调用方当作"这次查不到"，不抛。
 */
export function parseLatestYml(text: string): ReleaseMeta | null {
  /** 取第 0 列的顶层键，去掉可能的引号 */
  const top = (key: string): string | null => {
    const match = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(text)
    if (!match) return null
    return (match[1] as string).replace(/^['"]|['"]$/g, '')
  }

  const version = top('version')
  const file = top('path')
  if (version === null || file === null || version === '' || file === '') return null

  // size 只在嵌套的那一份里（`files[]` 下面），所以匹配缩进形式
  const nestedSize = /^[ \t]+size:[ \t]*(\d+)[ \t]*$/m.exec(text)

  return {
    version,
    file,
    sha512: top('sha512') ?? '',
    size: nestedSize ? Number(nestedSize[1]) : 0
  }
}

/**
 * 从 GitHub Releases 的资产地址拼出安装包 URL。
 *
 * `latest` 是个特殊标签，永远指向最新一次 Release —— 所以我们不需要先列 Release 列表，
 * 一次请求就能拿到 `latest.yml`。
 */
export function releaseAssetUrl(repo: string, file: string): string {
  return `https://github.com/${repo}/releases/latest/download/${encodeURIComponent(file)}`
}

/** 该仓库的 Release 页面（给"查看更新内容"用） */
export function releasePageUrl(repo: string): string {
  return `https://github.com/${repo}/releases/latest`
}

/**
 * 从 `package.json` 的 `repository` 字段里认出 `owner/name`。
 *
 * 支持这几种写法（都是 npm 上真实存在的形状）：
 *   `https://github.com/owner/name.git`
 *   `git+https://github.com/owner/name.git`
 *   `github:owner/name`
 *   `owner/name`
 *
 * 认不出返回 null，调用方退回常量。
 */
export function repoSlugFrom(repository: unknown): string | null {
  const url =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null
        ? String((repository as { url?: unknown }).url ?? '')
        : ''
  if (url === '') return null
  const match = /github\.com[/:]([^/]+)\/([^/.#]+)/.exec(url)
  if (match) return `${match[1]}/${match[2]}`
  // `github:owner/name` 与裸 `owner/name`
  const short = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url.trim())
  return short ? `${short[1]}/${short[2]}` : null
}
