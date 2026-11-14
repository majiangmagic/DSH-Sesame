import { readFileSync, writeFileSync } from 'node:fs'
import { profileDir } from '../../platform/dshHome'
import { patchPathOf } from '../plugins/pluginState'

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
export function allRowIds(text: string): Set<string> {
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
export function patchEntries(lines: string[]): PatchEntry[] {
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
export function alignDisabledFlags(webText: string, desktopText: string): { text: string; changed: string[] } {
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
export function topLevelEntries(text: string): Array<{ id: string | null; text: string }> {
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
export function insertRows(entryText: string): Array<{ id: string | null; text: string }> {
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
export function escapePlaceholder(text: string): string {
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

/** 读补丁文件；读不到返回空串（文件本来就可能不存在） */
function readPatch(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * **只做一件事**：把桌面端补丁层里那个 `[]` 占位符注释掉。返回是否真的改了。
 *
 * 为什么单独抽出来：它在合并流程里只是**中间的一步**，而合并前面还有"装插件"那一大段。
 * 那段只要抛一次异常，整段同步就被 runner 的 catch 吞掉，**修复跟着一起没跑**
 * （实测：用户覆盖安装了新包，但弹窗照旧，因为同步在装插件那步就中断了）。
 *
 * 现在插件同步已改成"从母版克隆"，但补丁层仍是合并而非覆盖，这个占位符修复依然必要 ——
 * 启动端在**拉起桌面端之前会再单独调一次**，单独一层 try/catch，谁都挡不住它。
 */
export function repairDesktopPatch(): { changed: boolean; path: string } {
  const path = patchPathOf(profileDir('desktop'))
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

