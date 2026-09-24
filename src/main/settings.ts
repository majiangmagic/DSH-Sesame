import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * 启动器**自己**的设置（不是 dsh profile 的配置）。
 *
 * 存放在 `<userData>/settings.json`，刻意**不放 `~/.dsh`** ——
 * `~/.dsh` 是 dsh 的数据目录（profiles、插件、会话），而这几项只关于"启动器怎么启动 dsh"，
 * 混进去会让 `~/.dsh` 的含义变模糊，也会在换启动器时被误读。
 *
 * 只有四项（设置页精简后剩下的），每项都能真的生效：
 *   autoStart  开机自启 —— `app.setLoginItemSettings`（只在打包后生效，见下）
 *   lang       界面语言 —— 渲染层用，主进程只是存
 *   args       额外启动参数 —— 追加到 `dsh <profile> …` 末尾
 *   profile    启动 profile —— 目前只有 `web` 能真正跑起来，见 runner 的守卫
 *   port       启动端口 —— 固定端口，默认 DEFAULT_PORT（原来是 `--port 0` 让系统随便挑）
 *   dshHome    dsh 的数据目录（DSH_HOME）—— 空表示"用环境变量或默认 ~/.dsh"
 */
/**
 * 默认启动端口。
 *
 * 原版用 `--port 0` 让系统挑空闲端口 —— 好处是永远不会"端口被占"，代价是
 * **每次启动地址都不一样**，用户没法把界面存成书签、也没法记住地址。
 * 改成固定端口（可用设置覆盖）。占用时**自动回退**到系统分配的空闲端口，并写一行日志
 * "东一个西一个"正是要避免的那件事。
 */
export const DEFAULT_PORT = 3080

export interface LauncherSettings {
  autoStart: boolean
  lang: 'zh' | 'en'
  args: string
  profile: string
  port: number
  /**
   * dsh 的数据目录（`DSH_HOME`）。空串表示不指定。
   *
   * 优先级：**这里填了就用它** → 否则 `DSH_HOME` 环境变量 → 否则 `~/.dsh`。
   * UI 里明确填的值优先，因为那是最具体的意图。
   */
  dshHome: string
}

const DEFAULTS: LauncherSettings = {
  autoStart: false,
  lang: 'zh',
  args: '',
  profile: 'web',
  port: DEFAULT_PORT,
  dshHome: ''
}

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** 读设置。文件不存在或内容坏了都退回默认值 —— 设置读不出来不该让应用起不来。 */
export function readSettings(): LauncherSettings {
  try {
    const raw = readFileSync(file(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LauncherSettings>
    return {
      autoStart: typeof parsed.autoStart === 'boolean' ? parsed.autoStart : DEFAULTS.autoStart,
      lang: parsed.lang === 'en' ? 'en' : DEFAULTS.lang,
      args: typeof parsed.args === 'string' ? parsed.args : DEFAULTS.args,
      profile: typeof parsed.profile === 'string' && parsed.profile !== '' ? parsed.profile : DEFAULTS.profile,
  // 端口必须是 1~65535 的整数；1024 以下需要管理员权限，一并挡掉给出默认值
  port:
    typeof parsed.port === 'number' &&
    Number.isInteger(parsed.port) &&
    parsed.port >= 1024 &&
    parsed.port <= 65535
      ? parsed.port
      : DEFAULTS.port,
  // 数据目录：允许空（= 用环境变量/默认），非空时去掉首尾空白
  dshHome: typeof parsed.dshHome === 'string' ? parsed.dshHome.trim() : DEFAULTS.dshHome
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/**
 * 把「开机自启」落到系统上。
 *
 * **只在打包后执行**：开发时 `process.execPath` 是 `node_modules/electron/dist/electron.exe`，
 * 拿它去注册开机启动会写进一条指向开发目录的垃圾项。开发时只记偏好、不碰注册表。
 */
function applyAutoStart(enabled: boolean): void {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
  } catch {
    // 注册表写不进去（权限/策略）时不让保存整体失败，偏好已经落盘了
  }
}

/** 合并写入并返回新设置。 */
export function writeSettings(patch: Partial<LauncherSettings>): LauncherSettings {
  const next: LauncherSettings = { ...readSettings(), ...patch }
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // 写不进去就让调用方从返回值看到内存里的结果，但下次读还是旧的 —— 如实返回
  }
  applyAutoStart(next.autoStart)
  return next
}

/**
 * 把「额外启动参数」那一串拆成 argv。
 *
 * 支持双引号包住带空格的参数（用户确实会写 `--patch "C:\my dir\x.yml"`），
 * 不处理转义序列 —— 这是给命令行参数用的轻量拆分，不是 shell 解析器。
 */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const ch of text.trim()) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (current !== '') out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current !== '') out.push(current)
  return out
}

/** 应用启动时把已保存的自启偏好同步一次（用户可能在别处改过） */
export function syncAutoStartOnBoot(): void {
  applyAutoStart(readSettings().autoStart)
}

/** 设置文件的路径（终端页/诊断会用到） */
export function settingsPath(): string {
  return file()
}

/** 文件是否已存在（界面据此判断"还没保存过"） */
export function settingsExist(): boolean {
  return existsSync(file())
}
