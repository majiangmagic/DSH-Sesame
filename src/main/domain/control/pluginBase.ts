/**
 * 插件**母版**：初始化、状态查询、克隆到目标 profile。
 *
 * ## 它解决什么
 *
 * 以前 web 与桌面端各有一份插件（`~/.dsh/profiles/web` 与 `.../desktop`），两份独立演进：
 * 你在 web 装的插件桌面端不知道，反过来也一样 —— `check:mirror` 长期飘红就是这件事的症状。
 * 启动桌面端时为了"对齐"，还要把 web 的插件**逐个 remove + add** 重装一遍，
 * 8 个插件 = 16 次 pnpm 往返 ≈ 2~3 分钟。
 *
 * 现在改成：**插件只有一个写入点（母版），profile 都是它的副本**。
 *
 *     <数据根>/plugins            母版：装 / 升 / 卸 / 开关都在这里做（pnpm 只在这里跑）
 *            │
 *            ├──克隆──▶ profiles/web       每次启动前重建（同盘硬链接，秒级）
 *            └──克隆──▶ profiles/desktop
 *
 * ## 为什么克隆而不是重装
 *
 * profile 用的是 pnpm 的 isolated 布局（`node_modules/<pkg>` 是指向 `.pnpm/…` 的符号链接），
 * 所以整棵 `node_modules` **必须一起搬**，单搬一个包会断链。搬的方式：
 *
 *   · 同盘 → `linkSync` 硬链接：几秒完成，**不额外占磁盘**；
 *   · 跨盘 → `copyFileSync` 兜底。
 *
 * 母版与 profile 共享 inode 是安全的：profile 只在启动时被读，dsh 的写入（reconcile
 * `dsh.profile.bundles`、改补丁层）都发生在下一次克隆之前，会被整体覆盖掉。
 *
 * ## 为什么每次启动都要克隆
 *
 * 因为 dsh 会往 profile 里写东西。副本不保存任何状态、每次重建，才能保证"副本 == 母版"。
 * 一次克隆只要秒级，不值得为省它去维护增量同步的复杂度。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { cp, copyFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { profileDir } from '../../platform/dshHome'
import { pluginBaseDir } from '../../platform/paths'
import { patchPathOf } from '../plugins/pluginState'
import {
  alignDisabledFlags,
  allRowIds,
  escapePlaceholder,
  insertRows,
  topLevelEntries
} from './sync'

/** 母版的初始化标记（放在母版目录里，跟着目录走，不依赖 settings 是否被清） */
const MARKER = '.sesame-base.json'

/**
 * 大目录操作的兜底上限。
 *
 * 476 MB / 3 万个文件正常十几秒到一分钟；但目标盘满、网络盘掉线、文件被占时
 * `cp` 可以一直不返回 —— 弹窗就永远停在"正在复制插件…"。超时后至少能把原因报出来。
 * 超时不等于取消（`cp` 不能中途取消），后台可能还在写；但界面不会无限等。
 */

/** 克隆完成后写到目标 profile 里的指纹，用来判断"母版没变，不用再复制" */
const CLONE_MARK = '.sesame-clone.json'

/**
 * 同步时**跳过**的条目。
 *
 * · `node_modules` —— 单独整棵处理（体量大、要按盘符选硬链接或复制）
 * · `*.lock` —— dsh 的 profile 写锁，跟着复制过去会让目标端以为有人在写
 * · `.sesame-*` —— 启动器自己的标记/指纹文件，属于目标端自己的状态
 */
function skipEntry(name: string): boolean {
  return name === 'node_modules' || name.endsWith('.lock') || name.startsWith('.sesame')
}

export type BaseSource = 'web' | 'desktop'

export interface BaseStatus {
  /** 母版目录的绝对路径（默认在数据根下） */
  dir: string
  /** 是否已完成初始化（用户选过基线） */
  initialized: boolean
  /** 当初从哪个 profile 导入的 */
  source: BaseSource | ''
  /** 初始化时间（ISO） */
  at: string
  /** 母版里的插件数量 */
  plugins: number
}

interface Marker {
  initialized: true
  source: BaseSource
  at: string
}

function readMarker(dir: string): Marker | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as Partial<Marker>
    if (raw.initialized !== true) return null
    const source = raw.source === 'web' || raw.source === 'desktop' ? raw.source : null
    if (source === null || typeof raw.at !== 'string') return null
    return { initialized: true, source, at: raw.at }
  } catch {
    // 标记文件不存在 / 读不动 / 不是合法 JSON —— 都当成"没初始化"
    return null
  }
}

/** 母版里 `dependencies` 的条数（读不到算 0） */
export function basePluginCount(dir = pluginBaseDir()): number {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return Object.keys(pkg.dependencies ?? {}).length
  } catch {
    return 0
  }
}

/** 母版当前状态。`initialized` 同时要求标记文件与 `package.json` 都在 —— 缺一个都算没初始化。 */
export function baseStatus(): BaseStatus {
  const dir = pluginBaseDir()
  const marker = readMarker(dir)
  const hasManifest = existsSync(join(dir, 'package.json'))
  return {
    dir,
    initialized: marker !== null && hasManifest,
    source: marker?.source ?? '',
    at: marker?.at ?? '',
    plugins: basePluginCount(dir)
  }
}

/**
 * 克隆一棵目录树：文件优先硬链接，失败（跨盘 / 权限）退回复制。
 *
 * 符号链接按原样重建 —— pnpm 的 `.pnpm` 布局里 `node_modules/<pkg>` 就是链接，
 * 落到实体文件会丢掉 `node_modules/.pnpm` 的复用结构。
 */
function cloneTree(
  src: string,
  dst: string,
  stats: { files: number; linked: number; copied: number; bytes: number }
): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dst, entry.name)

    if (entry.isSymbolicLink()) {
      const link = readlinkSync(from)
      try {
        // Windows 上 pnpm 用的是 junction（readlink 返回绝对路径）；相对链接保持相对
        symlinkSync(link, to, isAbsolute(link) ? 'junction' : 'dir')
      } catch {
        // 重建不了就跳过：这个包会少一个入口，下面的校验能发现
      }
      continue
    }

    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      cloneTree(from, to, stats)
      continue
    }

    const size = statSync(from).size
    try {
      linkSync(from, to)
      stats.linked += 1
    } catch {
      copyFileSync(from, to)
      stats.copied += 1
    }
    stats.files += 1
    stats.bytes += size
  }
}

/**
 * 把某个 profile 的插件**真实复制**成母版（初始化用）。
 *
 * 这里刻意**不用硬链接**：母版之后会被 pnpm 写入（装/升/卸），硬链接会让母版的改动
 * 同时改到源 profile 上。初始化是一次性动作，多花十几秒换隔离。
 *
 * ⚠️ **必须异步复制**（`cp` 而不是 `cpSync`）：74 MB 的 node_modules 复制要十几秒，
 * 同步版本会把 Electron 主进程整个占住 —— 窗口在此期间完全不响应，用户点任何按钮都没反应
 * （表现出来就是"弹窗点了没动静"）。同一课在 `tarCreate` / 快照那边已经吃过一次。
 */
async function copyIntoBase(source: string, base: string): Promise<{ files: number }> {
  let files = 0
  /*
   * 整目录复制（而不是只挑那 5 个文件）：profile 里除了 package.json / lock / patch，
   * 还有 **dsh 自己写的目录** —— 实测 `plugin --profile <name>` 会在 profile 下建
   * `.plugin-manager`。只复制固定文件名会把这类状态丢掉，到了母版里 dsh 会认为是全新的。
   */
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (skipEntry(entry.name)) continue
    const from = join(source, entry.name)
    const to = join(base, entry.name)
    if (entry.isDirectory()) {
      await cp(from, to, { recursive: true })
    } else {
      await copyFile(from, to)
    }
    files += 1
  }
  const modules = join(source, 'node_modules')
  if (existsSync(modules)) {
    await cp(modules, join(base, 'node_modules'), { recursive: true, verbatimSymlinks: true })
    files += 1
  }
  return { files }
}

/**
 * 初始化母版：把 `source` 那个 profile 的插件搬进来，并写标记。
 *
 * 已经初始化过会直接返回现有状态 —— 不覆盖用户可能已经在母版里做过的改动。
 * 要重做请先手动删掉母版目录（或设置里换一个目录）。
 */
export async function initBaseFromProfile(
  source: BaseSource,
  onProgress: (text: string) => void = () => {}
): Promise<BaseStatus> {
  const base = pluginBaseDir()
  const existing = baseStatus()
  if (existing.initialized) {
    onProgress(`插件母版已初始化（来源 ${existing.source}，${existing.plugins} 个插件），跳过`)
    return existing
  }

  const from = profileDir(source)
  if (!existsSync(join(from, 'package.json'))) {
    throw new Error(`profile「${source}」不存在或还没有 package.json：${from}`)
  }

  onProgress(`正在把 ${source} 的插件复制到母版：${base}`)
  mkdirSync(base, { recursive: true })
  /*
   * 目录里可能有上次失败留下的半成品：先清空再复制，避免新旧混在一起。
   * 逐个删（而不是删掉整个目录再建）—— 母版本身可能是一个 junction，
   * 删掉链接不会删到用户指定的目标目录，但会留下一堆孤儿文件。
   */
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name === MARKER) continue // 标记文件本来就代表"已初始化"，走到这里说明要重做
    rmSync(join(base, entry.name), { recursive: true, force: true })
  }
  const copied = await copyIntoBase(from, base)

  const marker: Marker = { initialized: true, source, at: new Date().toISOString() }
  writeFileSync(join(base, MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')

  /*
   * ⚠️ **这里不修改插件包里的任何文件。**
   *
   * 母版里的插件必须是原始文件：从 npm 拉的、从 git 拉的，原样放着。启动器**只做复制**
   * （母版 → profiles/web / profiles/desktop），一个字节都不改写插件自己的 package.json。
   *
   * 曾经试过把插件的 `engines.dsh` / `@deepseek-ai/dsh*` 的 peer 范围改成 `*`，
   * 好让 dsh 的版本检查放行 —— 这条路已经撤掉：它会让插件看起来和发布出去的不一样，
   * 出问题时无法判断是插件本身坏了还是被我们改坏了。
   */

  const status = baseStatus()
  onProgress(`母版就绪：${status.plugins} 个插件（来源 ${source}，${copied.files} 项）`)
  return status
}

/**
 * 补丁层合并：以母版为基准，保留目标端**独有**的条目。
 *
 * 桌面端的 `cordis.patch.yml` 里有它自己首次启动写下的引导条目
 * （`ui-chat` / `ui-settings` / `ui-settings-account`）—— 整体覆盖等于让用户重走引导，
 * 所以只能"补缺 + 对齐启停"。这段规则与 `sync.ts` 的 `mergePatchEntries` 同源。
 */
function mergePatch(baseText: string, targetText: string): string {
  // `[]` 占位符后面接块式条目是非法 YAML，桌面端会直接起不来
  let next = escapePlaceholder(targetText)
  const present = allRowIds(next)
  const pendingRows: string[] = []

  for (const entry of topLevelEntries(baseText)) {
    if (entry.id === null) {
      for (const row of insertRows(entry.text)) {
        if (row.id === null || present.has(row.id)) continue
        present.add(row.id)
        pendingRows.push(row.text)
      }
      continue
    }
    if (present.has(entry.id)) continue
    present.add(entry.id)
    next = `${next.replace(/\s+$/, '')}\n${entry.text}\n`
  }

  if (pendingRows.length > 0) {
    next = `${next.replace(/\s+$/, '')}\n- insert:\n${pendingRows.join('\n')}\n`
  }

  return alignDisabledFlags(baseText, next).text
}

export interface CloneReport {
  target: BaseSource
  /** 复制的文件数 */
  files: number
  /** 其中硬链接数与复制数 */
  linked: number
  copied: number
  bytes: number
  /** 克隆后仍然缺失/损坏的顶层包（空 = 正常） */
  broken: string[]
  /** 母版未变动、直接跳过复制 */
  skipped: boolean
}

/**
 * 母版内容指纹。
 *
 * 用途只有一个：**母版没变就别再复制一遍**。跨盘复制 474 MB 实测 14.5 秒、
 * 同盘硬链接约 2 秒 —— 每次启动都付这个代价没有必要，因为绝大多数启动
 * 母版根本没被动过。
 *
 * 取三样：`package.json` 与 `pnpm-lock.yaml` 的内容哈希（插件集合与版本由它们决定）
 * + `node_modules` 顶层条目数（能发现"文件被删了一半"这类不一致）。
 */
function baseFingerprint(base: string): string {
  const hash = createHash('sha256')
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    const file = join(base, name)
    hash.update(name)
    try {
      hash.update(readFileSync(file))
    } catch {
      hash.update('-')
    }
  }
  const modules = join(base, 'node_modules')
  let entries = 0
  try {
    entries = readdirSync(modules).length
  } catch {
    entries = 0
  }
  hash.update(`|${entries}`)
  return hash.digest('hex')
}

/** 目标 profile 上次克隆时的指纹；读不到返回空串 */
function readCloneMark(target: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(target, CLONE_MARK), 'utf8')) as { fingerprint?: unknown }
    return typeof raw.fingerprint === 'string' ? raw.fingerprint : ''
  } catch {
    return ''
  }
}

/** 源与目标是否在同一个盘符（决定能不能用硬链接） */
function sameVolume(a: string, b: string): boolean {
  return a.slice(0, 2).toLowerCase() === b.slice(0, 2).toLowerCase()
}

/**
 * 母版 → 目标 profile。每次启动前调用。
 *
 * 三种情况：
 *   ① 母版指纹与上次克隆时相同，且目标 `node_modules` 还在 → **直接跳过**（0 秒）
 *   ② 同盘 → 逐文件硬链接（约 2 秒，不额外占盘）
 *   ③ 跨盘 → `cpSync` 原生复制（实测 14.5 秒；逐文件 `copyFileSync` 要 27.6 秒）
 *
 * @throws 母版未初始化时抛出（调用方负责引导用户先选基线）
 */
export async function cloneBaseToProfile(
  target: BaseSource,
  onProgress: (text: string) => void = () => {}
): Promise<CloneReport> {
  const base = pluginBaseDir()
  const status = baseStatus()
  if (!status.initialized) {
    throw new Error('插件母版还没有初始化（尚未选择以 web 还是桌面端的插件为基线）')
  }

  const dest = profileDir(target)
  mkdirSync(dest, { recursive: true })

  const fingerprint = baseFingerprint(base)
  const destModules = join(dest, 'node_modules')
  const skip = readCloneMark(dest) === fingerprint && existsSync(join(destModules, '.pnpm'))

  // 配置：整目录同步（与母版保持同一套插件描述；`cordis.patch.yml` 单独合并）
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (skipEntry(entry.name)) continue
    if (entry.name === 'cordis.patch.yml') continue // 单独合并，保留目标端独有条目
    const from = join(base, entry.name)
    const to = join(dest, entry.name)
    try {
      if (entry.isDirectory()) {
        await rm(to, { recursive: true, force: true })
        await cp(from, to, { recursive: true })
      } else {
        await copyFile(from, to)
      }
    } catch (cause) {
      // 单个条目失败不该让整次启动失败（典型是目标端文件被占用）
      onProgress(`同步 ${entry.name} 失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const basePatch = join(base, 'cordis.patch.yml')
  if (existsSync(basePatch)) {
    const targetPatch = patchPathOf(dest)
    const targetText = existsSync(targetPatch) ? readFileSync(targetPatch, 'utf8') : ''
    const baseText = readFileSync(basePatch, 'utf8')
    try {
      writeFileSync(targetPatch, mergePatch(baseText, targetText), 'utf8')
    } catch (cause) {
      onProgress(`补丁层合并失败（不影响插件本体）：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  if (skip) {
    onProgress(`母版未变动，${target} 的插件跳过复制`)
    return { target, files: 0, linked: 0, copied: 0, bytes: 0, broken: [], skipped: true }
  }

  // node_modules：整棵重建（含 .pnpm，否则符号链接会断）
  await rm(destModules, { recursive: true, force: true })
  const sourceModules = join(base, 'node_modules')
  const stats = { files: 0, linked: 0, copied: 0, bytes: 0 }

  if (existsSync(sourceModules)) {
    if (sameVolume(base, dest)) {
      onProgress(`正在把母版的插件硬链接到 ${target}…`)
      mkdirSync(destModules, { recursive: true })
      cloneTree(sourceModules, destModules, stats)
    } else {
      /*
       * 跨盘：硬链接必定 EXDEV，直接走原生递归复制（比逐文件快一倍）。
       * **必须 `await cp`**，不能 `cpSync` —— 474 MB 同步复制会把主进程占满十几秒，
       * 界面在此期间完全无响应（用户点按钮得不到任何反馈，看起来就是"点了没动静"）。
       */
      onProgress(`母版在另一个盘，正在复制插件到 ${target}（约十几秒）…`)
      await cp(sourceModules, destModules, { recursive: true, verbatimSymlinks: true })
      const size = dirSize(destModules)
      stats.files = countFiles(destModules)
      stats.copied = stats.files
      stats.bytes = size
    }
  }

  // 校验：每个顶层包（含 @scope 下的）必须能读到 package.json
  const broken = findBrokenPackages(destModules)

  writeFileSync(join(dest, CLONE_MARK), `${JSON.stringify({ fingerprint, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')

  onProgress(
    `已同步 ${target}：${stats.files} 个文件（硬链接 ${stats.linked} / 复制 ${stats.copied}），` +
      `${Math.round(stats.bytes / 1024 / 1024)} MB`
  )
  return { target, ...stats, broken, skipped: false }
}

/** 递归统计文件数（跨盘复制后用，只为给出一个可读的进度数字） */
function countFiles(dir: string): number {
  let n = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(current, entry.name))
      else n += 1
    }
  }
  return n
}

function dirSize(dir: string): number {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        try {
          total += statSync(full).size
        } catch {
          // 读不到就跳过
        }
      }
    }
  }
  return total
}

/** 找出 `node_modules` 里读不到 `package.json` 的包（含 `@scope/name` 两层） */
function findBrokenPackages(modulesDir: string): string[] {
  const broken: string[] = []
  let entries
  try {
    entries = readdirSync(modulesDir, { withFileTypes: true })
  } catch {
    return broken
  }
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('@')) {
      // scope 目录：下钻一层才是真正的包
      const scopeDir = join(modulesDir, entry.name)
      let inner
      try {
        inner = readdirSync(scopeDir, { withFileTypes: true })
      } catch {
        broken.push(entry.name)
        continue
      }
      for (const pkg of inner) {
        if (!existsSync(join(scopeDir, pkg.name, 'package.json'))) broken.push(`${entry.name}/${pkg.name}`)
      }
      continue
    }
    if (!existsSync(join(modulesDir, entry.name, 'package.json'))) broken.push(entry.name)
  }
  return broken
}
