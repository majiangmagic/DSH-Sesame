import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileDir } from './dshHome'
import { desktopRuntime, installedDesktopVersions, runDesktopCli, type DesktopRuntime } from './desktop'
import { peerMismatch, readPluginManifest } from './diagnose'
import { patchPathOf } from './patch'

/**
 * 把 **web profile** 的插件与模型提供商同步到 **桌面端 profile**。
 *
 * 为什么需要它：官方把 Desktop 的 profile 设计成独立的一套（独占 `profiles/desktop`，
 * 与 web 不共享插件/依赖/锁）。代价是同一个插件要装两遍、provider 要配两遍。
 * 这里采用「**web 为唯一基准**」：启动桌面端前把 web 的插件清单与 provider 配置补到桌面端；
 * 主界面的插件开关也同时写两端（见 ipc.ts）。
 *
 * 三个关键前提：
 *  1. 用**桌面端自带的 CLI**（`desktopRuntime`）去装 / 去豁免 —— 它的 dsh 版本才是桌面端真正用的
 *     那一版；用版本池里的 dsh 去判断，授出来的豁免版本号是错的、等于没授。
 *  2. 桌面端**正在跑**时不能动它的 profile（写锁），所以只在启动前同步。
 *  3. **幂等**：只补缺的，不删桌面端独有的东西；失败只记录，不阻断启动。
 */

export interface SyncProgress {
  text: string
}

export interface SyncResult {
  /** 新装进桌面端的插件 */
  installed: string[]
  /** web 有、桌面端已有（跳过） */
  present: string[]
  /** 同步过去的补丁条目 / 插入行的 id（provider、默认模型、MCP 服务器…） */
  patched: string[]
  /** 因为"版本声明落后"而开了兼容豁免的插件（装了但 dsh 本来会拦） */
  exempted: string[]
  /** 装了但失败的插件（多半是连豁免都救不了的硬错误） */
  failed: string[]
}

const WEB = 'web'
const DESKTOP = 'desktop'

/** 读一个 profile 的依赖清单（包名 → 版本范围/来源）。 */
function readDeps(profile: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir(profile), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return pkg.dependencies ?? {}
  } catch {
    return {}
  }
}

/** 读某个 profile 里某个包**实际装上**的版本（不是清单里写的范围）。 */
function installedVersion(profile: string, name: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(profileDir(profile), 'node_modules', name, 'package.json'), 'utf8')
    ) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * 抓出补丁文本里出现过的**所有行 id**（任意缩进的 `- id: X`）。
 *
 * 判重必须用它，而不是"插入块里有没有"：web 补丁自己的注释写明 —— **顶层 insert 是追加且
 * 不去重的**，同一个 id insert 两次会让插件挂载两份（QQ Bot 那两条会长出两条长连接）。
 * 所以只要这个 id 在桌面端补丁里**任何地方**出现过，就不能再 insert。
 */
function allRowIds(text: string): Set<string> {
  const ids = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/.exec(line)
    if (match) ids.add(match[1] as string)
  }
  return ids
}

/** 按顶层条目切开补丁数组（每段以列 0 的 `- ` 开头）。 */
function topLevelEntries(text: string): Array<{ id: string | null; text: string }> {
  const lines = text.split(/\r?\n/)
  const out: Array<{ id: string | null; text: string }> = []
  let cursor = 0
  while (cursor < lines.length) {
    if (!/^- /.test(lines[cursor] ?? '')) {
      cursor += 1
      continue
    }
    const start = cursor
    const idMatch = /^- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/.exec(lines[start] ?? '')
    cursor += 1
    while (cursor < lines.length && !/^- /.test(lines[cursor] ?? '')) cursor += 1
    out.push({
      id: idMatch ? (idMatch[1] as string) : null,
      text: lines.slice(start, cursor).join('\n').replace(/\s+$/, '')
    })
  }
  return out
}

/** 把 `- insert:` 块里的行（4 空格缩进的 `- `）逐条切出来 —— MCP 服务器就是这一种。 */
function insertRows(entryText: string): Array<{ id: string | null; text: string }> {
  const lines = entryText.split(/\r?\n/)
  const out: Array<{ id: string | null; text: string }> = []
  let cursor = 0
  while (cursor < lines.length) {
    if (!/^ {4}- /.test(lines[cursor] ?? '')) {
      cursor += 1
      continue
    }
    const start = cursor
    const idMatch = /^ {4}- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/.exec(lines[start] ?? '')
    cursor += 1
    while (
      cursor < lines.length &&
      !/^ {4}- /.test(lines[cursor] ?? '') &&
      !/^- /.test(lines[cursor] ?? '')
    ) {
      cursor += 1
    }
    out.push({
      id: idMatch ? (idMatch[1] as string) : null,
      text: lines.slice(start, cursor).join('\n').replace(/\s+$/, '')
    })
  }
  return out
}

function readPatch(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 把 web 补丁层里**桌面端还没有的条目**机械搬过去。
 *
 * 覆盖两种形态：
 *  - 顶层 `- id: X` 条目（provider、agent-default-model、qqbot、ui-settings-general…）
 *  - `- insert:` 块里的行 —— **MCP 服务器就是这一种**，按行 id 逐条判断
 *
 * 判重用 `allRowIds(next)`（在整个补丁里出现过即算有），理由见它的注释。
 * 只补缺，不覆盖、不删除桌面端独有的条目。
 */
function mergePatchEntries(onProgress: (p: SyncProgress) => void): string[] {
  const webText = readPatch(patchPathOf(profileDir(WEB)))
  const desktopPath = patchPathOf(profileDir(DESKTOP))
  const before = readPatch(desktopPath)
  let next = before
  const present = allRowIds(next)
  const added: string[] = []
  const pendingRows: string[] = []

  for (const entry of topLevelEntries(webText)) {
    if (entry.id === null) {
      // insert 块：按行合并
      for (const row of insertRows(entry.text)) {
        if (row.id === null || present.has(row.id)) continue
        present.add(row.id)
        pendingRows.push(row.text)
        added.push(row.id)
      }
      continue
    }
    if (present.has(entry.id)) continue
    present.add(entry.id)
    next = `${next.replace(/\s+$/, '')}\n${entry.text}\n`
    added.push(entry.id)
  }

  if (pendingRows.length > 0) {
    // 缺的插入行统一并到一个新的 insert 块里
    next = `${next.replace(/\s+$/, '')}\n- insert:\n${pendingRows.join('\n')}\n`
  }

  if (added.length > 0) {
    // 留一份 .bak，和 patch.ts 的写入策略保持一致
    try {
      if (before !== '') writeFileSync(`${desktopPath}.bak`, before, 'utf8')
    } catch {
      // 备份失败不阻断
    }
    writeFileSync(desktopPath, next, 'utf8')
    onProgress({ text: `已同步补丁条目：${added.join('、')}` })
  }
  return added
}

/** 挑一个已解压、且带完整运行时的桌面端版本；优先用调用方指定的那个。 */
function pickDesktop(version?: string): { version: string; rt: DesktopRuntime } | null {
  const all = installedDesktopVersions().sort().reverse()
  const order = version !== undefined && version !== '' ? [version, ...all.filter((v) => v !== version)] : all
  for (const candidate of order) {
    const rt = desktopRuntime(candidate)
    if (rt !== null) return { version: candidate, rt }
  }
  return null
}

/**
 * 拼出 pnpm 能接受的安装形参（**机械照搬 web 的规格**）。
 *
 * git / file / link / tarball 这类**非 registry 来源必须原样透传** —— 给它加 `名字@` 前缀
 * 会变成"去 npm 装同名的另一个包"（例如 web 里 `dsh-infinite-gen-4` 装的是某个 fork 的具体
 * commit，按版本号去 npm 装会装成官方那份）。
 */
function specFor(name: string, spec: string): string {
  if (/^(github:|git\+|git:|file:|link:|https?:|\.{0,2}\/)/.test(spec)) return spec
  const exact = installedVersion(WEB, name)
  return `${name}@${exact ?? spec}`
}

/**
 * 桌面端内置的 dsh 版本（读它自己 CLI 的 `--version`）。
 *
 * 判"版本声明是否落后"必须用**它**，不能用版本池里的版本 —— 桌面端可能跑的是另一版。
 * 拿不到就返回空串，调用方退化成"不授豁免"（那样 dsh 会按老规矩自己拦）。
 */
async function desktopDshVersion(rt: DesktopRuntime): Promise<string> {
  try {
    const out: string[] = []
    await runDesktopCli(rt, ['--version'], (line) => out.push(line))
    return out.join(' ').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? ''
  } catch {
    return ''
  }
}

/**
 * 执行一次同步。**幂等**：已经在桌面端里的插件会跳过。
 *
 * @param onProgress - 进度回调（界面/终端页）
 * @param version - 目标桌面端版本；不传则用已解压里最新的那个
 */
export async function syncWebToDesktop(
  onProgress: (p: SyncProgress) => void = () => {},
  version?: string
): Promise<SyncResult> {
  const result: SyncResult = { installed: [], present: [], patched: [], exempted: [], failed: [] }

  const picked = pickDesktop(version)
  if (picked === null) return result
  const { rt } = picked

  const web = readDeps(WEB)
  const desktop = readDeps(DESKTOP)

  /*
   * 桌面端真正在用的 dsh 版本 —— 后面判"版本号声明是否落后"必须用它，不能用版本池里那个。
   * 拿不到就退化成"不授豁免"（那 dsh 会自己拦，行为等同于旧版）。
   */
  const runtime = await desktopDshVersion(rt)

  /*
   * ① 插件：web 有、桌面端没有的，**全部搬过去**。
   *
   * 「全部」是刻意的：很多小插件的 `peerDependencies` 只是**懒得更新**（声明落后于 dsh），
   * 不代表它跑不起来。所以要搬就搬全 —— dsh 那边有两道闸（安装期拒绝 + 启动期跳过）
   * 都会因为版本号把这类插件挡掉，我们**先授一条精确版本的兼容豁免**，把闸打开。
   * 真出问题由用户在界面上关掉那一个，比"压根搬不过来"可控得多。
   */
  for (const [name, spec] of Object.entries(web)) {
    if (Object.hasOwn(desktop, name)) {
      result.present.push(name)
      continue
    }

    const target = specFor(name, spec)
    const exact = installedVersion(WEB, name)

    // 声明落后 ⇒ 先开闸，否则 dsh 会在安装期直接拒绝（包根本不落地）
    if (exact !== null && runtime !== '') {
      const manifest = readPluginManifest(join(profileDir(WEB), 'node_modules', name, 'package.json'))
      const mismatched = manifest === null ? {} : peerMismatch(manifest, runtime)
      const peers = Object.keys(mismatched)
      if (peers.length > 0) {
        /*
         * 用 dsh 自己的命令写豁免，而不是我手改 compatibility.json —— 格式与版本号校验
         * 都归它管，我改格式一旦飘了就会静默失效。
         */
        const exempt = await runDesktopCli(
          rt,
          ['plugin', '--profile', DESKTOP, 'allow-version', `${name}@${exact}`, '--dsh-version', runtime, '--accept-risk'],
          () => {}
        )
        if (exempt.code === 0) {
          result.exempted.push(name)
          onProgress({
            text: `${name}@${exact} 的版本声明落后于 dsh ${runtime}（${peers.join('、')}），已开闸放行`
          })
        } else {
          onProgress({ text: `${name} 的兼容豁免没写成功（退出码 ${exempt.code}），下面照样试装` })
        }
      }
    }

    onProgress({ text: `正在把 ${name} 装进桌面端…` })
    const { code, tail } = await runDesktopCli(rt, ['plugin', '--profile', DESKTOP, 'add', target], (line) => {
      if (/error|ERR!/i.test(line)) onProgress({ text: line })
    })
    if (code === 0) {
      result.installed.push(name)
      onProgress({ text: `${name} 已装进桌面端` })
    } else {
      result.failed.push(name)
      onProgress({ text: `装 ${name} 失败（退出码 ${code}）：${tail.slice(-3).join(' / ')}` })
    }
  }

  // ② 补丁层：provider / 默认模型 / MCP 服务器 / 其他条目，机械搬缺的那些
  result.patched = mergePatchEntries(onProgress)

  return result
}
