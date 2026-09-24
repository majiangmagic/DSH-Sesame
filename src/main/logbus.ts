import { BrowserWindow } from 'electron'
import { LOG_CHANNELS } from '@shared/ipc'

/**
 * 终端页的数据源 —— 主进程里的一个环形缓冲。
 *
 * 内容是**真实发生过的事**：dsh 子进程的 stdout/stderr（启动、就绪地址、插件加载报错、
 * 退出码）、以及版本与插件的增删进度。原版管理页就是把 dsh 的输出行追加到一个 `<pre>` 里，
 * 这里做同一件事，只是缓冲放在主进程，这样切换页面不会丢、重开窗口也能补齐。
 *
 * 为什么要有上限：dsh 跑久了会持续输出，无上限的数组会一路吃内存。
 * 超出后丢最旧的（终端本来就只关心最近发生了什么）。
 */
const LIMIT = 3000

const lines: string[] = []

/** 追加一行，并实时推给所有窗口。空行会被丢掉（界面上没意义）。 */
export function pushLog(line: string): void {
  const text = line.replace(/\s+$/, '')
  if (text === '') return

  lines.push(text)
  if (lines.length > LIMIT) lines.splice(0, lines.length - LIMIT)

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(LOG_CHANNELS.line, text)
  }
}

/** 带来源前缀的追加，便于在终端里分辨是 dsh 说的还是启动器说的。 */
export function pushTagged(tag: string, line: string): void {
  pushLog(`[${tag}] ${line}`)
}

/** 当前缓冲的快照（界面首次进入时用）。 */
export function logSnapshot(): string[] {
  return [...lines]
}

/** 清空缓冲。界面上的「清空」调这个 —— 清掉的是缓冲，不影响 dsh 自身的输出。 */
export function clearLog(): void {
  lines.length = 0
}
