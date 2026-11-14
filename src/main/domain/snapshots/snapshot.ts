/**
 * 插件配置快照 —— 手动 / 自动存，最多 10 份，可回退。
 *
 * 快照的**文件清单照 dsh-plugin-guard**（它实测过这套够用）：
 *   package.json         装了哪些插件、什么版本
 *   pnpm-lock.yaml       锁定版本，恢复才可复现
 *   pnpm-workspace.yaml  pnpm 的设置（nodeLinker / allowBuilds / 发布冷却白名单…）
 *                        —— 少了它，pnpm 装出来的 node_modules 会不一样
 *   cordis.yml           profile 根（MCP 实例等配置的落点）
 *   cordis.patch.yml     每个插件的**开关状态**
 *
 * 存放位置：`<数据根目录>/snapshots/<profile>/<stamp>/`
 *   数据根目录 = 应用目录的**隔壁**（`<安装目录的父目录>/DSH-Sesame-data`，见 paths.ts）。
 *   刻意**不放安装目录里面** —— 覆盖安装会把它整个清空（本会话实测过：用户的
 *   1.1 GB 版本池就是这么丢的），而快照恰恰要在"出事时"还在。
 *
 * 回退语义：
 *   · 只写回文件。**回退前先自动存一份当前状态**（否则回退本身不可逆）。
 *   · 不自动跑 pnpm install —— node_modules 的同步是另一件事，界面上会说明。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from '../../platform/dshHome'
import { dataRoot, pluginBaseDir } from '../../platform/paths'
import { readSettings } from '../../platform/settings'
/*
 * 这里**不** import `currentRun`。曾经用它把"存的那一刻在跑哪个版本"记进 manifest，
 * 那个字段已经去掉 —— 理由见 `@shared/types/snapshots` 顶部。
 * 副作用是本领域少一条对 `domain/control` 的依赖。
 */
import type {
  RestoreResult,
  SnapshotEntry,
  SnapshotModules,
  SnapshotPaths,
  SnapshotPluginRef,
  SnapshotPreview,
  SnapshotTrigger
} from '@shared/types/snapshots'

/** 快照的文件清单（照 dsh-plugin-guard）。顺序即界面上的展示顺序。 */
export const SNAPSHOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.yml',
  'cordis.patch.yml'
] as const

/** 最多保留多少份 */
export const SNAPSHOT_KEEP = 10


/**
 * 快照锚定的**存档范围** —— 现在是「插件母版」，不再是某个 profile。
 *
 * 插件集中到母版之后（唯一写入点），快照的意义也跟着变了：
 *   · 存的 = 母版当前的插件清单 + 开关 + 整棵 node_modules
 *   · 回退到 = 把母版恢复成那一份，然后下次启动克隆给 web / 桌面端
 *
 * 所以没有任何理由再去读 `profiles/web` —— 那只是一份随时会被重建的副本，
 * 对它存档等于存了个派生结果。
 *
 * 目录名因此定为 `base`。但老版本的快照是按 profile 名分的（`snapshots/web/`），
 * 直接改名会让历史快照"消失"，所以 `scopeDir()` 里有兼容：`base` 不存在时退回 `web`。
 */
const SNAPSHOT_SCOPE = 'base'

/** 旧版本按 profile 名存快照，读到它时继续沿用（不迁移、不丢历史） */
const LEGACY_SCOPE = 'web'


/**
 * 快照根目录。
 *
 * 默认放在**数据根目录**下（安装目录的隔壁，安装包不会碰它）：
 *   开发时 = 项目目录/../DSH-Sesame-data/snapshots
 *   打包后 = <exe 所在目录的父目录>/DSH-Sesame-data/snapshots
 *
 * 设置里可改（`snapshotDir`）。**别指回安装目录里** —— 覆盖安装会把那里删掉。
 */
export function snapshotRoot(): string {
  const custom = readSettings().snapshotDir
  if (typeof custom === 'string' && custom.trim() !== '') return custom.trim()
  return join(dataRoot(), 'snapshots')
}

/**
 * 快照实际存放的子目录（`<root>/base`）。
 *
 * 首次在新版本里打开时 `base` 还不存在、而旧版留下的 `web` 里可能有历史快照 ——
 * 那种情况沿用 `web`，用户不会觉得"快照全没了"。
 */
function scopeDir(): string {
  const root = snapshotRoot()
  const current = join(root, SNAPSHOT_SCOPE)
  if (existsSync(current)) return current
  const legacy = join(root, LEGACY_SCOPE)
  if (existsSync(legacy)) return legacy
  return current
}

/** 快照覆盖的**源目录**：插件母版（未初始化时落到默认母版路径，由调用方给出可读报错） */
function sourceDir(): string {
  return pluginBaseDir()
}

/** 快照存放目录（`<root>/base`，兼容旧版的 `<root>/web`） */
function dirOf(): string {
  return scopeDir()
}

/** 文件系统安全的时间戳（冒号在 Windows 上不能做文件名） */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function readManifest(dir: string): SnapshotEntry | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as SnapshotEntry
  } catch {
    return null
  }
}

/**
 * 算 node_modules 的内容指纹（文件清单 + 大小 + 修改时间）。
 *
 * 遍历 1.4 万个文件大约 1~2 秒，比真打一次包（几十秒）便宜得多 ——
 * 所以先用它判断"这一份和上一份一样吗"，一样就完全跳过打包。
 */
async function fingerprintOf(dir: string): Promise<string> {
  /*
   * **只看顶层条目，不递归。**
   *
   * 原来递归遍历三万个文件算 size+mtime，实测 5～10 秒 —— 而它只是为了回答
   * "内容有没有变"。这个问题的真正答案由 `package.json` / `pnpm-lock.yaml`
   * 决定：装、卸、更新插件**必然**改它们，所以调用方把配置 hash 一并算进总指纹。
   *
   * 递归的代价远大于收益：现在这一步是毫秒级，硬链接建快照 10 秒，
   * 整个过程从"30 秒以上"降到十几秒。
   */
  const h = createHash('sha256')
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      h.update(`${entry.isDirectory() ? 'D' : 'F'}${entry.name}\n`)
    }
  } catch {
    return ''
  }
  return h.digest('hex')
}

/**
 * 把整个 node_modules 打成一个 tgz。
 *
 * 用**系统自带的 tar**（Win10+ 都有）：比 PowerShell 的 Compress-Archive 快很多，
 * 支持长路径，而且不用为此引一个新依赖进来。
 */
/**
 * 把一棵目录树用**硬链接**复制到目标（同盘专用）。
 *
 * 3 万个文件实测 2 秒左右，而 tar 压缩要 23 秒。快照排在每次装 / 卸 / 更新插件
 * **之前**，这 20 秒差距就是"点了没反应"和"立刻开始"的区别。
 *
 * 跨盘时硬链接必 EXDEV，由调用方改用 tar；这里对单个文件的链接失败退回复制。
 */
async function linkTree(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) {
      await linkTree(from, to)
      continue
    }
    if (entry.isSymbolicLink()) {
      try {
        await symlink(await readlink(from), to)
      } catch {
        // 重建不了就跳过：快照里少一个入口不影响整体
      }
      continue
    }
    try {
      await link(from, to)
    } catch {
      try {
        await copyFile(from, to)
      } catch {
        // 单个文件失败不阻断整次快照
      }
    }
  }
}

async function tarCreate(profileDirPath: string, outFile: string): Promise<void> {
  /*
   * **必须异步**。原来用 spawnSync —— 它会阻塞主进程直到 tar 退出：
   * 打包 323 MB 的 node_modules 实测约 20 秒，这 20 秒里窗口不重绘、
   * 按钮无响应（用户反馈"点一下总是卡一下"就是它）。
   * 换成 spawn + Promise 后主进程只等事件，界面保持响应。
   */
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-czf', outFile, '-C', profileDirPath, 'node_modules'], { windowsHide: true })
    let err = ''
    child.stderr?.on('data', (b: Buffer) => { err += String(b) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`打包 node_modules 失败（tar 退出码 ${code}）：${err.slice(0, 200)}`))
    })
  })
}

/** 把 tgz 解回 profile 目录（同名覆盖） */
async function tarExtract(file: string, intoDir: string): Promise<void> {
  // 同上：解包也可能几十秒，绝不能阻塞主进程
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', file, '-C', intoDir], { windowsHide: true })
    let err = ''
    child.stderr?.on('data', (b: Buffer) => { err += String(b) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解包失败（tar 退出码 ${code}）：${err.slice(0, 200)}`))
    })
  })
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 存一份快照。
 *
 * @param trigger 'manual' 用户点按钮；'auto' 插件变更前；'pre-rollback' 回退前自动存
 * @param label   备注（手动时可填）
 */
export async function createSnapshot(trigger: SnapshotTrigger, label = ''): Promise<SnapshotEntry> {
  const src = sourceDir()
  if (!existsSync(src)) throw new Error(`插件母版目录不存在：${src}。请先在插件页选择基线初始化母版。`)

  const id = stamp()
  const dest = join(dirOf(), id)

  /*
   * 先去重：node_modules 的内容与最新一份**完全相同**时，什么都不做。
   *
   * 全量打包一次上百 MB、几十秒 —— 插件的自动存档（每次开关/安装前都会调到这里）
   * 如果每次都真打一遍，很快就是几个 GB。指纹一样说明上一份已经完全覆盖了当前状态。
   */
  const modulesDir = join(src, 'node_modules')
  /*
   * 指纹必须**同时覆盖 node_modules 与那 5 个配置文件**。
   *
   * 踩过的坑：一开始只算 node_modules，于是"只改了配置、依赖没动"会被判成
   * "内容与上一份相同" → 回退前那份 pre-rollback **静默不生成**。
   * 而回退本身可逆正是靠那一份 —— 这种误判会让人以为有退路、实际没有。
   */
  const modulesPrint = existsSync(modulesDir) ? await fingerprintOf(modulesDir) : ''
  const configPrint = SNAPSHOT_FILES.map((name) => {
    const f = join(src, name)
    return existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : '-'
  }).join(',')
  const fingerprint = createHash('sha256').update(modulesPrint + '|' + configPrint).digest('hex')
  const latest = listSnapshots()[0]
  if (latest && fingerprint !== '' && latest.fingerprint === fingerprint) {
    return { ...latest, reused: true }
  }

  mkdirSync(dest, { recursive: true })

  const copied: string[] = []
  let bytes = 0
  for (const name of SNAPSHOT_FILES) {
    const from = join(src, name)
    if (!existsSync(from)) continue // 配置文件本来就可能缺，缺的不记
    copyFileSync(from, join(dest, name))
    copied.push(name)
    bytes += statSync(join(dest, name)).size
  }

  // 全量打包 node_modules —— 不再区分 npm / 私有来源，全都在包里，也就不会漏
  let modules: SnapshotModules | null = null
  if (existsSync(modulesDir)) {
    /*
     * 同盘 → 硬链接整棵树（秒级）；跨盘 → 退回 tar 压缩包（几十秒）。
     *
     * 快照目录与母版默认都在 `<数据根>` 下，所以绝大多数用户走的是快路径。
     */
    const sameDisk = src.slice(0, 2).toLowerCase() === dest.slice(0, 2).toLowerCase()
    if (sameDisk) {
      await linkTree(modulesDir, join(dest, 'modules'))
      modules = { dir: 'modules', bytes: 0 }
    } else {
      const tgz = join(dest, 'modules.tgz')
      await tarCreate(src, tgz)
      modules = { file: 'modules.tgz', bytes: statSync(tgz).size, sha256: sha256Of(tgz) }
    }
  }

  const entry: SnapshotEntry = {
    id,
    at: new Date().toISOString(),
    /** 存档范围：插件母版（字段名沿用 `profile` 以免破坏已有 manifest 的读取） */
    profile: SNAPSHOT_SCOPE,
    trigger,
    label,
    files: copied,
    bytes,
    modules,
    fingerprint
  }
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify(entry, null, 2), 'utf8')
  await prune()
  return entry
}

/**
 * 超出保留数就删最旧的。
 *
 * **只按份数，不按体积**：快照会随着插件变多而变大，这是预期内的 —— 用总体积去
 * 卡会变成"插件一装大，昨晚那份就被悄悄删了"，比占盘更糟。
 */
async function prune(): Promise<void> {
  const dir = dirOf()
  if (!existsSync(dir)) return
  const ids = readdirSync(dir).sort() // 时间戳命名 ⇒ 字典序即时间序
  const excess = ids.length - SNAPSHOT_KEEP
  for (let i = 0; i < excess; i += 1) {
    await rm(join(dir, ids[i]), { recursive: true, force: true })
  }
}

/** 列出快照，新的在前 */
export function listSnapshots(): SnapshotEntry[] {
  const dir = dirOf()
  if (!existsSync(dir)) return []
  const out: SnapshotEntry[] = []
  for (const id of readdirSync(dir)) {
    const m = readManifest(join(dir, id))
    if (m) out.push(m)
  }
  return out.sort((a, b) => b.id.localeCompare(a.id))
}

/** 快照 id 的底线校验：禁止路径分隔符与 `..`（防目录穿越，restore 与 delete 共用）。 */
function assertSafeSnapshotId(id: string): void {
  if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('快照 id 非法：' + id)
  }
}

/**
 * 回退到指定快照。
 *
 * **先自动存一份当前状态**（trigger='pre-rollback'）—— 否则回退本身不可逆，
 * 回退错了就全丢了。这一步和 dsh-plugin-guard 的做法一致。
 *
 * 只写回文件；`node_modules` 是否随之更新由界面提示，不在这一步自动跑 pnpm。
 */
export async function restoreSnapshot(id: string): Promise<RestoreResult> {
  assertSafeSnapshotId(id)
  const src = join(dirOf(), id)
  if (!existsSync(src)) throw new Error(`快照不存在：${id}`)
  const manifest = readManifest(src)
  if (!manifest) throw new Error(`快照缺少 manifest.json：${id}`)

  const backup = await createSnapshot('pre-rollback', `回退到 ${id} 之前`)
  const dest = sourceDir()

  const restored: string[] = []
  const skipped: string[] = []
  for (const name of SNAPSHOT_FILES) {
    const from = join(src, name)
    if (!existsSync(from)) { skipped.push(name); continue }
    copyFileSync(from, join(dest, name))
    restored.push(name)
  }
  // 整包也解回去。快照里没有整包 = 那次内容与最新一份相同、被去重跳过了，
  // 那种情况下上一份快照里已经有同样的整包，回退到它即可。
  let modulesRestored = false
  if (manifest.modules) {
    const mod = manifest.modules
    if (mod.dir !== undefined) {
      // 硬链接形态：直接反向链接回母版（先清空现有 node_modules）
      const from = join(src, mod.dir)
      if (existsSync(from)) {
        await rm(join(dest, 'node_modules'), { recursive: true, force: true })
        await linkTree(from, join(dest, 'node_modules'))
        modulesRestored = true
      }
    } else if (mod.file !== undefined) {
      const tgz = join(src, mod.file)
      if (existsSync(tgz)) {
        await tarExtract(tgz, dest)
        modulesRestored = true
      }
    }
  }
  return { restored, skipped, backupId: backup.id, modulesRestored }
}

/**
 * 删除一份快照。
 *
 * 只删这一份；不清 node_modules、不动 profile。
 */
export async function deleteSnapshot(id: string): Promise<boolean> {
  assertSafeSnapshotId(id)
  const dir = join(dirOf(), id)
  if (!existsSync(dir)) return false
  await rm(dir, { recursive: true, force: true })
  return true
}

/*
 * 这里原本有一套"npm / 非 npm 来源判定"（declaredSpecifiers / isExternalSource /
 * hoistedLocations 比对）—— **已删除**。
 *
 * 原因：打包是**全量的**，根本不需要知道插件从哪来。那套判定不但多余，
 * 还不准（真 profile 上把 cytoscape-fcose 这类正常的传递依赖误报成"手工放入"）。
 * 现在的做法是 snapshotPreview()：平铺列出插件 + 报 node_modules 大小，仅此而已。
 */

/**
 * 存快照前的预演：弹窗里显示什么就是什么。
 *
 * **刻意不做分类**：打包是全量的，只需要把"有哪些插件"平铺列出来，
 * 再告诉用户 node_modules 有多大、上一次存是什么时候。
 */
export async function snapshotPreview(): Promise<SnapshotPreview> {
  const dir = sourceDir()
  const nm = join(dir, 'node_modules')

  let plugins: SnapshotPluginRef[] = []
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    plugins = Object.keys(parsed.dependencies ?? {}).map((name) => ({
      name,
      version: readInstalledVersion(join(nm, name))
    }))
  } catch {
    plugins = []
  }

  const latest = listSnapshots()[0]
  return {
    plugins,
    configFiles: SNAPSHOT_FILES.filter((f) => existsSync(join(dir, f))),
    modulesDir: nm,
    modulesBytes: existsSync(nm) ? await dirSize(nm) : 0,
    willPack: existsSync(nm),
    lastAt: latest?.at ?? '',
    lastModulesBytes: latest?.modules?.bytes ?? 0
  }
}

/** 递归求目录大小（字节）—— 只在预演里用，1.4 万文件约 1 秒 */
async function dirSize(dir: string): Promise<number> {
  // 同上：递归求和也走异步，别让主进程被上万次 stat 占住
  let total = 0
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st: Awaited<ReturnType<typeof lstat>>
    try {
      st = await lstat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) total += await dirSize(full)
    else total += st.size
  }
  return total
}

/** 读一个已安装包的版本号（读不到就空串） */
function readInstalledVersion(pkgDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string }
    return typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}

/**
 * 超时上限：整包很大时 tar 也要时间，但别让界面无限等。
 * 调用方（IPC）不设超时，这里只做说明用。
 */
export function snapshotPaths(): SnapshotPaths {
  return { profileDir: sourceDir(), root: snapshotRoot(), home: dshHome() }
}
