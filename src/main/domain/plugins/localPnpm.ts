/**
 * **启动器自己**在插件母版里跑 pnpm —— 不经过 `dsh plugin` 命令。
 *
 * ## 为什么要绕开 dsh
 *
 * `dsh plugin --profile <name> add <pkg>` 的背后是 `runProfilePnpm`：它先备份
 * `package.json` / `pnpm-lock.yaml`，装完再跑一遍**插件兼容性检查**
 * （`engines.dsh` / `@deepseek-ai/dsh*` 的 peer 范围），不匹配就整段回滚，
 * 日志里留下 `dsh: installation rejected: …`。
 *
 * 大量插件只是**声明停在旧版本**、实际能跑。用户明确要求：不要用 dsh 的版本检查，
 * 也不要为此去改插件包里的文件（母版里的插件必须是原始文件）。所以这里自己做，
 * 保留 dsh 真正必要的那几步、去掉兼容性拦截。
 *
 * ## 从 dsh 那套里保留了什么
 *
 * 1. **写锁**：操作期间独占 `package.json`，避免两个安装互相覆盖（由调用方的串行队列保证）。
 * 2. **备份 + 回滚**：pnpm 失败时把 `package.json` / `pnpm-lock.yaml` 还原。
 * 3. **启用清单 reconcile**：dsh 在安装成功后会把包加进
 *    `package.json` 的 `dsh.profile.bundles`，少了这一步插件"装了但不加载"。
 *    绕开 dsh 就必须自己补。
 * 4. **git 包的构建脚本白名单**：git 插件靠 `prepare` 构建出 `dist`，
 *    而 pnpm 默认**不执行**依赖的构建脚本。dsh 的提示是把包名加到
 *    `pnpm-workspace.yaml` 的 `allowBuilds`；这里自动做，失败时再重试一次。
 *
 * ## 刻意不做的
 *
 * · 不检查 `engines.dsh` / peer 版本（这正是绕开 dsh 的目的）
 * · 不修改插件包里的任何文件（母版里只允许原始文件）
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStreamDecoder } from '../../platform/textDecode'
import { requireNode, bundledPnpmScript, pathWithBundledBin } from '../../platform/runtime'

export interface PnpmOutcome {
  code: number
  /** 最后若干行输出（失败时给用户看） */
  tail: string[]
}

/** 装的/卸的目标：registry 包名、git 规格、tarball URL 都走这一个入口 */
function pnpmArgs(args: string[]): string[] {
  return [
    ...args,
    // 关掉 pnpm 的"最小发布年龄"闸：它遇到刚发布的版本会**静默保留旧版本、退出码 0**，
    // 表现是"点了更新但版本没变"。绕过没有供应链风险 —— 用户是明确点了某个版本。
    '--config.minimumReleaseAge=0'
  ]
}

/**
 * 在指定目录跑一次 pnpm，逐行回调输出。
 *
 * @throws 这个构建没带 pnpm 时（`bundledPnpmScript` 为 null）
 */
export function runPnpm(
  dir: string,
  args: string[],
  onLine: (line: string) => void
): Promise<PnpmOutcome> {
  const node = requireNode()
  const script = bundledPnpmScript()
  if (script === null) {
    throw new Error(
      '这个构建没有自带 pnpm（<安装目录>/node/pnpm 不存在），无法在本地安装插件。\n' +
        '请用官方发布的安装包，或在系统里装一个 pnpm 后重试。'
    )
  }

  return new Promise((resolve, reject) => {
    const child = spawn(node.path, [script, ...pnpmArgs(args)], {
      cwd: dir,
      windowsHide: true,
      env: {
        ...process.env,
        // 自带垫片追加到 PATH 末尾，让 pnpm 自己派生的子进程也找得到 node/pnpm
        PATH: pathWithBundledBin(),
        // pnpm 在非 CI 环境会走交互分支，遇到需要确认的情形就永久挂住
        CI: 'true',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        // append-only 让 pnpm 逐行输出（不依赖 TTY），否则界面上一片空白
        npm_config_reporter: 'append-only'
      }
    })

    const tail: string[] = []
    const KEEP = 60
    let settled = false
    // 装 git 包可能几十秒；240s 是之前实测过"确实需要"的上限
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        child.kill()
      }
      reject(new Error(`pnpm 超过 240 秒仍未结束，已强制终止。\n${tail.slice(-8).join('\n')}`))
    }, 240_000)

    const decoders = { stdout: createStreamDecoder(), stderr: createStreamDecoder() }
    const buffers = { stdout: '', stderr: '' }
    const consume = (which: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      buffers[which] += decoders[which].decode(chunk)
      const parts = buffers[which].split(/\r?\n/)
      buffers[which] = parts.pop() ?? ''
      for (const raw of parts) {
        const line = raw.replace(/\s+$/, '')
        if (line === '') continue
        if (tail.length >= KEEP) tail.shift()
        tail.push(line)
        onLine(line)
      }
    }
    child.stdout?.on('data', consume('stdout'))
    child.stderr?.on('data', consume('stderr'))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, tail })
    })
  })
}

/** 读 profile 的 `package.json`（读不到返回空对象） */
export function readManifest(dir: string): {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
} {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as ReturnType<typeof readManifest>
  } catch {
    return {}
  }
}

/**
 * 把包加进 `dsh.profile.bundles`（启用清单）。
 *
 * 这一步原本由 dsh 在 pnpm 成功后做（`reconcile`）。绕开 dsh 后必须自己补，
 * 否则插件装进了 `node_modules`、但 dsh 启动时根本不会加载它 —— 表现是
 * "插件页显示已装，界面里却没有任何变化"。
 *
 * 幂等：已经在清单里就什么都不做。
 *
 * @returns 是否真的改了清单
 */
export function addToBundles(dir: string, bundleName: string): boolean {
  const manifest = readManifest(dir)
  const current = manifest.dsh?.profile?.bundles
  if (!Array.isArray(current)) return false
  if (current.includes(bundleName)) return false
  current.push(bundleName)
  try {
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } catch {
    return false
  }
  return true
}

/** 从 `dsh.profile.bundles` 移除（卸载时用）；不在清单里就返回 false */
export function removeFromBundles(dir: string, bundleName: string): boolean {
  const manifest = readManifest(dir)
  const current = manifest.dsh?.profile?.bundles
  if (!Array.isArray(current)) return false
  const next = current.filter((item) => item !== bundleName)
  if (next.length === current.length) return false
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
  try {
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } catch {
    return false
  }
  return true
}

/**
 * 把包名写进 `pnpm-workspace.yaml` 的 `allowBuilds` —— 让 pnpm 允许它执行构建脚本。
 *
 * 为什么需要：git 来源的插件靠 `prepare` 现场构建出 `dist`，而 pnpm 默认**不执行**
 * 依赖的构建脚本（供应链保护）。不放开就只能装到一个没有产物的空壳，dsh 加载时报错。
 *
 * 只动 profile 的配置文件，不碰插件本身。
 *
 * @returns 是否新增了条目
 */
export function allowBuildFor(dir: string, packageName: string): boolean {
  const file = join(dir, 'pnpm-workspace.yaml')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  if (new RegExp(`^\\s*-\\s*['"]?${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(text)) {
    return true // 已经在白名单里
  }

  const lines = text.split(/\r?\n/)
  const idx = lines.findIndex((line) => /^allowBuilds:\s*$/.test(line))
  if (idx === -1) {
    lines.push('allowBuilds:', `  - ${packageName}`)
  } else {
    // 插到 allowBuilds 块的最后一行后面
    let insertAt = idx + 1
    while (insertAt < lines.length && /^\s+-\s/.test(lines[insertAt] ?? '')) insertAt += 1
    lines.splice(insertAt, 0, `  - ${packageName}`)
  }
  try {
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  } catch {
    return false
  }
  return true
}
