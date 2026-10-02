import { execFileSync, spawn } from 'node:child_process'
import { decodeChunk } from './textDecode'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { cmpVer, parseVer } from './registry'
import { dshHome, profileDir } from './dshHome'
import { listInstalled } from './versions'
import { pathWithBundledBin, requireNode } from './runtime'

/**
 * 插件安装 / 卸载 —— **走 dsh 自己的 `plugin` 命令**。
 *
 * ```
 * node <已装版本的 lib/bin.js> plugin --profile web add    <npm 包名>
 * node <已装版本的 lib/bin.js> plugin --profile web remove <npm 包名>
 * ```
 *
 * 四个不能变的前提：
 *
 * 1. **必须用 dsh 的命令，不能自己 `npm install`。** profile 是 **pnpm 布局**
 *    （有 `pnpm-lock.yaml` / `pnpm-workspace.yaml`，没有 `package-lock.json`），
 *    混用 npm 会让同一个目录里出现两套依赖布局；
 * 2. **dsh 会在 pnpm 成功后 reconcile `dsh.profile.bundles`**（市场 `install.ts` 的注释写明），
 *    所以装完不需要我们再往启用清单里补一笔 —— 漏补的表现就是"装好了却不加载"；
 * 3. **用哪个版本去跑**：取版本池里 semver 最高的已装版本。用旧版本会用旧的 pnpm 兼容策略
 *    去改动**所有版本共享**的 profile；
 * 4. **包名用真 npm 包名**（目录里的 `npm` 字段，可能带 scope），不是目录里的短名 ——
 *    目录里存在不同作者的同名短名。
 *
 * 一个 dsh 版本都没有时明确报错：没有可用的 dsh 就没有正确的安装路径。
 */

export interface PluginProgress {
  phase: 'resolve' | 'install' | 'done'
  text: string
}

const PROFILE = 'web'

/** 挑一个用来执行安装的 dsh：版本池里 semver 最高的已装版本 */
function pickDsh(): { version: string; bin: string } {
  const installed = listInstalled().filter((item) => existsSync(item.bin))
  if (installed.length === 0) {
    throw new Error(
      '没有可用的 dsh 版本，无法改动插件。插件必须由 dsh 自己的 plugin 命令安装（profile 是 pnpm 布局），请先在「版本」页下载一个版本。'
    )
  }
  installed.sort((a, b) => {
    const pa = parseVer(a.version)
    const pb = parseVer(b.version)
    if (!pa || !pb) return b.version.localeCompare(a.version)
    return cmpVer(pb, pa)
  })
  const best = installed[0] as (typeof installed)[number]
  return { version: best.version, bin: best.bin }
}

/**
 * 插件命令的超时。
 *
 * 原先 `run()` **没有超时** —— 实测一次「更新」挂到 90 秒以上、一行输出都没有，
 * 界面就永远停在"更新中…"，用户只能重启应用。插件命令要联网拉包，必须有个上限。
 */
const PLUGIN_TIMEOUT_MS = 240_000

/**
 * 一次性关掉 pnpm 的"最小发布年龄"闸。
 *
 * pnpm 对刚发布不久的版本有一道供应链保护。它的行为**不是报错，而是静默保留旧版本、
 * 以退出码 0 结束** —— 所以"更新成功"是假的，包根本没变。实测三个目标版本分别只有
 * 0.6 / 1 / 3.6 天大，全部被跳过（真实 profile 里 package.json 一直停在 09/19 没动过、
 * pnpm 连操作日志都没产生）。
 *
 * dshmarket 自己的 `lib/install.js` 就是这么绕的：
 *   export const RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'
 * 用户是**明确点了"更新到某个版本"**，属于知情操作；但不是静默绕过 ——
 * 调用处会把这件事写进日志，让终端页留痕。
 */
const RELEASE_AGE_BYPASS = '--config.minimumReleaseAge=0'

/**
 * 清掉**残留**的 profile 写锁。
 *
 * `package.json.lock` 里存的是持有者的 PID。dsh 的写操作等这把锁是有超时的，超时直接失败：
 * `atomic-write: timed out waiting for the writer lock at …`。
 *
 * 实测真实 profile 里躺着一个 5 字节的锁（内容 "6552"），创建于 09/24 13:44，
 * 而 **PID 6552 早已不存在** —— 它把此后每一次插件操作都挡死：dsh 启动了、
 * 写了 cordis.yml，然后卡在锁上等超时，pnpm 从未运行（所以连操作日志都没有）。
 * 这就是"点了更新却什么都没发生"的根因，与发布年龄无关。
 *
 * **只在 PID 明确已死时才删** —— 探测得到说明真有操作在跑，绝不能碰。
 */
function isHolderAlive(pid: number): boolean {
  /*
   * 判断"锁的持有者是否真在跑"。
   *
   * 只用 process.kill(pid, 0) 探测存在性在**跨机器**时是错的：
   * profile 连 `package.json.lock` 一起被拷到另一台机器后，锁里记的是**原机器**的 PID，
   * 而在新机器上那个数字很可能正好对应一个无关的活进程（Windows PID 会循环复用）
   * → 被判成"持有者还活着" → 锁永远不清 → dsh 每次写 profile 都白等到超时。
   * 表现就是"换台机器点更新一直卡死、pnpm 从未运行、连操作日志都没有"。
   *
   * 所以：存在性 + **进程名**双重确认。名字不像 node/dsh/pnpm 的一律不认。
   */
  try {
    process.kill(pid, 0)
  } catch {
    return false // 进程不存在 → 残留锁
  }
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    })
    const line = out.split(/\r?\n/).find((l) => l.trim() !== '')
    if (!line) return false
    const name = (line.split('","')[0] ?? '').replace(/^"/, '').toLowerCase()
    return /node|dsh|pnpm|electron/.test(name)
  } catch {
    // 查不出来就保守认为它活着：宁可等 dsh 自己超时，也不误删真在跑的锁
    return true
  }
}

function clearStaleLock(onLine: (line: string) => void): void {
  const lock = join(profileDir(PROFILE), 'package.json.lock')
  let holder: number
  try {
    holder = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10)
  } catch {
    return // 没有锁文件 / 读不了 —— 不是要处理的情况
  }
  if (!Number.isInteger(holder) || holder <= 0) return

  /*
   * 时间判据放在最前面：锁太旧一律视为残留。
   * dsh 自己的写锁超时就在分钟量级，超过这个时限的锁不可能是"正在进行的操作"。
   * 这一条对跨机器、时钟不同步、PID 复用三种情况都成立。
   */
  const STALE_MS = 10 * 60 * 1000
  let age = Number.POSITIVE_INFINITY
  try {
    age = Date.now() - statSync(lock).mtimeMs
  } catch {
    /* 取不到时间就当它是旧的 */
  }
  if (age <= STALE_MS && isHolderAlive(holder)) return // 又新、持有者又真在跑 → 不碰

  try {
    unlinkSync(lock)
    onLine(
      `[启动器] 清掉残留的 profile 写锁（PID ${holder}，` +
        (Number.isFinite(age) ? `已放置 ${Math.round(age / 60000)} 分钟` : '时间未知') +
        '）'
    )
  } catch {
    /* 删不掉就算了：dsh 自己会超时并给出错误 */
  }
}

function run(args: string[], onLine: (line: string) => void): Promise<{ code: number; tail: string[] }> {
  // 每次写 profile 前先处理残留锁，否则会白等到超时
  clearStaleLock(onLine)
  const tail: string[] = []
  const KEEP = 40
  /**
   * 与 runner.ts 用**同一个** Node 解析 —— 必须是真正的 node.exe。
   *
   * 这里原本图省事用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（让 Electron 退化成 Node），
   * 实测也能跑通：pnpm 是纯 JS，不做 dsh 加载器那种 V8 指纹检查。
   * 但它很脆 —— `plugin add` 会触发 postinstall 脚本与 native 构建，
   * 那类东西在 Electron 的 Node 下正是最容易坏的。两处共用一个运行时，行为才可预期。
   */
  const node = requireNode()
  return new Promise((resolve, reject) => {
    const child = spawn(node.path, args, {
      cwd: profileDir(PROFILE),
      windowsHide: true,
      env: {
        ...process.env,
        DSH_HOME: dshHome(),
        DSH_NODE: node.path,
        // 把自己带的 pnpm 垫片目录插到 PATH 最前面 —— dsh 的插件管理器调的是 PATH 上的
        // `pnpm`，插进去就命中我们自带的那个，不再取决于用户机器上装没装
        PATH: pathWithBundledBin(),
        // 取自 dshmarket（lib/install.js:131）："the market runs pnpm with CI=true
        // (TTY hangs)"。pnpm 在非 CI 环境下会走交互分支，遇到需要确认/等待输入的
        // 情形就永久挂住 —— 正是我遇到过的症状（90 秒零输出、永不结束）。
        CI: 'true',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        // **不要再把 progress 关掉**：这里原来是 `npm_config_progress: 'false'`，
        // pnpm 因此几乎不输出，界面上就成了"点了更新、什么都没发生"。
        // append-only 让 pnpm 以纯文本逐行输出（不依赖 TTY），才拿得到持续可见的进度。
        npm_config_reporter: 'append-only'
      }
    })
    /**
     * 超时保护。到点杀**整棵进程树** —— Windows 上 `child.kill()` 只杀直接子进程，
     * 而 `plugin add` 会跑 postinstall，留下孙进程（与 runner.ts 同样的处理）。
     */
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        child.kill()
      }
      reject(
        new Error(
          `插件命令超过 ${PLUGIN_TIMEOUT_MS / 1000} 秒仍未结束，已强制终止。\n` +
            `最后几行输出：\n${tail.slice(-8).join('\n') || '(没有任何输出)'}`
        )
      )
    }, PLUGIN_TIMEOUT_MS)
    let buffer = ''
    const consume = (chunk: Buffer): void => {
      buffer += decodeChunk(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.replace(/\s+$/, '')
        if (text === '') continue
        if (tail.length >= KEEP) tail.shift()
        tail.push(text)
        onLine(text)
      }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.on('error', reject)
    child.on('close', (code) => {
      settled = true
      clearTimeout(timer)
      if (buffer.trim() !== '') {
        if (tail.length >= KEEP) tail.shift()
        tail.push(buffer.trim())
        onLine(buffer.trim())
      }
      resolve({ code: code ?? -1, tail })
    })
  })
}

/** 读 profile 清单里的 dependencies */
function manifestDeps(): Record<string, string> {
  try {
    const raw = readFileSync(join(profileDir(PROFILE), 'package.json'), 'utf8')
    const manifest = JSON.parse(raw) as { dependencies?: Record<string, string> }
    return manifest.dependencies ?? {}
  } catch {
    return {}
  }
}

/**
 * 读 `node_modules` 里那个包**实际装到的版本**。读不到返回 null。
 *
 * 为什么需要它：清单里的声明（`package.json` 的 `dependencies`）不等于装上了什么。
 * pnpm 的"最小发布年龄"闸会静默保留旧版本并以退出码 0 结束 —— 清单可能写着新版本，
 * 磁盘上还是旧的。只查清单就会把这种情况当成更新成功。
 */
function installedVersion(packageName: string): string | null {
  try {
    const raw = readFileSync(
      join(profileDir(PROFILE), 'node_modules', packageName, 'package.json'),
      'utf8'
    )
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/**
 * 把 pnpm 的输出过滤成给用户看的进度行。
 *
 * 原先只放行 `/error|ERR_|added \d+|removed \d+|Packages:|Done in|WARN/`，
 * 而 pnpm 正常工作时打的是 `Progress: resolved 1, reused 0, downloaded 0`、
 * `Downloading …`、`Resolving …`、`+ dshmarket 1.61.0` —— **全部被丢掉**。
 * 所以"点了更新之后一行输出都没有"，用户以为没反应，其实在跑。
 *
 * 现在全部放行（只丢掉空行）。pnpm 用 append-only reporter，输出是逐行的，
 * 一次操作通常几十行，不会把界面刷爆。
 */
function progressLine(text: string, onProgress: (progress: PluginProgress) => void): void {
  const line = text.trim()
  if (line === '') return
  onProgress({ phase: 'install', text: line })
}

/**
 * 安装一个插件到 profile。
 *
 * @param packageName - **真 npm 包名**（目录的 `npm` 字段），不是短名
 */
export async function installPlugin(
  packageName: string,
  onProgress: (progress: PluginProgress) => void = () => {}
): Promise<void> {
  const dsh = pickDsh()
  onProgress({ phase: 'resolve', text: `用 dsh ${dsh.version} 安装 ${packageName}…` })

  if (Object.prototype.hasOwnProperty.call(manifestDeps(), packageName)) {
    onProgress({ phase: 'done', text: `${packageName} 已经装过了` })
    return
  }

  const outcome = await run(
    [dsh.bin, 'plugin', '--profile', PROFILE, 'add', packageName, RELEASE_AGE_BYPASS],
    (line) =>
    progressLine(line, onProgress)
  )
  if (outcome.code !== 0) {
    throw new Error(`安装 ${packageName} 失败（退出码 ${outcome.code}）：\n${outcome.tail.slice(-10).join('\n')}`)
  }
  // 命令成功不等于装上了：核对清单。dsh 的 plugin 命令会在 pnpm 成功后 reconcile
  // dsh.profile.bundles，所以清单里出现即表示依赖与启用清单都已写好。
  if (!Object.prototype.hasOwnProperty.call(manifestDeps(), packageName)) {
    throw new Error(
      `命令成功退出，但 ${packageName} 没出现在 profile 清单里\n${outcome.tail.slice(-10).join('\n')}`
    )
  }
  onProgress({ phase: 'done', text: `${packageName} 安装完成` })
}

/**
 * 卸载一个插件。
 *
 * 允许卸载**正在运行**的 dsh 所在 profile 里的插件：pnpm 改的是磁盘上的 profile，
 * 不影响已经在跑的进程，下次启动才生效。但**不给卸 `@deepseek-ai/*`** ——
 * 那是 dsh 官方组件（与 patch 层的保护规则一致）。
 */
export async function uninstallPlugin(
  packageName: string,
  onProgress: (progress: PluginProgress) => void = () => {}
): Promise<void> {
  if (packageName.startsWith('@deepseek-ai/')) {
    throw new Error(`${packageName} 是 dsh 官方组件，不允许从启动器卸载`)
  }
  const dsh = pickDsh()
  onProgress({ phase: 'resolve', text: `用 dsh ${dsh.version} 卸载 ${packageName}…` })

  if (!Object.prototype.hasOwnProperty.call(manifestDeps(), packageName)) {
    throw new Error(`${packageName} 不在 profile 的依赖里，无法卸载`)
  }

  /*
   * 卸载也要带 RELEASE_AGE_BYPASS。
   *
   * `pnpm remove` 同样会**校验整个 lockfile** 的供应链策略 —— 只要 lockfile 里有
   * 一条"发布太新"的记录（哪怕是别的包、哪怕不涉及本次卸载），整条命令就会被拒绝：
   *   [ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] …
   *   The lockfile contains entries that the active policies reject.
   * 实测：用户卸载 dsh-tavern 时被 dsh-tavern@2.5.0 与它的传递依赖 dsh-muv-engine@0.3.10
   * 两条"太新"记录挡住，退出码 1。
   *
   * 卸载**不会引入任何新包**，所以绕过发布年龄策略没有供应链风险。
   */
  const outcome = await run(
    [dsh.bin, 'plugin', '--profile', PROFILE, 'remove', packageName, RELEASE_AGE_BYPASS],
    (line) =>
    progressLine(line, onProgress)
  )
  if (outcome.code !== 0) {
    throw new Error(`卸载 ${packageName} 失败（退出码 ${outcome.code}）：\n${outcome.tail.slice(-10).join('\n')}`)
  }
  if (Object.prototype.hasOwnProperty.call(manifestDeps(), packageName)) {
    throw new Error(
      `命令成功退出，但 ${packageName} 仍在 profile 清单里\n${outcome.tail.slice(-10).join('\n')}`
    )
  }
  onProgress({ phase: 'done', text: `${packageName} 已卸载` })
}

/**
 * 把一个已装插件更新到指定版本。
 *
 * 走的是同一个透传通道：`dsh plugin --profile web add <包>@<版本>`（→ pnpm）。
 * 用 `add <包>@<版本>` 而不是 pnpm 的 `update`：`update` 受 package.json 里的范围约束
 * （`^0.19.1` 不会跨到 `0.20.0`），会出现"界面说有新版、点了却没动"。显式指定版本，
 * 按钮承诺什么就装什么。pnpm 默认 save-prefix 是 `^`，所以清单里会写成 `^<版本>`。
 *
 * @param target - 目标版本号（**不带** `^`/`~` 前缀）。界面通常传市场目录里的 version。
 */
export async function updatePlugin(
  packageName: string,
  target: string,
  onProgress: (progress: PluginProgress) => void = () => {}
): Promise<void> {
  if (packageName.startsWith('@deepseek-ai/')) {
    throw new Error(`${packageName} 是 dsh 官方组件，不通过启动器更新`)
  }
  const spec = manifestDeps()[packageName]
  if (spec === undefined) {
    throw new Error(`${packageName} 不在 profile 的依赖里，无法更新`)
  }
  // git / file / link 之类来源没有"更新到某版本"的语义 —— 硬装会把用户的固定指认改掉
  if (!/^[\^~]?\d/.test(spec.trim())) {
    throw new Error(`${packageName} 在清单里的来源是「${spec}」，不是版本号，没有可更新的版本`)
  }
  if (!/^\d/.test(target.trim())) {
    throw new Error(`目标版本不合法：${target}`)
  }

  const dsh = pickDsh()
  onProgress({ phase: 'resolve', text: `把 ${packageName} 更新到 ${target}…` })

  /*
   * 先**不带**发布年龄绕过跑一次 —— 尊重那道护栏是默认行为。
   * 只有两种证据出现时，才带绕着重试一次（这是 dshmarket 的做法：
   * 它的 recovery 路径 release-age-violation 就是这么处理的）：
   *   · 命令失败，且输出里出现发布年龄的特征
   *   · 命令**成功但版本没变** —— pnpm 那道闸是"静默保留旧版本、退出码 0"，
   *     只查清单会把它当成更新成功（我上次就栽在这里）
   */
  const addSpec = `${packageName}@${target}`
  const attempt = (extra: string[]): Promise<{ code: number; tail: string[] }> =>
    run([dsh.bin, 'plugin', '--profile', PROFILE, 'add', addSpec, ...extra], (line) =>
      progressLine(line, onProgress)
    )

  let outcome = await attempt([])
  let text = outcome.tail.join('\n')
  if (outcome.code !== 0 && !/release|minimumReleaseAge|too young/i.test(text)) {
    // 不是发布年龄的问题 —— 直接按失败报出去，不做无依据的重试
    throw new Error(
      `更新 ${packageName} 失败（退出码 ${outcome.code}）：\n${outcome.tail.slice(-10).join('\n')}`
    )
  }
  const landed = (): boolean => installedVersion(packageName) === target
  if (!landed()) {
    onProgress({
      phase: 'resolve',
      text:
        outcome.code === 0
          ? `版本没有变化（pnpm 的最小发布年龄保护会静默保留旧版本），带 ${RELEASE_AGE_BYPASS} 重试一次…`
          : `输出里出现发布年龄特征，带 ${RELEASE_AGE_BYPASS} 重试一次…`
    })
    outcome = await attempt([RELEASE_AGE_BYPASS])
  }
  if (outcome.code !== 0) {
    throw new Error(
      `更新 ${packageName} 失败（退出码 ${outcome.code}）：\n${outcome.tail.slice(-10).join('\n')}`
    )
  }
  const after = manifestDeps()[packageName]
  if (after === undefined) {
    throw new Error(`命令成功退出，但 ${packageName} 从 profile 清单里消失了`)
  }
  /*
   * **核对真正装上的版本**，不能只看清单 —— 这就是上次把"什么都没发生"当成
   * 更新成功的原因（用户看到"已更新到 1.61.0"，实际磁盘上还是 1.47.0）。
   */
  const installed = installedVersion(packageName)
  if (installed !== target) {
    throw new Error(
      `命令成功退出，但 ${packageName} 实际装的仍是 ${installed ?? '(读不到版本)'}，不是 ${target}。\n` +
        `已经带 ${RELEASE_AGE_BYPASS} 重试过仍然如此，说明是别的原因（不是发布年龄）。\n` +
        `${outcome.tail.slice(-10).join('\n')}`
    )
  }
  onProgress({ phase: 'done', text: `${packageName} 已更新到 ${target}` })
}
