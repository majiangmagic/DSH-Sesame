import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cmpVer, parseVer } from './registry'
import { dshHome, profileDir } from './dshHome'
import { listInstalled } from './versions'
import { requireNode } from './runtime'

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

function run(args: string[], onLine: (line: string) => void): Promise<{ code: number; tail: string[] }> {
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
        npm_config_update_notifier: 'false',
        npm_config_progress: 'false'
      }
    })
    let buffer = ''
    const consume = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
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

/** 把 pnpm 的输出过滤成给用户看的进度行 */
function progressLine(text: string, onProgress: (progress: PluginProgress) => void): void {
  if (/error|ERR_|added \d+|removed \d+|Packages:|Done in|WARN/i.test(text)) {
    onProgress({ phase: 'install', text })
  }
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

  const outcome = await run([dsh.bin, 'plugin', '--profile', PROFILE, 'add', packageName], (line) =>
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

  const outcome = await run([dsh.bin, 'plugin', '--profile', PROFILE, 'remove', packageName], (line) =>
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

  const outcome = await run(
    [dsh.bin, 'plugin', '--profile', PROFILE, 'add', `${packageName}@${target}`],
    (line) => progressLine(line, onProgress)
  )
  if (outcome.code !== 0) {
    throw new Error(
      `更新 ${packageName} 失败（退出码 ${outcome.code}）：\n${outcome.tail.slice(-10).join('\n')}`
    )
  }
  const after = manifestDeps()[packageName]
  if (after === undefined) {
    throw new Error(`命令成功退出，但 ${packageName} 从 profile 清单里消失了`)
  }
  onProgress({ phase: 'done', text: `${packageName} 已更新到 ${target}` })
}
