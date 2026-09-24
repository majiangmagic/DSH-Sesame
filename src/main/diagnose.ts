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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DiagnosedProblem, DiagnosisResult } from '@shared/diagnose'
import { dshHome } from './dshHome'
import { requireNode } from './runtime'
import { readSettings } from './settings'
import { versionBin } from './paths'

/** 硬上限：不管怎样都判定失败 */
const HARD_CAP_MS = 45_000
/** 静默期：连续这么久没有任何输出 ⇒ 判定"卡住" */
const QUIET_MS = 8_000
/** 原样保留的尾部行数（解析不出来时界面仍有东西可看） */
const RAW_TAIL_LINES = 50

const RE_FAILED_HEAD = /^Failed plugins \((\d+)\):/
const RE_ENTRY = /^ {2}(\S+) \((required|optional)\)$/
const RE_PKG = /^ {4}Package: (.+)$/
const RE_ERR = /^ {4}Error: (.+)$/
const RE_SKIP = /^dsh: skipping profile bundle "([^"]+)": Error: (.+)$/
const RE_LOG_PATH = /^Full diagnostics: (.+)$/

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
    if (/^(Plugins waiting for services|Full diagnostics|dsh: startup)/.test(line)) {
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
    const child = spawn(
      node.path,
      [bin, '--profile', profile, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
      {
        cwd: home,
        env: {
          ...process.env,
          DSH_HOME: home,
          DSH_NODE: node.path,
          DSH_BIN: bin,
          NO_COLOR: '1',
          CI: 'true',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )

    const lines: string[] = []
    let outcome: DiagnosisResult['outcome'] = 'timeout'
    let lastOutput = Date.now()
    let settled = false

    const onChunk = (buf: Buffer): void => {
      lastOutput = Date.now()
      for (const l of String(buf).split(/\r?\n/)) if (l.trim() !== '') lines.push(l)
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
        try { child.kill() } catch { /* ignore */ }
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
      if (Date.now() - lastOutput > QUIET_MS) void finish('timeout')
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
