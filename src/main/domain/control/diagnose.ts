/**
 * 启动诊断：**限时启动一次 dsh，读它自己打印的失败诊断，找出有问题的插件名**。
 *
 * 为什么这样做（都是实测得来的，不是设计推测）：
 *
 *   1. **dsh 自己就会点名。** 启动失败时它打印：
 *        dsh: startup failed: N required plugins did not activate
 *        Failed plugins (1):
 *          webserver (required)
 *            Package: @deepseek-ai/dsh-host-webserver
 *            Error: listen EADDRINUSE: …
 *        以及 bundle 层被跳过的原因：
 *        dsh: skipping profile bundle "<name>": Error: <原因>
 *      → 我们**只转达**，不自己推断结论。
 *
 *   2. **只取 `Failed plugins` 这一段。** 同一份输出里还有
 *        Plugins waiting for services (9): …
 *      那是**一个根因引发的连锁**（webserver 没起来 → 依赖它的都"在等"），
 *      **不是 9 个插件都有问题**。把它们当成"有问题的插件"会让人去禁用一堆无辜插件。
 *
 *   3. 失败时 **约 2.5 秒**就退出，所以"限时"主要用于兜住**卡住**那种情况。
 *
 *   4. dsh 失败时还会落一份完整日志到 `<DSH_HOME>/logs/startup-<时间戳>-<uuid>.log`；
 *      本模块优先解析它（比 stdout 更全），拿不到时退回 stdout。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DiagnosedProblem, DiagnosisResult } from '@shared/types/control'
import { satisfies } from 'semver'
import { dshHome, profileDir } from '../../infrastructure/dshHome'
import { requireNode } from '../../infrastructure/runtime'
/*
 * 启动原语取自 infra/boot，而**不是** domain/control/runner —— 这一点是有意的：
 * diagnose 只需要"怎么起一个 dsh 进程"，不需要知道 runner 的运行状态机。
 * 从 runner 取会形成 diagnose → runner → sync → diagnose 的环。
 */
import { bootArgs, envFor, killTree, READY_RE } from '../../infrastructure/boot'
import { desktopLogPath, desktopRuntime, runDesktopCli } from './desktop'
import { readSettings } from '../../infrastructure/settings'
import { decodeChunk } from '../../infrastructure/textDecode'
import { versionBin } from '../../infrastructure/paths'

/** 硬上限：不管怎样都判定失败 */
const HARD_CAP_MS = 45_000
/** 静默期：连续这么久没有任何输出 ⇒ 判定"卡住" */
const QUIET_MS = 8_000
/** 原样保留的尾部行数（解析不出来时界面仍有东西可看） */
const RAW_TAIL_LINES = 50

/*
 * 锚点一律**容忍缩进**（^\s*）。
 *
 * 原因（用真实失败日志验过）：失败时优先读的是 dsh 落盘的 startup-*.log，
 * 而那份日志把整个错误对象 dump 出来，块是**带缩进**的：
 *     [缩进 2] Failed plugins (1):
 *     [缩进 4] webserver (required)
 *     [缩进 6] Package: @deepseek-ai/dsh-host-webserver
 * 原来的 ^Failed plugins… 在那份日志里匹配 0 条（实测），
 * 于是 problems 永远为空、界面只能说"没指出具体是哪个插件"。
 */
const RE_FAILED_HEAD = /^\s*Failed plugins \((\d+)\):\s*$/
const RE_ENTRY = /^\s*(\S+) \((required|optional)\)\s*$/
const RE_PKG = /^\s*Package: (.+)$/
const RE_ERR = /^\s*Error: (.+)$/
const RE_SKIP = /^\s*dsh: skipping profile bundle "([^"]+)": Error: (.+)$/
const RE_LOG_PATH = /^\s*Full diagnostics: (.+)$/

/** 解析 dsh 的诊断文本。只认上面那些锚点；认不出来就返回空，由调用方兜底展示原文。 */
export function parseDiagnosis(text: string): {
  problems: DiagnosedProblem[]
  skipped: Array<{ name: string; reason: string }>
  logPath: string | null
} {
  const lines = text.split(/\r?\n/)
  const problems: DiagnosedProblem[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  let logPath: string | null = null
  let inFailed = false
  let current: DiagnosedProblem | null = null

  for (const line of lines) {
    const skip = RE_SKIP.exec(line)
    if (skip) {
      skipped.push({ name: skip[1], reason: skip[2] })
      continue
    }
    const lp = RE_LOG_PATH.exec(line)
    if (lp) {
      logPath = lp[1].trim()
      continue
    }
    if (RE_FAILED_HEAD.test(line)) {
      inFailed = true
      current = null
      continue
    }
    // 离开 Failed 段（出现别的段标题）
    if (/^\s*(Plugins waiting for services|Full diagnostics|dsh: startup)/.test(line)) {
      inFailed = false
      current = null
      continue
    }
    if (!inFailed) continue

    const entry = RE_ENTRY.exec(line)
    if (entry) {
      current = { id: entry[1], required: entry[2] === 'required', pkg: null, error: null }
      problems.push(current)
      continue
    }
    if (current) {
      const pkg = RE_PKG.exec(line)
      if (pkg) { current.pkg = pkg[1].trim(); continue }
      const err = RE_ERR.exec(line)
      if (err && current.error === null) { current.error = err[1].trim(); continue }
      // 堆栈行（`        at …`）忽略：界面只显示插件名与原因首行
    }
  }
  return { problems, skipped, logPath }
}

/** 列出 <DSH_HOME>/logs 下的 startup-*.log（按名字排序，即按时间） */
function listStartupLogs(home: string): string[] {
  const dir = join(home, 'logs')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => f.startsWith('startup-')).sort()
  } catch {
    return []
  }
}

/**
 * 限时启动一次并诊断。**会真的起 dsh**（用完就停），调用方需要让用户知情。
 *
 * @param version 要诊断的 dsh 版本
 * @param port    用哪个端口 —— 传设置里的端口可以复现真实情况
 */
export function diagnose(version: string, port: number): Promise<DiagnosisResult> {
  const bin = versionBin(version)
  if (!existsSync(bin)) return Promise.reject(new Error(`${version} 未安装或缺少入口 ${bin}`))
  const node = requireNode()
  const home = dshHome()
  const profile = readSettings().profile
  const logsBefore = new Set(listStartupLogs(home))
  const started = Date.now()

  return new Promise((resolve, reject) => {
    /*
     * 参数与环境**全部复用 runner.ts** —— 探针的启动条件必须和真实启动一模一样。
     * 之前自己拼了一版，漏了三样：profile 是位置参数（不是 --profile）、
     * 用户的额外启动参数、以及 envFor 里 NODE_OPTIONS 的 --use-system-ca
     * （挂代理时缺它会 TLS 失败 → 探针报的是假故障）。
     */
    const child = spawn(node.path, [bin, ...bootArgs(profile, port)], {
      cwd: home,
      env: { ...envFor(version, node, profile), NO_COLOR: '1', CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    const lines: string[] = []
    let outcome: DiagnosisResult['outcome'] = 'timeout'
    let lastOutput = Date.now()
    let settled = false

    let ready = false
    const onChunk = (buf: Buffer): void => {
      lastOutput = Date.now()
      for (const l of String(buf).split(/\r?\n/)) {
        if (l.trim() === '') continue
        lines.push(l)
        /*
         * 看到就绪地址 ⇒ 立刻判定成功，并主动停掉探针。
         *
         * **绝不能让静默期在这之后生效**：dsh 就绪后本来就不再输出，那不是卡住。
         * 这一条是用户实测发现的 —— 界面报了「启动失败」，其实 dsh 已经起来了，
         * 是我的看门狗 8 秒后把它杀了。
         */
        if (!ready && READY_RE.test(l)) {
          ready = true
          void finish('ready')
        }
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    const finish = async (why: DiagnosisResult['outcome']): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(cap)
      clearInterval(watch)
      outcome = why
      // 还在跑就停掉 —— 探针不该把 dsh 留在那儿
      if (child.exitCode === null && !child.killed) {
        // 杀整棵进程树：dsh 会起 worker 与子进程，只杀父进程会留孤儿
        killTree(child.pid)
      }
      const rawText = lines.join('\n')
      const parsed = parseDiagnosis(rawText)

      // 优先读 dsh 落盘的那份日志（比 stdout 更全）
      let text = rawText
      let logPath = parsed.logPath && existsSync(parsed.logPath) ? parsed.logPath : null
      if (logPath === null) {
        const added = listStartupLogs(home).filter((f) => !logsBefore.has(f))
        if (added.length > 0) logPath = join(home, 'logs', added[added.length - 1])
      }
      if (logPath !== null) {
        try { text = readFileSync(logPath, 'utf8') } catch { /* 用 stdout */ }
      }
      const best = logPath !== null ? parseDiagnosis(text) : parsed
      resolve({
        outcome,
        durationMs: Date.now() - started,
        problems: best.problems,
        skipped: best.skipped.length > 0 ? best.skipped : parsed.skipped,
        logPath,
        rawTail: lines.slice(-RAW_TAIL_LINES)
      })
    }

    const cap = setTimeout(() => { void finish(outcome === 'ready' ? 'ready' : 'timeout') }, HARD_CAP_MS)
    // 静默期：连续无输出 ⇒ 判定卡住
    const watch = setInterval(() => {
      if (!ready && Date.now() - lastOutput > QUIET_MS) void finish('timeout')
    }, 1000)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(cap)
      clearInterval(watch)
      reject(err)
    })
    child.on('close', (code) => { void finish(code === 0 ? 'ready' : 'failed') })
  })
}

/** 读 desktop profile 的 `compatibility.json`（已授予的兼容性豁免）。读不出来就当没有。 */
function readExemptions(dir: string): Record<string, string[]> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'compatibility.json'), 'utf8')) as unknown
    if (raw === null || typeof raw !== 'object') return {}
    const table =
      'exemptions' in (raw as Record<string, unknown>)
        ? (raw as { exemptions: unknown }).exemptions
        : raw
    if (table === null || typeof table !== 'object') return {}
    const out: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (Array.isArray(value)) out[key] = value.filter((item): item is string => typeof item === 'string')
    }
    return out
  } catch {
    return {}
  }
}

/** 插件清单里我们关心的字段 */
export interface PluginManifest {
  name?: string
  version?: string
  peerDependencies?: Record<string, string>
}

/** 读插件清单；读不到返回 null。 */
export function readPluginManifest(manifestPath: string): PluginManifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest
  } catch {
    return null
  }
}

/**
 * 返回**不满足**的 `@deepseek-ai/dsh*` peer（空对象 = 兼容）。
 *
 * 判定逐条照搬 dsh 自己（`evaluatePluginCompatibility`）：
 *  - 只看 `peerDependencies` 里以 `@deepseek-ai/dsh` 开头的项；
 *  - `workspace:^` / `workspace:~` / `workspace:*` 等同于"当前运行时版本"；
 *  - 用真实 `semver.satisfies(..., { includePrerelease: true })` 比。
 *
 * 用真 semver 而不是自己实现：**`0.2.0-rc.2` 不满足 `^0.1.1-rc.2`**（caret 上界是
 * `<0.2.0`，且带预发布的版本还要满足"同一 [major,minor,patch] 上有预发布比较符"的规则）——
 * 这条规则很容易实现错，实现错就会给出和 dsh 相反的结论。
 */
export function peerMismatch(manifest: PluginManifest, runtimeVersion: string): Record<string, string> {
  const mismatched: Record<string, string> = {}
  for (const [peerName, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (peerName !== '@deepseek-ai/dsh' && !peerName.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range)
      ? runtimeVersion
      : range
    if (requirement.trim() === '' || !satisfies(runtimeVersion, requirement, { includePrerelease: true })) {
      mismatched[peerName] = range
    }
  }
  return mismatched
}

/**
 * 算出某个 profile 里**哪些 bundle 会被 dsh 跳过**。
 *
 * 命中 `compatibility.json` 里已授予的豁免就不算跳过。
 */
function peerSkips(dir: string, runtimeVersion: string): Array<{ name: string; reason: string }> {
  let bundles: string[] = []
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
    }
    bundles = manifest.dsh?.profile?.bundles ?? []
  } catch {
    return []
  }

  const exemptions = readExemptions(dir)
  const out: Array<{ name: string; reason: string }> = []

  for (const packageName of bundles) {
    let manifest: { name?: string; version?: string; peerDependencies?: Record<string, string> }
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'node_modules', packageName, 'package.json'), 'utf8')) as typeof manifest
    } catch {
      // 官方 bundle（@deepseek-ai/*）由 dsh 运行时自带，profile 里本来就没有 node_modules 项
      if (packageName.startsWith('@deepseek-ai/')) continue
      out.push({ name: packageName, reason: '读不到这个插件的 package.json（可能没装好），dsh 会跳过它' })
      continue
    }
    const mismatched = peerMismatch(manifest, runtimeVersion)
    if (Object.keys(mismatched).length === 0) continue

    const key = `${manifest.name ?? packageName}@${manifest.version ?? ''}`
    if ((exemptions[key] ?? []).includes(runtimeVersion)) continue

    out.push({
      name: packageName,
      reason: `Plugin ${key} is incompatible with dsh ${runtimeVersion}: peerDependencies ${JSON.stringify(mismatched)}`
    })
  }

  return out
}

/**
 * 桌面端模式的诊断。
 *
 * **不能 spawn dsh** —— 版本池里的 `bin.js` 与桌面端自带的 CLI 都明确拒绝 `--profile desktop`
 * （`managed exclusively by the Electron application`，实测两边都拒）；硬跑只会得到退出码 1
 * 和一句**假的**"启动失败，诊断信息未指明具体插件"。
 *
 * 也**不能靠启动日志**：dsh 确实会在 boot 时 `reportSkippedBundles` 往 stderr 打印跳过原因，
 * 但那是在 Electron **自己 spawn 的 RunAsNode 子进程**里，那行 stderr 被父进程接管了，
 * 到不了我们继承的管道（实测 `<版本目录>/desktop.log` 里一条都没有）。
 *
 * 所以这里**自己算**：拿桌面端自带 CLI 报出的 dsh 版本，按 dsh 的同一条规则逐个 bundle 比
 * `peerDependencies`（见 `peerSkips`）。顺带仍读一眼启动日志，作为"到底起没起"的旁证。
 *
 * **只读**：不 spawn 桌面端、不改任何东西。
 */
export async function diagnoseDesktop(version: string): Promise<DiagnosisResult> {
  const started = Date.now()
  const rt = desktopRuntime(version)

  let logText = ''
  try {
    logText = readFileSync(desktopLogPath(version), 'utf8')
  } catch {
    // 没启动过就没有日志，不影响下面的判定
  }
  const rawTail = logText === '' ? [] : logText.split(/\r?\n/).slice(-RAW_TAIL_LINES)

  if (rt === null) {
    return {
      outcome: 'failed',
      durationMs: Date.now() - started,
      problems: [],
      skipped: [],
      logPath: null,
      rawTail: rawTail.length > 0 ? rawTail : [`${version} 的桌面端还没就绪（找不到它自带的运行时）。先启动一次桌面端。`]
    }
  }

  // 桌面端真正在用的 dsh 版本 —— 兼容性判断必须用它，不能用版本池里那个
  let runtimeVersion = ''
  try {
    const out: string[] = []
    await runDesktopCli(rt, ['--version'], (line) => out.push(line))
    runtimeVersion = out.join(' ').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? ''
  } catch {
    // 下面按"拿不到版本"处理
  }

  if (runtimeVersion === '') {
    return {
      outcome: 'failed',
      durationMs: Date.now() - started,
      problems: [],
      skipped: [],
      logPath: logText === '' ? null : desktopLogPath(version),
      rawTail: ['读不到桌面端内置的 dsh 版本，无法判断插件兼容性。', ...rawTail]
    }
  }

  const skipped = peerSkips(profileDir('desktop'), runtimeVersion)
  return {
    outcome: skipped.length > 0 ? 'failed' : 'ready',
    durationMs: Date.now() - started,
    // 桌面端这条路没有 `Failed plugins` 段；能报的就是"哪些 bundle 会被跳过"
    problems: [],
    skipped,
    logPath: logText === '' ? null : desktopLogPath(version),
    rawTail
  }
}

/**
 * 确保某个 profile 已经**被 dsh 初始化过**（判断依据：`<DSH_HOME>/profiles/<profile>/package.json` 存在）。
 * 不存在就**默认启动一次**，等它打印就绪地址后**自动关掉** —— 那一次启动正是 dsh 建立 profile 的时机。
 *
 * 为什么必须有这一步：插件安装走的是
 *     spawn(node, [bin, 'plugin', '--profile', <p>, 'add', …], { cwd: profiles/<p> })
 * 而那个目录**不存在**时，Node 报的是 `ENOENT`，**并且消息里显示的是命令路径**：
 *     Error: spawn D:\…\node\node.exe ENOENT
 * 看起来像"可执行文件不见了"，于是会一路去查安装包、查文件是否缺失 —— 方向完全错了。
 *
 * 也**不能只 mkdir**：dsh 要的是完整的 profile（package.json / 补丁模板 / 锁文件），
 * 空目录照样装不了。所以这里按"用户手动启动一次"的原样流程来初始化。
 *
 * @param version 用哪个 dsh 版本来初始化（必须是已装好的）
 * @param profile 目标 profile，默认 web
 */
export async function ensureProfileInitialized(version: string, profile = 'web'): Promise<void> {
  if (existsSync(join(profileDir(profile), 'package.json'))) return

  const bin = versionBin(version)
  if (!existsSync(bin)) throw new Error(`初始化 profile 失败：${version} 未安装或缺少入口`)
  const node = requireNode()
  const home = dshHome()
  mkdirSync(home, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const child = spawn(node.path, [bin, ...bootArgs(profile, readSettings().port)], {
      cwd: home,
      env: { ...envFor(version, node, profile), NO_COLOR: '1', CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let settled = false
    let buffer = ''
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 就绪即关：初始化已经完成，不需要让它继续跑（killTree 收的是 PID）
      if (typeof child.pid === 'number') killTree(child.pid)
      if (error) reject(error)
      else resolve()
    }
    const onData = (chunk: Buffer): void => {
      buffer += decodeChunk(chunk)
      if (READY_RE.test(buffer)) finish()
    }
    const timer = setTimeout(
      () => finish(new Error(`初始化 profile「${profile}」超时：${version} 启动了一次但没等到就绪地址`)),
      90_000
    )

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => finish(err))
    child.on('close', (code) =>
      finish(code === 0 ? undefined : new Error(`初始化 profile「${profile}」失败（退出码 ${code}）`))
    )
  })
}
