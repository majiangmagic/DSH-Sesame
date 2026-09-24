import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginEntry, PluginList, PluginReason } from '@shared/plugins'

/**
 * Profile 插件开关：读写 dsh 的用户补丁层 `cordis.patch.yml`。
 *
 * 机制与 dshmarket 的 `lib/patch.js` 相同 —— 用 `- id: <行> / disabled: true` 停掉一条 loader 行，
 * 删掉该块即恢复；dsh 每次启动都会应用这层补丁，运行中还会热加载。因为只动文件、不需要 dsh 在跑，
 * **dsh 起不来时这里是唯一还能用的开关**。
 *
 * 写入策略与安全线（对齐市场实现，别把坏状态写得更坏）：
 *  - 行 id 只允许 `[A-Za-z0-9_.-]`；补丁文件不是合法条目数组时拒绝追加；
 *  - 删掉最后一行后恢复模板的 `[]` 占位，否则整个 profile 起不来；
 *  - 官方包与市场自管行不提供开关。
 *
 * ⚠️ 这一层会**直接影响 dsh 的插件加载**：用户 profile 的 `dsh.profile.patchReload: "live"` 时，
 * dsh 运行中就会热加载补丁。所以每次写入前都会先留一份 `.bak`。
 */

const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/
/** 官方组件：关掉任何一条都可能让 dsh 起不来。 */
const PROTECTED_PACKAGE_RE = /^@deepseek-ai\//
/** 市场自己的运行时命名空间，永久补丁行会变成孤儿。 */
const MARKET_ROW_RE = /^(?:mkt-|client-|include:)/

/**
 * 行尾容许注释 —— 这是**对原版的有意修正**。
 *
 * 原版这几条行级正则都以 `\s*$` 结尾，于是 `    - id: pet   # 插件行 id（唯一）` 这种带行尾注释的
 * 行匹配不上。实测（`docs/migration-map.md` 第十节有原始数据）：**dsh-pet 的补丁行 id 后面就带中文
 * 注释，被整条漏掉，插件因此被误报成「没有可开关的加载行」而无法开关。**
 *
 * dsh 自己用 YAML 解析，当然认这种行 —— 所以这是解析器的缺陷，不是插件的性质。
 * id 的字符集是 `[A-Za-z0-9_.-]`，不含 `#`，所以"行尾 `#` 之后是注释"没有歧义。
 *
 * 同类正则共 5 处，统一带这个后缀：两处 `- id:`、两处 `disabled:`、一处 `- insert:`。
 */
const TAIL = '\\s*(?:#.*)?$'

/** 不可开关的原因码。文案交给前端 locale —— 后端不该知道界面语言。 */
export type { PluginEntry, PluginList, PluginReason }

export function patchPathOf(dir: string): string {
  return join(dir, 'cordis.patch.yml')
}

/**
 * 读用户补丁层里已有的禁用/强制启用行（行扫描，不解析 YAML）。
 *
 * 为什么要整行扫而不是解析 YAML：一条 patch 行是 YAML 映射，**键顺序不固定** ——
 * dsh 自己就会把 `disabled` 加到已有行的其它键后面（dsh-plugin-manager 用 setIn 写在原行上）。
 */
export function readPatchState(patchPath: string): { disables: string[]; forced: string[]; text: string } {
  let text = ''
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    // 没有补丁文件 = 空状态
  }
  const disables: string[] = []
  const forced: string[] = []
  const lines = text.split(/\r?\n/)
  const idLine = new RegExp(`^- id:\\s*['"]?([A-Za-z0-9_.-]+)['"]?${TAIL}`)
  const flagLine = new RegExp(`^ {2}disabled:\\s*(true|false)${TAIL}`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = idLine.exec(lines[index] ?? '')
    if (!match) continue
    // 只认正好两个缩进的键 —— 再深一级是 config 里的同名字段，不是这一行的开关
    for (let cursor = index + 1; cursor < lines.length && !/^- /.test(lines[cursor] ?? ''); cursor += 1) {
      const flag = flagLine.exec(lines[cursor] ?? '')
      if (!flag) continue
      if (flag[1] === 'true') disables.push(match[1] as string)
      else forced.push(match[1] as string)
      break
    }
  }
  return { disables, forced, text }
}

/** 插件补丁 `- insert:` 块里插入的 loader 行 id（4 空格缩进，避免误吞 config 里的 id）。 */
export function insertedIds(text: string): string[] {
  const ids: string[] = []
  const insertLine = new RegExp(`^- insert:${TAIL}`)
  const idLine = new RegExp(`^ {4}- id:\\s*['"]?([A-Za-z0-9_.-]+)['"]?${TAIL}`)
  let inInsert = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^- /.test(line)) inInsert = insertLine.test(line)
    if (!inInsert) continue
    const match = idLine.exec(line)
    if (match) ids.push(match[1] as string)
  }
  return ids
}

/** 一个已装插件包拥有的 loader 行：声明的 `dsh.bundle.patch` + 包根目录的 `cordis.patch.yml`。 */
export function packageRowIds(dir: string, packageName: string): string[] {
  const pkgDir = join(dir, 'node_modules', packageName)
  const ids = new Set<string>()
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    const declared = manifest?.dsh?.bundle?.patch
    if (typeof declared === 'string' && declared.trim() !== '') {
      const file = join(pkgDir, declared)
      if (existsSync(file)) for (const id of insertedIds(readFileSync(file, 'utf8'))) ids.add(id)
    }
  } catch {
    // 包不在或清单损坏：loader 侧可能还是知道，交给调用方
  }
  try {
    for (const id of insertedIds(readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8'))) ids.add(id)
  } catch {
    // 没有传统位置的补丁
  }
  return [...ids]
}

function packageVersion(dir: string, name: string): string {
  try {
    const raw = readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')
    return String((JSON.parse(raw) as { version?: string }).version ?? '')
  } catch {
    return ''
  }
}

/**
 * 已装插件清单 + 当前开关状态（**无需 dsh 在跑**）。
 *
 * 判定顺序是 `no-rows` → `official` → `market-owned`，顺序不能换：
 * 官方包若没有可开关的加载行，应该报"没有可开关的加载行"而不是"官方组件" ——
 * 前者才是它当下不可开关的真实原因。
 */
export function listPlugins(dir: string, profile = 'web'): PluginList {
  const patchPath = patchPathOf(dir)
  const state = readPatchState(patchPath)
  let manifest: { dependencies?: Record<string, string> } = {}
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    // 空 profile：返回空清单
  }
  const deps = Object.keys(manifest?.dependencies ?? {}).sort()
  const plugins = deps.map((name): PluginEntry => {
    const ids = packageRowIds(dir, name)
    const official = PROTECTED_PACKAGE_RE.test(name)
    const marketOwned = ids.length > 0 && ids.every((id) => MARKET_ROW_RE.test(id))
    const disabled = ids.some((id) => state.disables.includes(id))

    let toggleable = true
    let reason: PluginReason = ''
    if (ids.length === 0) {
      toggleable = false
      reason = 'no-rows'
    } else if (official) {
      toggleable = false
      reason = 'official'
    } else if (marketOwned) {
      toggleable = false
      reason = 'market-owned'
    }
    return { name, version: packageVersion(dir, name), ids, enabled: !disabled, toggleable, reason, official }
  })
  return { profile, profileDir: dir, patchPath, plugins, disables: state.disables }
}

/* ---------------- 写入 ---------------- */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function block(rowId: string): string {
  return `- id: ${rowId}\n  disabled: true\n`
}

/** 补丁文件是否还是合法的顶层条目数组（行级启发式，宁可拒绝也不写坏）。 */
function looksLikeEntryList(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  if (lines.length === 0) return true
  if (lines.length === 1 && /^\[\s*\]$/.test((lines[0] as string).trim())) return true
  if (lines.some((line) => /^\S/.test(line) && !line.startsWith('- '))) return false
  if (lines.some((line) => /^\[\s*\]$|^\{\s*\}$/.test(line.trim()))) return false
  return true
}

/** 追加一行禁用（纯文本变换，便于一次写多行）。 */
function appendDisableBlock(text: string, rowId: string): { ok: true; text: string } | { ok: false; reason: string } {
  const core = String(text ?? '').trim()
  if (core === '') return { ok: true, text: block(rowId) }
  const withoutComments = core.replace(/^[ \t]*#.*$/gmu, '').trim()
  if (withoutComments === '') {
    const head = text.endsWith('\n') ? text : `${text}\n`
    return { ok: true, text: `${head}${block(rowId)}` }
  }
  if (withoutComments === '[]' || withoutComments === '[ ]') {
    const commented = text.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n')
    const head = commented.endsWith('\n') ? commented : `${commented}\n`
    return { ok: true, text: `${head}${block(rowId)}` }
  }
  const lastContent =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .pop() ?? ''
  if (/^[[{]/.test(lastContent)) {
    return {
      ok: false,
      reason: '补丁层以顶层流式结构结尾，拒绝自动追加；请先把 cordis.patch.yml 整理成条目列表'
    }
  }
  if (!looksLikeEntryList(text)) {
    return { ok: false, reason: '补丁层不是合法的条目数组，已拒绝写入以免破坏；请先修正 cordis.patch.yml' }
  }
  const head = text.endsWith('\n') ? text : `${text}\n`
  return { ok: true, text: `${head}${block(rowId)}` }
}

/**
 * 删掉某一行里的 `disabled: true`（键在行里的位置不限）。
 * 同一行的其它覆盖键（name/config/…）留着；整行只剩它就整行删掉。
 */
function removeDisableBlock(text: string, rowId: string): string {
  const idRe = new RegExp(`^- id:\\s*['"]?${escapeRegExp(rowId)}['"]?${TAIL}`)
  const flagRe = new RegExp(`^ {2}disabled:\\s*true${TAIL}`)
  const lines = String(text ?? '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!idRe.test(lines[index] as string)) continue
    let end = index + 1
    while (end < lines.length && !/^- /.test(lines[end] as string)) end += 1
    const row = lines.slice(index, end)
    const at = row.findIndex((line, pos) => pos > 0 && flagRe.test(line))
    if (at < 0) return text
    const kept = row.filter((_, pos) => pos !== at)
    const stillHasKeys = kept.slice(1).some((line) => line.trim() !== '')
    lines.splice(index, end - index, ...(stillHasKeys ? kept : []))
    return lines.join('\n')
  }
  return text
}

/** 补丁层空了就把模板的 `[]` 占位恢复回来（否则 dsh 拒绝启动整个 profile）。 */
function ensurePlaceholder(text: string): string {
  if (text.replace(/^[ \t]*#.*$/gmu, '').trim() !== '') return text
  const revived = text.replace(/^[ \t]*#[ \t]*\[[ \t]*\][ \t]*(?:\r?\n|$)/mu, '[]\n')
  if (revived !== text) return revived
  return text === '' || text.endsWith('\n') ? `${text}[]\n` : `${text}\n[]\n`
}

/** 写前留一份 `.bak`。备份失败不阻塞开关本身 —— 开关能用比备份更重要。 */
function backupOnce(patchPath: string): void {
  try {
    if (existsSync(patchPath)) copyFileSync(patchPath, `${patchPath}.bak`)
  } catch {
    // 忽略
  }
}

/**
 * 按包名整包开关。
 *
 * @returns 实际被改写的行 id 与是否发生变化
 * @throws 官方包 / 无可开关行 / 全是市场自管行 / 补丁层结构不合法时
 */
export function setPluginEnabled(dir: string, packageName: string, enabled: boolean): { changed: boolean; ids: string[] } {
  if (PROTECTED_PACKAGE_RE.test(packageName)) throw new Error('官方组件不提供开关')
  const ids = packageRowIds(dir, packageName)
  if (ids.length === 0) throw new Error(`${packageName} 没有可开关的加载行`)
  const targets = ids.filter((id) => !MARKET_ROW_RE.test(id))
  if (targets.length === 0) throw new Error(`${packageName} 的加载行由市场自管，不提供开关`)

  const patchPath = patchPathOf(dir)
  const initial = readPatchState(patchPath)
  const disabledSet = new Set(initial.disables)
  let text = initial.text
  let changed = false

  for (const id of targets) {
    if (!ROW_ID_RE.test(id)) throw new Error(`行 id ${id} 含特殊字符，不能写入补丁层`)
    if (enabled) {
      const next = removeDisableBlock(text, id)
      if (next !== text) {
        text = next
        disabledSet.delete(id)
        changed = true
      }
    } else {
      if (disabledSet.has(id)) continue
      const result = appendDisableBlock(text, id)
      if (!result.ok) throw new Error(result.reason)
      text = result.text
      disabledSet.add(id)
      changed = true
    }
  }

  if (changed) {
    backupOnce(patchPath)
    writeFileSync(patchPath, ensurePlaceholder(text))
  }
  return { changed, ids: targets }
}
