import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoOfSpec } from '@utils/pluginTarget'
import { profileDir } from '../../platform/dshHome'
import { BASE_PROFILE } from '../../platform/paths'
import { addToBundles, allowBuildFor, removeFromBundles, runPnpm, type PnpmOutcome } from './localPnpm'

/**
 * 插件安装 / 卸载 —— **启动器自己跑 pnpm**，不经过 `dsh plugin` 命令。
 *
 * ## 为什么不再用 dsh 的 plugin 命令
 *
 * `dsh plugin --profile <name> add …` 内部是 `runProfilePnpm`：装完会跑一遍
 * **插件兼容性检查**（`engines.dsh` 或 `@deepseek-ai/dsh*` 的 peer 范围），
 * 不匹配就整段回滚，日志里留下 `dsh: installation rejected: …`。
 *
 * 而大量插件只是**声明停在旧版本**、实际能跑（目录里常见的写法），用户明确要求
 * 不要被这道检查拦住，也**不允许改插件包里的文件**（母版必须只放原始文件）。
 * 所以这里直接调 pnpm，自己补上 dsh 真正必要的那几步。
 *
 * ## 必须自己补的两件事
 *
 * 1. **启用清单**：dsh 在 pnpm 成功后会把包 reconcile 进 `package.json` 的
 *    `dsh.profile.bundles`。少了这步插件"装了但不加载" —— 见 `addToBundles`。
 * 2. **git 包的构建脚本**：git 来源的插件靠 `prepare` 现场构建出 `dist`，而 pnpm
 *    默认不执行依赖的构建脚本。失败输出里会打印 `Ignored build scripts: …`，
 *    拿到包名写进 `pnpm-workspace.yaml` 的 `allowBuilds` 再重试一次。
 *
 * ## 仍然遵守的前提
 *
 * · profile 是 **pnpm 布局**（`pnpm-lock.yaml` / `pnpm-workspace.yaml`），只用 pnpm；
 * · 包名用**真 npm 包名**（目录的 `npm` 字段，可能带 scope），不是目录短名；
 * · 失败要回滚 `package.json` 与 `pnpm-lock.yaml`（见 `addWithRollback`）。
 */

export interface PluginProgress {
  phase: 'resolve' | 'install' | 'done'
  text: string
}

/**
 * 插件操作的 profile 名 —— **母版**（$DSH_HOME/profiles/base）。
 *
 * 插件只有一个写入点：装 / 升 / 卸 / 开关都落在这里，启动 web 与桌面端前再从母版
 * 克隆到各自的 profile（见 domain/control/pluginBase.ts）。
 *
 * 为什么必须用"profile 名"而不是直接给目录：dsh plugin --profile <name> 只接受名字，
 * 固定解析到 $DSH_HOME/profiles/<name>。用户把插件目录指到别处时，base 是个
 * junction，dsh 照旧按这个名字访问。
 */
const PROFILE = BASE_PROFILE

/** 读 profile 清单里的 dependencies */
function manifestDeps(): Record<string, string> {
  try {
    const raw = readFileSync(join(profileDir(PROFILE), 'package.json'), 'utf8')
    const manifest = JSON.parse(raw) as { dependencies?: Record<string, string> }
    return manifest.dependencies ?? {}
  } catch {
    return {}
  }
}

/**
 * 这条规格串在清单里对应哪个依赖名；没装过返回 null。
 *
 * 不能直接拿规格串当 key 查：只有 npm 来源的 key 才是包名本身。git / tarball 来源装完后
 * pnpm 写的 key 是**包自己的 name**（常常与目录里的短名无关），规格串则放在 value 里。
 * 这里两种形态都认，否则装成功了还会被判成"没装"。
 */
function findInstalledKey(spec: string, deps: Record<string, string>): string | null {
  if (Object.prototype.hasOwnProperty.call(deps, spec)) return spec
  for (const [name, value] of Object.entries(deps)) {
    if (value === spec) return name
  }
  // pnpm 可能把 github:owner/repo 规范化成 github:owner/repo#<sha> 之类 —— 按仓库归属兜底
  const repo = repoOfSpec(spec)
  if (repo === null) return null
  for (const [name, value] of Object.entries(deps)) {
    if (repoOfSpec(value) === repo) return name
  }
  return null
}

/**
 * 读 `node_modules` 里那个包**实际装到的版本**。读不到返回 null。
 *
 * 为什么需要它：清单里的声明（`package.json` 的 `dependencies`）不等于装上了什么。
 * pnpm 的"最小发布年龄"闸会静默保留旧版本并以退出码 0 结束 —— 清单可能写着新版本，
 * 磁盘上还是旧的。只查清单就会把这种情况当成更新成功。
 */
function installedVersion(packageName: string): string | null {
  try {
    const raw = readFileSync(
      join(profileDir(PROFILE), 'node_modules', packageName, 'package.json'),
      'utf8'
    )
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/**
 * 把 pnpm 的输出过滤成给用户看的进度行。
 *
 * 原先只放行 `/error|ERR_|added \d+|removed \d+|Packages:|Done in|WARN/`，
 * 而 pnpm 正常工作时打的是 `Progress: resolved 1, reused 0, downloaded 0`、
 * `Downloading …`、`Resolving …`、`+ dshmarket 1.61.0` —— **全部被丢掉**。
 * 所以"点了更新之后一行输出都没有"，用户以为没反应，其实在跑。
 *
 * 现在全部放行（只丢掉空行）。pnpm 用 append-only reporter，输出是逐行的，
 * 一次操作通常几十行，不会把界面刷爆。
 */
function progressLine(text: string, onProgress: (progress: PluginProgress) => void): void {
  const line = text.trim()
  if (line === '') return
  onProgress({ phase: 'install', text: line })
}

/** 谈 profile 的两个关键文件，供失败回滚 */
function backupManifest(dir: string): Array<{ path: string; text: string | null }> {
  return ['package.json', 'pnpm-lock.yaml'].map((name) => {
    const path = join(dir, name)
    try {
      return { path, text: readFileSync(path, 'utf8') }
    } catch {
      return { path, text: null }
    }
  })
}

/** 把备份写回（`null` 表示原本就没有这个文件，恢复成"不存在"） */
function restoreManifest(backup: Array<{ path: string; text: string | null }>): void {
  for (const item of backup) {
    try {
      if (item.text === null) unlinkSync(item.path)
      else writeFileSync(item.path, item.text, 'utf8')
    } catch {
      // 恢复失败也没别的办法了：调用方会把 pnpm 的原始输出报给用户
    }
  }
}

/**
 * 从 pnpm 输出里挖出"构建脚本被忽略"的包名。
 *
 * git 来源的插件靠 `prepare` 现场构建出 `dist`，而 pnpm 默认不执行依赖的构建脚本。
 * pnpm 会把被跳过的包打印成 `Ignored build scripts: a, b.` —— 拿到名字就能放开重试。
 */
function ignoredBuildNames(tail: string[]): string[] {
  const names = new Set<string>()
  for (const match of tail.join('\n').matchAll(/Ignored build scripts?:\s*(.+)/gi)) {
    for (const part of (match[1] ?? '').split(/[,、]/)) {
      const name = part.trim().replace(/[.。;；]+$/, '')
      if (name !== '') names.add(name)
    }
  }
  return [...names]
}

/**
 * 装一个包：失败就回滚两个清单文件；原因是"构建脚本被忽略"时先放开白名单再重试一次。
 *
 * 回滚的理由：pnpm 失败可能已经把 `package.json` 里的 dependencies 写进去了，
 * 留在那里会让下次启动的克隆带上一个装了一半的插件。
 */
async function addWithRollback(
  dir: string,
  spec: string,
  onLine: (line: string) => void
): Promise<PnpmOutcome> {
  const backup = backupManifest(dir)
  let outcome = await runPnpm(dir, ['add', spec], onLine)

  if (outcome.code !== 0) {
    const names = ignoredBuildNames(outcome.tail)
    if (names.length > 0) {
      onLine(`这些包的构建脚本被 pnpm 跳过了，加入白名单后重试：${names.join('、')}`)
      for (const name of names) allowBuildFor(dir, name)
      outcome = await runPnpm(dir, ['add', spec], onLine)
    }
  }

  if (outcome.code !== 0) restoreManifest(backup)
  return outcome
}

/**
 * 安装一个插件到 profile。
 *
 * @param spec - 安装目标规格串。**不是**"包名"了，三种形态都收：
 *   · npm 包名（`@scope/name`）→ pnpm 去 registry 装
 *   · 作者的 Release 产物 URL（`https://github.com/o/r/releases/download/…/x.tgz`）
 *   · `github:owner/repo`（monorepo 子包带 `#path:/sub`）
 *   由渲染层的 `@utils/pluginTarget` 的 `resolveInstallTarget` 算出来，与 dsh 自己的
 *   市场同一套三段式规则。
 */
export async function installPlugin(
  spec: string,
  onProgress: (progress: PluginProgress) => void = () => {}
): Promise<void> {
  const target = typeof spec === 'string' ? spec.trim() : ''
  if (target === '') throw new Error('缺少安装目标')
  // 以 `-` 开头会被 pnpm 当成选项（`--registry=…`），不是包名
  if (target.startsWith('-')) throw new Error(`安装目标不合法：${target}`)

  const dir = profileDir(PROFILE)
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(
      '插件母版还没有初始化：请先在插件页选择以「Web 端」还是「桌面端」现有的插件作为基线。'
    )
  }

  onProgress({ phase: 'resolve', text: `正在安装 ${target}…` })

  const before = manifestDeps()
  const already = findInstalledKey(target, before)
  if (already !== null) {
    onProgress({ phase: 'done', text: `${already} 已经装过了` })
    return
  }

  const outcome = await addWithRollback(dir, target, (line) => progressLine(line, onProgress))
  if (outcome.code !== 0) {
    throw new Error(`安装 ${target} 失败（退出码 ${outcome.code}）：\n${outcome.tail.slice(-10).join('\n')}`)
  }
  /*
   * 命令成功不等于装上了，要核对清单。
   *
   * 核对的**不是**"清单里有没有这个规格串当 key" —— 那只对 npm 来源成立。git / tarball
   * 来源装完后 key 是包自己的 name，过去因此把成功报成失败（"没出现在 profile 清单里"）。
   * 现在按三种形态认：key 相等 / value 相等 / 仓库归属相同。
   */
  const after = manifestDeps()
  const landed = findInstalledKey(target, after)
  if (landed === null) {
    throw new Error(
      `命令成功退出，但 ${target} 没出现在 profile 清单里\n${outcome.tail.slice(-10).join('\n')}`
    )
  }
  // dsh 原本在 pnpm 成功后 reconcile 启用清单；绕开它就得自己补，否则"装了但不加载"
  if (addToBundles(dir, landed)) {
    onProgress({ phase: 'done', text: `${landed} 已加入启用清单` })
  }
  onProgress({ phase: 'done', text: `${landed} 安装完成` })
}

/**
 * 卸载一个插件。
 *
 * 允许卸载**正在运行**的 dsh 所在 profile 里的插件：pnpm 改的是磁盘上的 profile，
 * 不影响已经在跑的进程，下次启动才生效。但**不给卸 `@deepseek-ai/*`** ——
 * 那是 dsh 官方组件（与 patch 层的保护规则一致）。
 */
export async function uninstallPlugin(
  packageName: string,
  onProgress: (progress: PluginProgress) => void = () => {}
): Promise<void> {
  if (packageName.startsWith('@deepseek-ai/')) {
    throw new Error(`${packageName} 是 dsh 官方组件，不允许从启动器卸载`)
  }
  const dir = profileDir(PROFILE)
  onProgress({ phase: 'resolve', text: `正在卸载 ${packageName}…` })

  if (!Object.prototype.hasOwnProperty.call(manifestDeps(), packageName)) {
    throw new Error(`${packageName} 不在 profile 的依赖里，无法卸载`)
  }

  /*
   * `pnpm remove` 会**校验整个 lockfile** 的供应链策略 —— 只要 lockfile 里有
   * 一条"发布太新"的记录（哪怕不涉及本次卸载），整条命令就会被拒绝
   * （`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。`runPnpm` 统一带了
   * `--config.minimumReleaseAge=0`，所以这里不必再传。
   *
   * 卸载**不引入任何新包**，绕过发布年龄策略没有供应链风险。
   */
  const outcome = await runPnpm(dir, ['remove', packageName], (line) => progressLine(line, onProgress))
  if (outcome.code !== 0) {
    throw new Error(`卸载 ${packageName} 失败（退出码 ${outcome.code}）：\n${outcome.tail.slice(-10).join('\n')}`)
  }
  if (Object.prototype.hasOwnProperty.call(manifestDeps(), packageName)) {
    throw new Error(
      `命令成功退出，但 ${packageName} 仍在 profile 清单里\n${outcome.tail.slice(-10).join('\n')}`
    )
  }
  // dsh 原本会自己 reconcile 启用清单；绕开它就得自己把它摘掉，否则残留一条指向已卸包的记录
  if (removeFromBundles(dir, packageName)) {
    onProgress({ phase: 'done', text: `${packageName} 已从启用清单移除` })
  }
  onProgress({ phase: 'done', text: `${packageName} 已卸载` })
}

/**
 * 把一个已装插件更新到指定版本。
 *
 * 走的是同一个透传通道：`dsh plugin --profile web add <包>@<版本>`（→ pnpm）。
 * 用 `add <包>@<版本>` 而不是 pnpm 的 `update`：`update` 受 package.json 里的范围约束
 * （`^0.19.1` 不会跨到 `0.20.0`），会出现"界面说有新版、点了却没动"。显式指定版本，
 * 按钮承诺什么就装什么。pnpm 默认 save-prefix 是 `^`，所以清单里会写成 `^<版本>`。
 *
 * @param target - 目标版本号（**不带** `^`/`~` 前缀）。界面通常传市场目录里的 version。
 */
export async function updatePlugin(
  packageName: string,
  target: string,
  onProgress: (progress: PluginProgress) => void = () => {}
): Promise<void> {
  if (packageName.startsWith('@deepseek-ai/')) {
    throw new Error(`${packageName} 是 dsh 官方组件，不通过启动器更新`)
  }
  const spec = manifestDeps()[packageName]
  if (spec === undefined) {
    throw new Error(`${packageName} 不在 profile 的依赖里，无法更新`)
  }
  // git / file / link 之类来源没有"更新到某版本"的语义 —— 硬装会把用户的固定指认改掉
  if (!/^[\^~]?\d/.test(spec.trim())) {
    throw new Error(`${packageName} 在清单里的来源是「${spec}」，不是版本号，没有可更新的版本`)
  }
  if (!/^\d/.test(target.trim())) {
    throw new Error(`目标版本不合法：${target}`)
  }

  const dir = profileDir(PROFILE)
  onProgress({ phase: 'resolve', text: `把 ${packageName} 更新到 ${target}…` })

  /*
   * 用 `add <包>@<版本>` 而不是 pnpm 的 `update`：`update` 受 package.json 里的范围约束
   * （`^0.19.1` 不会跨到 `0.20.0`），会出现"界面说有新版、点了却没动"。显式指定版本，
   * 按钮承诺什么就装什么。
   *
   * 发布年龄那道闸已由 `runPnpm` 统一关掉（`--config.minimumReleaseAge=0`）——
   * 它遇到刚发布的版本会**静默保留旧版本、退出码 0**，不关掉就会出现"点了更新、版本没变"。
   */
  const addSpec = `${packageName}@${target}`
  const outcome = await addWithRollback(dir, addSpec, (line) => progressLine(line, onProgress))

  if (outcome.code !== 0) {
    throw new Error(
      `更新 ${packageName} 失败（退出码 ${outcome.code}）：\n${outcome.tail.slice(-10).join('\n')}`
    )
  }
  const after = manifestDeps()[packageName]
  if (after === undefined) {
    throw new Error(`命令成功退出，但 ${packageName} 从 profile 清单里消失了`)
  }
  /*
   * **核对真正装上的版本**，不能只看清单 —— 否则会把"什么都没发生"当成更新成功
   * （用户看到"已更新到 1.61.0"，实际磁盘上还是 1.47.0）。
   */
  const installed = installedVersion(packageName)
  if (installed !== target) {
    throw new Error(
      `命令成功退出，但 ${packageName} 实际装的仍是 ${installed ?? '(读不到版本)'}，不是 ${target}。\n` +
        `${outcome.tail.slice(-10).join('\n')}`
    )
  }
  onProgress({ phase: 'done', text: `${packageName} 已更新到 ${target}` })
}
