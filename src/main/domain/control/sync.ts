import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileDir } from '../../infrastructure/dshHome'
import { desktopRuntime, installedDesktopVersions, runDesktopCli, type DesktopRuntime } from './desktop'
import { peerMismatch, readPluginManifest } from './diagnose'
import { PROTECTED_PACKAGE_RE, patchPathOf } from '../plugins/pluginState'
import { RELEASE_AGE_BYPASS } from '../../infrastructure/dshCli'
import { describeDiff, diffMirror, isNonRegistry, type PluginView } from './pluginMirror'

/**
 * 把 **web profile** 的插件与模型提供商同步到 **桌面端 profile**。
 *
 * 为什么需要它：官方把 Desktop 的 profile 设计成独立的一套（独占 `profiles/desktop`，
 * 与 web 不共享插件/依赖/锁）。代价是同一个插件要装两遍、provider 要配两遍。
 * 这里采用「**web 为唯一基准**」。
 *
 * ## 插件：无条件一比一重建，不做判断
 *
 * 两条历史：
 *
 *  1. **最早是"只补缺"**（web 有、桌面端没有的搬过去）。它有个补不上的方向 ——
 *     **永远删不掉桌面端自己装的插件**。实测 `dsh-store` 只在桌面端存在，
 *     于是每次启动都被一起加载。用户明确要求：桌面端装的插件只是临时用一下，
 *     不该反过来污染基准。
 *
 *  2. **然后加了"看起来一致就跳过"**，靠 `pluginMirror` 判断。那个判断本身是隐患：
 *     它只能看清单与磁盘上的版本号 —— `node_modules` 里坏掉、缺文件、装了一半的包，
 *     在清单上完全看不出来，判断会说"一致"，然后桌面端带着一个坏掉的依赖启动。
 *     而判断一旦有漏，表现就是用户看到的"没同步"。**漏掉一次就等于这个功能不存在。**
 *
 * 所以现在是**每次启动都无条件重建**：
 *
 *     ① 卸掉桌面端的全部插件（跳过 @deepseek-ai/*，那是桌面端自己的组件）
 *     ② 按 web 一比一装回来（含"版本声明落后"的兼容豁免）
 *
 * 代价是每次启动多等一两分钟（十几次 pnpm 往返）。**这是刻意接受的**：
 * 桌面端的插件是"临时用一下"，正确性优先于这点时间。
 *
 * `pluginMirror` 仍然用，但**降级为纯报告** —— 把"这次差在哪"写进终端页便于排查，
 * 不再决定要不要重建。
 *
 * ## 补丁层：只补缺 + 对齐启停，**不重建**
 *
 * 因为桌面端补丁层里有 web 没有的**引导条目**（`ui-chat` / `ui-settings` /
 * `ui-settings-account`）—— 那是桌面端自己首次启动时写下的账号与界面状态，
 * 清掉它等于让用户重新走一遍引导。插件是"临时用一下"，这三条不是。
 *
 * ## 三个关键前提
 *
 *  1. 用**桌面端自带的 CLI**（`desktopRuntime`）去装 / 去卸 / 去豁免 —— 它的 dsh 版本才是
 *     桌面端真正用的那一版；用版本池里的 dsh 去判断，授出来的豁免版本号是错的、等于没授。
 *  2. 桌面端**正在跑**时不能动它的 profile（写锁），所以只在启动前同步。
 *  3. 失败只记录，**不阻断启动**。
 */

export interface SyncProgress {
  text: string
}

export interface SyncResult {
  /** 从桌面端卸掉的插件（web 里没有的，以及为了重装而先卸掉的） */
  removed: string[]
  /** 重新装进桌面端的插件 */
  installed: string[]
  /** 同步过去的补丁条目 / 插入行的 id（provider、默认模型、MCP 服务器…） */
  patched: string[]
  /** 启停状态被对齐的行 id（web 里改了开关，这里把它抻平） */
  aligned: string[]
  /** 因为"版本声明落后"而开了兼容豁免的插件（装了但 dsh 本来会拦） */
  exempted: string[]
  /** 卸或装失败的插件（多半是连豁免都救不了的硬错误） */
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
 * 把一个 profile 读成插件视图，交给 `pluginMirror` 做纯判断。
 *
 * 版本只为自己清单里的包读 —— 差异判定只需要"两边都有"的那些包的版本，
 * 而"只有一边有"的包直接进 missing / extra。
 */
function readPluginView(profile: string): PluginView {
  const specs = readDeps(profile)
  const versions: Record<string, string | null> = {}
  for (const name of Object.keys(specs)) versions[name] = installedVersion(profile, name)
  return { specs, versions }
}

/*
 * 行尾一律允许注释 —— 和 patch.ts 的 TAIL 保持一致。
 *
 * 不这么写会出事：dsh-pet 的补丁行 id 后面就带中文注释，而 `\s*$` 匹配不上 → 「已存在」判不出来
 * → 被当成缺失 → **重复追加**。而顶层 insert 是追加且不去重的，同一个 id 进去两次 = 插件挂载两份。
 * id 的字符集是 [A-Za-z0-9_.-]，不含 `#`，所以"行尾 # 之后是注释"没有歧义。
 */
const ID_LINE = /^(\s*)- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*(?:#.*)?$/
const DISABLED_LINE = /^\s*disabled:\s*(true|false)\s*(?:#.*)?$/
const TL_ID = /^- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*(?:#.*)?$/
const ROW_ID = /^ {4}- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*(?:#.*)?$/

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
    const match = ID_LINE.exec(line)
    if (match) ids.add(match[2] as string)
  }
  return ids
}

/** 一个顶层条目在行数组里的位置与状态。 */
interface PatchEntry {
  id: string | null
  start: number
  /** 独占结尾（不包含） */
  end: number
  disabled: boolean
  /** 整条只有 `- id:` + `disabled:` —— 就是 setPluginEnabled 写下的"禁用标记" */
  disableOnly: boolean
}

/** 按顶层条目切开补丁（每段以列 0 的 `- ` 开头），并记下禁用状态。 */
function patchEntries(lines: string[]): PatchEntry[] {
  const out: PatchEntry[] = []
  let cursor = 0
  while (cursor < lines.length) {
    if (!/^- /.test(lines[cursor] ?? '')) {
      cursor += 1
      continue
    }
    const start = cursor
    const idMatch = TL_ID.exec(lines[start] ?? '')
    cursor += 1
    while (cursor < lines.length && !/^- /.test(lines[cursor] ?? '')) cursor += 1
    const body = lines.slice(start, cursor)
    const keys = body.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    out.push({
      id: idMatch ? (idMatch[1] as string) : null,
      start,
      end: cursor,
      disabled: body.some((line) => DISABLED_LINE.test(line)),
      disableOnly: idMatch !== null && keys.length <= 2
    })
  }
  return out
}

/**
 * 按 web 对齐"插件的启用 / 停用"状态。
 *
 * 为什么必须有这一步：补丁层里
 *   **停用** = 追加一条 `- id: <行id>` + `disabled: true`；
 *   **启用** = 把这条**删掉**。
 * 而"只补缺"的合并只会往里加，天生传不了【启用】—— web 里启用后那条没了，桌面端那条还在。
 * 这里补上反方向。
 *
 * 只动两类，**绝不碰桌面端独有的条目**：
 *   ① 两边都有的顶层条目 → `disabled` 对齐成 web 的样子
 *   ② 桌面端有、web 没有、且整条只有 `id + disabled` 的 → 删掉（web 里启用后留下的过期标记）
 */
function alignDisabledFlags(webText: string, desktopText: string): { text: string; changed: string[] } {
  const webState = new Map<string, boolean>()
  for (const entry of patchEntries(webText.split(/\r?\n/))) {
    if (entry.id !== null) webState.set(entry.id, entry.disabled)
  }

  const lines = desktopText.split(/\r?\n/)
  const changed: string[] = []
  // 从后往前改 —— 前面条目的行号不会因为后面的增删而漂移
  for (const entry of patchEntries(lines).reverse()) {
    if (entry.id === null) continue
    const want = webState.get(entry.id)

    if (want === undefined) {
      if (entry.disableOnly && entry.disabled) {
        lines.splice(entry.start, entry.end - entry.start)
        changed.push(entry.id)
      }
      continue
    }
    if (want === entry.disabled) continue

    if (want) {
      const indent = (/^(\s*)/.exec(lines[entry.start] ?? '')?.[1] ?? '') + '  '
      lines.splice(entry.start + 1, 0, `${indent}disabled: true`)
    } else {
      for (let i = entry.end - 1; i > entry.start; i -= 1) {
        if (DISABLED_LINE.test(lines[i] ?? '')) {
          lines.splice(i, 1)
          break
        }
      }
      // 去掉之后整条只剩 `- id: X` → 和 dsh 的"启用"一样，把整条删掉
      const rest = lines
        .slice(entry.start, entry.end - 1)
        .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
      if (rest.length <= 1) lines.splice(entry.start, entry.end - 1 - entry.start)
    }
    changed.push(entry.id)
  }

  return { text: lines.join('\n'), changed }
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
    const idMatch = TL_ID.exec(lines[start] ?? '')
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
    const idMatch = ROW_ID.exec(lines[start] ?? '')
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

/**
 * 把补丁层里的 `[]` 占位符注释掉（`[]` → `# []`）。
 *
 * 补丁层的初始模板是"注释 + 一个 `[]`"（表示空数组）。但 YAML 里 `[]` 是**完整的流式数组**，
 * 后面再接块式条目就是**非法 YAML**：
 *
 *     # a top-level YAML array of load overrides, disables, and inserts
 *     []
 *     - id: ui-settings-general      ← 解析器在这里报错
 *
 * 实测后果：整个桌面端起不来，弹 "DeepSeek Harness is unavailable"。
 *
 * ⚠️ patch.ts 的 `appendDisableBlock` 早就有这一步处理 —— sync.ts 当时**自己重写了一遍**
 * 追加逻辑却漏掉它，于是只在"补丁还是初始模板"的机器上炸（老机器补丁里已有条目，所以没事）。
 * 这里补上。它同时**能修已经写坏的文件**（只是把那行 `[]` 注释掉）。
 */
function escapePlaceholder(text: string): string {
  /*
   * 两条限制，都是为了"只修该修的、不碰别的环境能用的"：
   *
   * ① **只认列 0 的 `[]`**（不允许缩进）。
   *    模板占位符永远在列 0；而 `config` 里那种**缩进的 `[]` 是合法的嵌套空数组值**：
   *        - id: a
   *          config:
   *            items:
   *              []        ← 这是数据，不是占位符 —— 注释掉就把配置毁了
   *
   * ② **只有文件里存在块式条目时才动**。
   *    `[]` 单独存在是**合法的空补丁**（初始模板就是"注释 + []"）。无脑转义会让文件变成
   *    "只有注释" → YAML 解析成 `null` → 别的 dsh 版本反而可能拒绝。
   *
   * 满足这两条时，`[]` 与块式条目共存 = 非法 YAML（`[]` 是完整的流式数组，
   * 后面不能再接 `- …`）—— 那才是需要修的情况。
   */
  if (!/^\[[ \t]*\][ \t]*(?:#.*)?$/m.test(text)) return text
  const withoutPlaceholder = text.replace(/^\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '')
  if (!/^- /m.test(withoutPlaceholder)) return text
  return text.replace(/^\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n')
}

/**
 * **只做一件事**：把桌面端补丁层里那个 `[]` 占位符注释掉。返回是否真的改了。
 *
 * 为什么单独抽出来、而不是只留在 mergePatchEntries 里：它在那边只是**中间的一步**，
 * 而 mergePatchEntries 前面还有"装插件"那一大段循环 —— 那段只要抛一次异常，
 * 整段同步就被 runner 的 catch 吞掉，**修复跟着一起没跑**（实测：用户覆盖安装了新包，
 * 但弹窗照旧，因为同步在装插件那步就中断了）。
 *
 * 所以启动端在**拉起桌面端之前会再单独调一次这个**，单独一层 try/catch —— 谁都挡不住它。
 */
export function repairDesktopPatch(): { changed: boolean; path: string } {
  const path = patchPathOf(profileDir(DESKTOP))
  const before = readPatch(path)
  if (before === '') return { changed: false, path }
  const next = escapePlaceholder(before)
  if (next === before) return { changed: false, path }
  try {
    writeFileSync(`${path}.bak`, before, 'utf8')
  } catch {
    // 备份失败不阻断
  }
  writeFileSync(path, next, 'utf8')
  return { changed: true, path }
}

function readPatch(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 把 web 补丁层对齐到桌面端。
 *
 * 两步：
 *  ① **补缺** —— web 有、桌面端没有的条目搬过去。覆盖两种形态：
 *      顶层 `- id: X` 条目（provider、agent-default-model、qqbot、ui-settings-general…）
 *      `- insert:` 块里的行 —— **MCP 服务器就是这一种**，按行 id 逐条判断
 *     判重用 `allRowIds(next)`（在整个补丁里出现过即算有），理由见它的注释。
 *  ② **对齐启停状态** —— 见 `alignDisabledFlags`：这一步才能把"重新启用"传过去。
 *
 * 全程**不覆盖、不删除桌面端独有的条目**（它的 ui-chat / ui-settings-account 是引导状态）。
 */
function mergePatchEntries(onProgress: (p: SyncProgress) => void): {
  patched: string[]
  aligned: string[]
} {
  const webText = readPatch(patchPathOf(profileDir(WEB)))
  const desktopPath = patchPathOf(profileDir(DESKTOP))
  const before = readPatch(desktopPath)
  /*
   * 先注释掉 `[]` 占位符再往里加 —— 否则 `[]` 后面接块式条目就是非法 YAML，
   * 桌面端会直接起不来（见 escapePlaceholder 的注释）。老机器补丁里已有条目所以没炸，
   * 补丁还是初始模板的机器一追加就中。
   */
  let next = escapePlaceholder(before)
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

  // ② 对齐启停状态（补上"只补缺"传不了的【启用】方向）
  const aligned = alignDisabledFlags(webText, next)
  next = aligned.text

  if (added.length > 0 || aligned.changed.length > 0 || next !== before) {
    // 留一份 .bak，和 patch.ts 的写入策略保持一致
    try {
      if (before !== '') writeFileSync(`${desktopPath}.bak`, before, 'utf8')
    } catch {
      // 备份失败不阻断
    }
    writeFileSync(desktopPath, next, 'utf8')
    const notes: string[] = []
    if (added.length > 0) notes.push(`新增 ${added.join('、')}`)
    if (aligned.changed.length > 0) notes.push(`启停对齐 ${aligned.changed.join('、')}`)
    onProgress({ text: `已同步补丁层：${notes.join('；')}` })
  }
  return { patched: added, aligned: aligned.changed }
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
  if (isNonRegistry(spec)) return spec
  const exact = installedVersion(WEB, name)
  return `${name}@${exact ?? spec}`
}

/**
 * 从桌面端卸掉一个插件。
 *
 * **先不带发布年龄绕过跑一次**，只有输出里出现发布年龄特征时才带绕着重试 ——
 * 与 `pluginInstall.updatePlugin` 同一套策略：默认尊重那道护栏，只在有证据时才绕。
 *
 * 为什么要绕过：`pnpm remove` 会校验**整个 lockfile** 的供应链策略。只要 lockfile 里
 * 有一条"发布太新"的记录（哪怕是别的包、哪怕不涉及本次卸载），整条命令就会被拒绝
 * （`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。卸载不引入任何新包，所以绕过没有供应链风险。
 *
 * @returns 是否真的卸掉了
 */
async function removeFromDesktop(
  rt: DesktopRuntime,
  name: string,
  onProgress: (p: SyncProgress) => void
): Promise<boolean> {
  const attempt = (extra: string[]): Promise<{ code: number; tail: string[] }> =>
    runDesktopCli(rt, ['plugin', '--profile', DESKTOP, 'remove', name, ...extra], (line) => {
      if (/error|ERR!/i.test(line)) onProgress({ text: line })
    })

  let outcome = await attempt([])
  if (outcome.code === 0) return true

  if (/release|minimumReleaseAge|too young|MINIMUM_RELEASE_AGE/i.test(outcome.tail.join('\n'))) {
    onProgress({ text: `${name} 的卸载被发布年龄策略挡下，带 ${RELEASE_AGE_BYPASS} 重试一次…` })
    outcome = await attempt([RELEASE_AGE_BYPASS])
    if (outcome.code === 0) return true
  }

  onProgress({
    text: `卸载 ${name} 失败（退出码 ${outcome.code}）：${outcome.tail.slice(-3).join(' / ')}`
  })
  return false
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
 * 执行一次同步。
 *
 * 插件部分：**每次启动桌面端都无条件重建** —— 先把桌面端的插件全部卸掉，
 * 再按 web 一比一装回来。不做"看起来一致就跳过"的判断（原因见下面）。
 * 补丁层始终只补缺 + 对齐启停（**不重建** —— 桌面端补丁层里有它自己的引导条目，
 * 见文件头的说明）。
 *
 * ## 为什么不做"一致就跳过"
 *
 * 曾经有过这个短路，靠 `pluginMirror` 判断两边是否一致。去掉了，因为**那个判断本身
 * 就是隐患**：
 *
 *  - **它只能看清单与磁盘上的版本号。** `node_modules` 里坏掉、缺文件、装了一半的包，
 *    在清单和 `package.json` 的 `version` 字段上完全看不出来 —— 判断会说"一致"，
 *    然后桌面端带着一个坏掉的依赖启动。这类问题恰恰是最需要重建的那一类。
 *  - **判断一旦有漏，表现就是用户看到的"没同步"**：桌面端用的还是旧版本、
 *    或者多了一个本该被清掉的插件。而"每次强制重建"没有任何漏的可能。
 *  - 代价是每次启动多等一两分钟（十几次 pnpm 往返）。**这是刻意接受的**：
 *    桌面端的插件是"临时用一下"，正确性优先于这点时间。
 *
 * 所以这里**不判断、只执行**。`pluginMirror` 仍然保留，但降级为**纯报告**用途 ——
 * 把"这次差在哪"写进进度与终端页，方便排查；它不再决定要不要重建。
 *
 * @param onProgress - 进度回调（界面/终端页）
 * @param version - 目标桌面端版本；不传则用已解压里最新的那个
 */
export async function syncWebToDesktop(
  onProgress: (p: SyncProgress) => void = () => {},
  version?: string
): Promise<SyncResult> {
  const result: SyncResult = {
    removed: [],
    installed: [],
    patched: [],
    aligned: [],
    exempted: [],
    failed: []
  }

  const picked = pickDesktop(version)
  if (picked === null) return result
  const { rt } = picked

  const webView = readPluginView(WEB)
  const desktopView = readPluginView(DESKTOP)
  const web = webView.specs
  const desktop = desktopView.specs

  /*
   * 桌面端真正在用的 dsh 版本 —— 后面判"版本号声明是否落后"必须用它，不能用版本池里那个。
   * 拿不到就退化成"不授豁免"（那 dsh 会自己拦，行为等同于旧版）。
   */
  const runtime = await desktopDshVersion(rt)

  /*
   * 把"差在哪"报出来（**仅供排查，不参与决策**）。
   *
   * 一致时也照报 —— 用户需要知道这一两分钟花在哪：是确实有漂移，
   * 还是"每次都要重建"本身的固定开销。
   */
  const diff = diffMirror(webView, desktopView)
  const drift = describeDiff(diff)
  onProgress({
    text:
      drift === ''
        ? `桌面端插件看起来已与 web 一致（${Object.keys(web).length} 个），仍按 web 重建一遍…`
        : `桌面端插件与 web 有差异：${drift}。按 web 重建…`
  })

  /*
   * ① 卸载桌面端的**全部**插件。
   *
   * 名字列表要先快照一份 —— 卸载过程中 package.json 会变，边遍历边读会漏掉条目。
   *
   * 跳过 `@deepseek-ai/*`：那是 dsh 的官方运行时组件，卸掉会把桌面端自己弄坏
   * （与插件开关的保护规则同源，正则从 pluginState 引过来，只此一处定义）。
   */
  for (const name of Object.keys(desktop)) {
    if (PROTECTED_PACKAGE_RE.test(name)) {
      onProgress({ text: `${name} 是 dsh 官方组件，跳过不卸` })
      continue
    }
    onProgress({ text: `正在从桌面端卸掉 ${name}…` })
    if (await removeFromDesktop(rt, name, onProgress)) {
      result.removed.push(name)
      onProgress({ text: `${name} 已从桌面端卸掉` })
    } else {
      result.failed.push(name)
    }
  }

  /*
   * 核对一遍真的卸干净了。**不能只信退出码** —— dsh 的命令在某些情况下会以 0 退出
   * 而依赖仍在清单里（pnpm 的最小发布年龄闸就是"静默保留、退出码 0"那一种）。
   * 残留会让"1:1"这个承诺变成假的，所以在这里如实报出来。
   */
  const leftover = Object.keys(readDeps(DESKTOP)).filter((name) => !PROTECTED_PACKAGE_RE.test(name))
  if (leftover.length > 0) {
    onProgress({ text: `这些插件没卸干净（下面照样按 web 装）：${leftover.join('、')}` })
  }

  /*
   * ② 按 web **一比一装回来**。
   *
   * 「全部」是刻意的：很多小插件的 `peerDependencies` 只是**懒得更新**（声明落后于 dsh），
   * 不代表它跑不起来。所以要装就装全 —— dsh 那边有两道闸（安装期拒绝 + 启动期跳过）
   * 都会因为版本号把这类插件挡掉，我们**先授一条精确版本的兼容豁免**，把闸打开。
   * 真出问题由用户在界面上关掉那一个，比"压根装不上"可控得多。
   */
  for (const [name, spec] of Object.entries(web)) {
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

  // ③ 补丁层：先补缺（provider / 默认模型 / MCP 服务器…），再对齐启停状态
  const patch = mergePatchEntries(onProgress)
  result.patched = patch.patched
  result.aligned = patch.aligned

  return result
}
