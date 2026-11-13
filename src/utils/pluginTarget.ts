/**
 * 目录条目 → pnpm 安装目标。**纯字符串逻辑，不做 IO。**
 *
 * 为什么需要它：插件市场目录（`dsh-plugin-catalog`）里 10778 条记录中只有 5539 条带
 * `npm` 字段，其余 5239 条**只发在 GitHub 上**。它们的 `npm` 为空，直接用短名去
 * `dsh plugin add` 会被 pnpm 当成"去 npm 装同名的另一个包" —— 轻则 404，重则装错包。
 *
 * 规则照抄 dsh 自己的市场实现（`dshmarket/lib/sources.js` 的 `installTargetFor`），
 * 三段式，顺序不能换：
 *
 *   ① `npm` 是合法的 npm 包名 → 用它（下载量最小、有版本号、能判更新）
 *   ② `tarball` 是**同一个仓库**的 GitHub Release 产物 → 用它（不下整仓、不跑构建脚本）
 *   ③ 兜底 `github:owner/repo`，monorepo 子包带 `#path:/sub/dir`
 *
 * ②的"同一个仓库"约束是整个安全边界：只认 `url` 里那个 owner/repo 自己的 Release，
 * 否则一条记录可以写着可信仓库、却指向别处的压缩包去安装。
 *
 * 放在 `utils/` 的依据（本项目约定）：**不用 Node、不用 DOM、不用 Electron**。
 * 主进程（安装前校验）与渲染层（按钮判断、命令预览）共用同一份实现，不会两处飘。
 */

/** GitHub 仓库 `owner/name` 的字符集 */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * 合法的 npm 包名（也用于判断 `tarball` 之外的"能不能当 registry 目标"）。
 *
 * 比 npm 自己的规则略严格：允许 `@scope/name`，其余只收小写字母、数字与 `-._~`。
 * 与 dsh 市场保持逐字一致 —— 两边对"什么算包名"不能有分歧。
 */
export const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** 目录条目里与安装目标有关的字段（其余字段不参与判定） */
export interface CatalogEntryLike {
  /** 真 npm 包名，可能带 scope；可能为空串或 null */
  npm?: string | null
  /** 仓库地址，形如 `https://github.com/owner/repo`，可带 `/tree/<branch>/<sub>` */
  url?: string | null
  /** 作者提供的预编译产物（GitHub Release asset） */
  tarball?: string | null
}

export type InstallTargetKind = 'npm' | 'tarball' | 'github'

export interface InstallTarget {
  /** 直接传给 `dsh plugin add` 的规格串 */
  target: string
  kind: InstallTargetKind
  /** `owner/repo`（已小写）；npm 来源时为 null */
  repo: string | null
  /** monorepo 子包路径（`#path:/` 那一段）；没有则 null */
  subpath: string | null
}

/** 子路径必须是一串安全的相对段：不许空段、`.`、`..`（否则 `#path:` 会跳出仓库） */
function validSubpath(subpath: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/.test(subpath)) return false
  return !subpath.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
}

/**
 * 解析仓库地址。
 *
 * 目录里的 monorepo 插件用 `/tree/<branch>/<subpath>` 指向子包（实测 422 条），
 * 子路径要变成 pnpm 的 `#path:/<subpath>` 选择器，否则会去装整个仓库的根包。
 */
export function parseSourceUrl(url: string): { repo: string; subpath: string | null } | null {
  if (typeof url !== 'string') return null
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(url.trim())
  if (m === null || !REPO_RE.test(m[1] ?? '')) return null
  const subpath = m[2] ?? null
  if (subpath !== null && !validSubpath(subpath)) return null
  return { repo: m[1] as string, subpath }
}

/**
 * 这个 `tarball` 能不能当安装目标 —— 只有**属于 `repo` 自己**的 GitHub Release 产物才认。
 *
 * 刻意不接受 `objects.githubusercontent.com` / `release-assets.githubusercontent.com`：
 * 那些地址的路径里没有 owner/repo，绑不定归属，就没法判断是不是同一条记录的产物。
 */
function releaseTarballTarget(value: string | null | undefined, repo: string): string | null {
  if (typeof value !== 'string') return null
  const target = value.trim()
  if (target === '') return null
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null
  if (!parsed.pathname.endsWith('.tgz') && !parsed.pathname.endsWith('.tar.gz')) return null
  // /{owner}/{repo}/releases/... —— 前两段必须是这条记录自己的仓库
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  if (segments.length < 4 || segments[2] !== 'releases') return null
  const owner = segments[0] as string
  const name = segments[1] as string
  return `${owner}/${name}`.toLowerCase() === repo.toLowerCase() ? target : null
}

/**
 * 算出这条目录记录的安装目标。
 *
 * @returns 无法安装时返回 null（`url` 不是 GitHub 仓库，且没有合法 npm 名）
 */
export function resolveInstallTarget(entry: CatalogEntryLike): InstallTarget | null {
  const npm = typeof entry.npm === 'string' ? entry.npm.trim() : ''
  const source = typeof entry.url === 'string' ? parseSourceUrl(entry.url) : null

  // ① npm 名优先。**必须是合法包名**，否则 `dsh plugin add "Some Display Name"`
  //    会被 pnpm 当成别的东西 —— 目录里确实有 npm 字段写着非包名的记录。
  if (npm !== '' && NPM_NAME_RE.test(npm)) {
    return { target: npm, kind: 'npm', repo: source === null ? null : source.repo.toLowerCase(), subpath: null }
  }

  // 没有 GitHub 仓库地址就没法兜底了
  if (source === null) return null
  const repo = source.repo.toLowerCase()

  // ② 同仓库的预编译产物
  const tarball = releaseTarballTarget(entry.tarball, source.repo)
  if (tarball !== null) {
    return { target: tarball, kind: 'tarball', repo, subpath: source.subpath }
  }

  // ③ 仓库源码（monorepo 子包带 #path:）
  const target =
    source.subpath === null ? `github:${source.repo}` : `github:${source.repo}#path:/${source.subpath}`
  return { target, kind: 'github', repo, subpath: source.subpath }
}

/**
 * 从一份**已装依赖的规格串**里反推 GitHub 仓库（小写 `owner/repo`），没有则 null。
 *
 * 用途：判断"目录里这条 git 记录是不是已经装了"。装完之后 pnpm 在 `package.json` 里
 * 写的可能是 `github:owner/repo`、`github:owner/repo#<sha>`、`git+https://…/*.git`、
 * 带代理前缀的 `https://gh-proxy.com/https://github.com/…`、或 codeload 的
 * `…/tar.gz/<sha>` —— 这些形态都要能认出来，否则装完了界面还说"未装"。
 */
export function repoOfSpec(spec: string): string | null {
  const raw = typeof spec === 'string' ? spec.trim() : ''
  if (raw === '') return null

  // github:owner/repo[.git][#...]
  const shortcut = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/i.exec(raw)
  if (shortcut !== null) return (shortcut[1] as string).toLowerCase()

  // codeload 的提交固定地址
  const codeload = /codeload\.github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/tar\.gz\//i.exec(raw)
  if (codeload !== null) return (codeload[1] as string).toLowerCase()

  // 其余任意含 github.com/owner/repo 的形态（含 git+、.git、代理前缀）
  const anywhere = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=$|[/?#])/i.exec(raw)
  if (anywhere !== null) {
    const repo = `${anywhere[1]}/${anywhere[2]}`
    return REPO_RE.test(repo) ? repo.toLowerCase() : null
  }

  return null
}

/** 从规格串里取 `#path:/<subpath>` 那段（小写），没有则 null */
export function subpathOfSpec(spec: string): string | null {
  const m = /#path:\/?([^#&\s]+)/i.exec(typeof spec === 'string' ? spec : '')
  return m === null ? null : (m[1] as string).toLowerCase().replace(/\/+$/, '')
}

/**
 * 「这份已装规格串，是不是就是这个安装目标装的」。
 *
 * 只用于**非 npm** 目标：npm 目标靠 `package.json` 的 key 判断（包名唯一），
 * 而 git / tarball 目标装完后 key 会变成包自己的 name，只能靠仓库归属来认。
 */
export function specMatchesTarget(spec: string, target: InstallTarget): boolean {
  if (target.kind === 'npm') {
    // npm 目标：规格串本身就是包名（少数情况下清单里写成 `npm:name@ver`）
    const raw = typeof spec === 'string' ? spec.trim() : ''
    return raw === target.target || raw.startsWith(`${target.target}@`)
  }
  const repo = repoOfSpec(spec)
  if (repo === null || target.repo === null || repo !== target.repo) return false
  if (target.subpath === null) return true
  return subpathOfSpec(spec) === target.subpath.toLowerCase()
}

/**
 * 拼出给用户看/复制的完整安装命令。
 *
 * 与界面上按钮真正执行的是**同一件事** —— 两者都从 `resolveInstallTarget` 出，
 * 不会出现"标题写着 A、实际装 B"。
 */
export function installCommandFor(target: InstallTarget, profile = 'web'): string {
  return `dsh plugin --profile ${profile} add ${target.target}`
}
