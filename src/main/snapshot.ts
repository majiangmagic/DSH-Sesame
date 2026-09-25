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
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, profileDir } from './dshHome'
import { dataRoot } from './paths'
import { readSettings } from './settings'
import { currentRun } from './runner'
import type {
  RestoreResult,
  SnapshotEntry,
  SnapshotModules,
  SnapshotPaths,
  SnapshotPluginRef,
  SnapshotPreview,
  SnapshotTrigger
} from '@shared/snapshot'

/** 快照的文件清单（照 dsh-plugin-guard）。顺序即界面上的展示顺序。 */
export const SNAPSHOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.yml',
  'cordis.patch.yml'
] as const

/** 每个 profile 最多保留多少份 */
export const SNAPSHOT_KEEP = 10


/**
 * 快照根目录。
 *
 * 默认放在**应用目录**下的 snapshots（用户要求 —— C 盘紧张，快照要跟软件一起放 D 盘）：
 *   开发时 = 项目目录/snapshots
 *   打包后 = 安装目录/snapshots
 *
 * 设置里可改（snapshotDir），因为打包后的安装目录**会被覆盖安装清空** ——
 * 介意的人可以指到安装目录之外。
 */
export function snapshotRoot(): string {
  const custom = readSettings().snapshotDir
  if (typeof custom === 'string' && custom.trim() !== '') return custom.trim()
  // 默认放**数据根目录**下（应用目录的隔壁）—— 安装包不会碰它，见 paths.ts 的说明
  return join(dataRoot(), 'snapshots')
}

function dirOf(profile: string): string {
  return join(snapshotRoot(), profile)
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
function fingerprintOf(dir: string): string {
  const h = createHash('sha256')
  const walk = (cur: string, rel: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(cur).sort()
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(cur, name)
      const r = rel === '' ? name : rel + '/' + name
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        h.update('D' + r + '\n')
        walk(full, r)
      } else {
        h.update('F' + r + '|' + st.size + '|' + Math.round(st.mtimeMs) + '\n')
      }
    }
  }
  walk(dir, '')
  return h.digest('hex')
}

/**
 * 把整个 node_modules 打成一个 tgz。
 *
 * 用**系统自带的 tar**（Win10+ 都有）：比 PowerShell 的 Compress-Archive 快很多，
 * 支持长路径，而且不用为此引一个新依赖进来。
 */
function tarCreate(profileDirPath: string, outFile: string): void {
  const r = spawnSync('tar', ['-czf', outFile, '-C', profileDirPath, 'node_modules'], { windowsHide: true })
  if (r.status !== 0) {
    throw new Error(`打包 node_modules 失败（tar 退出码 ${r.status}）：${String(r.stderr || '').slice(0, 200)}`)
  }
}

/** 把 tgz 解回 profile 目录（同名覆盖） */
function tarExtract(file: string, intoDir: string): void {
  const r = spawnSync('tar', ['-xzf', file, '-C', intoDir], { windowsHide: true })
  if (r.status !== 0) {
    throw new Error(`解包失败（tar 退出码 ${r.status}）：${String(r.stderr || '').slice(0, 200)}`)
  }
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
export function createSnapshot(trigger: SnapshotTrigger, label = ''): SnapshotEntry {
  const settings = readSettings()
  const profile = settings.profile
  const src = profileDir(profile)
  if (!existsSync(src)) throw new Error(`profile 目录不存在：${src}`)

  const id = stamp()
  const dest = join(dirOf(profile), id)

  /*
   * 先去重：node_modules 的内容与最新一份**完全相同**时，什么都不做。
   *
   * 全量打包一次上百 MB、几十秒 —— 插件的自动存档（每次开关/安装前都会调到这里）
   * 如果每次都真打一遍，很快就是几个 GB。指纹一样说明上一份已经完全覆盖了当前状态。
   */
  const modulesDir = join(src, 'node_modules')
  const fingerprint = existsSync(modulesDir) ? fingerprintOf(modulesDir) : ''
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
    const tgz = join(dest, 'modules.tgz')
    tarCreate(src, tgz)
    modules = { file: 'modules.tgz', bytes: statSync(tgz).size, sha256: sha256Of(tgz) }
  }

  const entry: SnapshotEntry = {
    id,
    at: new Date().toISOString(),
    profile,
    dshVersion: currentRun()?.version ?? '',
    trigger,
    label,
    files: copied,
    bytes,
    modules,
    fingerprint
  }
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify(entry, null, 2), 'utf8')
  prune(profile)
  return entry
}

/** 超出保留数就删最旧的 */
function prune(profile: string): void {
  const dir = dirOf(profile)
  if (!existsSync(dir)) return
  const ids = readdirSync(dir).sort() // 时间戳命名 ⇒ 字典序即时间序
  const excess = ids.length - SNAPSHOT_KEEP
  for (let i = 0; i < excess; i++) {
    rmSync(join(dir, ids[i]), { recursive: true, force: true })
  }
}

/** 列出快照，新的在前 */
export function listSnapshots(): SnapshotEntry[] {
  const dir = dirOf(readSettings().profile)
  if (!existsSync(dir)) return []
  const out: SnapshotEntry[] = []
  for (const id of readdirSync(dir)) {
    const m = readManifest(join(dir, id))
    if (m) out.push(m)
  }
  return out.sort((a, b) => b.id.localeCompare(a.id))
}

/**
 * 回退到指定快照。
 *
 * **先自动存一份当前状态**（trigger='pre-rollback'）—— 否则回退本身不可逆，
 * 回退错了就全丢了。这一步和 dsh-plugin-guard 的做法一致。
 *
 * 只写回文件；`node_modules` 是否随之更新由界面提示，不在这一步自动跑 pnpm。
 */
export function restoreSnapshot(id: string): RestoreResult {
  const profile = readSettings().profile
  const src = join(dirOf(profile), id)
  if (!existsSync(src)) throw new Error(`快照不存在：${id}`)
  const manifest = readManifest(src)
  if (!manifest) throw new Error(`快照缺少 manifest.json：${id}`)

  const backup = createSnapshot('pre-rollback', `回退到 ${id} 之前`)
  const dest = profileDir(profile)

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
    const tgz = join(src, manifest.modules.file)
    if (existsSync(tgz)) {
      tarExtract(tgz, dest)
      modulesRestored = true
    }
  }
  return { restored, skipped, backupId: backup.id, modulesRestored }
}

/**
 * 删除一份快照。
 *
 * 只删这一份；不清 node_modules、不动 profile。
 * id 里带路径分隔符的一律拒绝 —— 这是一条防目录穿越的底线：
 * 这个函数按 id 直接拼路径，若 id 来自界面且含 ../，就会删到快照目录外面。
 */
export function deleteSnapshot(id: string): boolean {
  if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('快照 id 非法：' + id)
  }
  const dir = join(dirOf(readSettings().profile), id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
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
export function snapshotPreview(): SnapshotPreview {
  const profile = readSettings().profile
  const dir = profileDir(profile)
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
    modulesBytes: existsSync(nm) ? dirSize(nm) : 0,
    willPack: existsSync(nm),
    lastAt: latest?.at ?? '',
    lastModulesBytes: latest?.modules?.bytes ?? 0
  }
}

/** 递归求目录大小（字节）—— 只在预演里用，1.4 万文件约 1 秒 */
function dirSize(dir: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) total += dirSize(full)
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
  return { profileDir: profileDir(readSettings().profile), root: snapshotRoot(), home: dshHome() }
}
