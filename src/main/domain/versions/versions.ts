import { existsSync, readdirSync, type Dirent } from 'node:fs'
import type { InstalledVersion, VersionOverview } from '@shared/types/versions'
import { versionBin, versionRoot } from '../../infrastructure/paths'
import { fetchRemote, type RemoteInfo } from '../../infrastructure/registry'
import { cmpVer, parseVer } from '@utils/version'
import { currentRun } from '../control/runner'

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/

/*
 * 为什么这里没有"扫描系统里 npm 全局安装的 dsh"：
 *
 * 这里刻意**不扫描**机器上 npm 全局安装的 dsh，理由：
 *   1. 版本池的语义是"这个启动器自己的东西" —— 可以整份删掉重建；npm 全局是全机器共享的，
 *      混进来会让多个启动器之间的独立破一半；
 *   2. 那份不是本应用装的，同一个列表里会出现"能卸我装的 / 不能卸别人的"两种卸载语义；
 *   3. 那样的实现是"命中即返回"，多个全局根目录只会认第一个 —— 这个概念在源头就没定义清楚。
 *
 * 需要在机器上共用一份 dsh 时，那是另一件事（导入/挂载外部安装），不该混进版本池。
 */

/** 应用自己装的版本：`<版本根>/<版本号>/node_modules/@deepseek-ai/dsh/lib/bin.js` 存在即算装好。 */
function scanInstalled(): InstalledVersion[] {
  const found: InstalledVersion[] = []
  const root = versionRoot()
  if (!existsSync(root)) return found

  let entries: Dirent[] = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_RE.test(entry.name)) continue
    const bin = versionBin(entry.name)
    if (!existsSync(bin)) continue
    found.push({ version: entry.name, status: 'stopped', url: null, bin })
  }
  return found
}

/** 已安装版本，按 semver 从高到低；运行中的那个带上实时 status/url。 */
export function listInstalled(): InstalledVersion[] {
  const found = scanInstalled().sort((a, b) => {
    const pa = parseVer(a.version)
    const pb = parseVer(b.version)
    if (!pa || !pb) return a.version.localeCompare(b.version)
    return cmpVer(pb, pa)
  })

  // 运行态不在磁盘上，而在这个进程的内存里 —— 由 runner 提供，在这里合并，
  // 这样界面只要读 overview 就能同时看到"装了哪些"和"哪个在跑"。
  const live = currentRun()
  if (live !== null) {
    const hit = found.find((item) => item.version === live.version)
    if (hit) {
      hit.status = live.status
      hit.url = live.url
    }
  }
  return found
}

let cache: { at: number; info: RemoteInfo } | null = null
const CACHE_MS = 60_000

/** 远端版本表（带 60 秒缓存，避免界面每次切页都打 registry）。 */
async function remoteInfo(): Promise<RemoteInfo> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.info
  const info = await fetchRemote()
  cache = { at: Date.now(), info }
  return info
}

/**
 * 版本总览。
 *
 * 远端失败**不抛错**，而是把原因放进 `remoteError` 返回 —— 界面应当照常显示已装版本，
 * 只是远端那一列空着并给出提示。拉不到 registry 不该让整个页面用不了。
 */
export async function overview(): Promise<VersionOverview> {
  const installed = listInstalled()
  const root = versionRoot()
  try {
    const info = await remoteInfo()
    return {
      root,
      installed,
      remote: {
        versions: info.versions,
        tags: info.tags,
        latest: info.latest,
        tagLatest: info.tagLatest
      },
      remoteError: ''
    }
  } catch (error) {
    return {
      root,
      installed,
      remote: null,
      remoteError: error instanceof Error ? error.message : String(error)
    }
  }
}
