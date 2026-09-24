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
 * 存放位置：`<userData>/snapshots/<profile>/<stamp>/`
 *   刻意**不放安装目录** —— 覆盖安装会把安装目录整个清空（本会话实测过：
 *   版本池就是这么丢的），而快照恰恰要在"出事时"还在，所以放 userData。
 *
 * 回退语义：
 *   · 只写回文件。**回退前先自动存一份当前状态**（否则回退本身不可逆）。
 *   · 不自动跑 pnpm install —— node_modules 的同步是另一件事，界面上会说明。
 */
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, profileDir } from './dshHome'
import { readSettings } from './settings'
import { currentRun } from './runner'
import type { RestoreResult, SnapshotEntry, SnapshotPaths, SnapshotTrigger } from '@shared/snapshot'

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


export function snapshotRoot(): string {
  return join(app.getPath('userData'), 'snapshots')
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

  const entry: SnapshotEntry = {
    id,
    at: new Date().toISOString(),
    profile,
    dshVersion: currentRun()?.version ?? '',
    trigger,
    label,
    files: copied,
    bytes
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
  return { restored, skipped, backupId: backup.id }
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

/** 诊断用：当前 profile 的配置目录与快照根（界面显示用） */
export function snapshotPaths(): SnapshotPaths {
  return { profileDir: profileDir(readSettings().profile), root: snapshotRoot(), home: dshHome() }
}
