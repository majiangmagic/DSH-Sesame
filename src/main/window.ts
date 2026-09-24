import { join } from 'node:path'
import { BrowserWindow, ipcMain, shell } from 'electron'
import { WINDOW_CHANNELS } from '@shared/ipc'
import { APP_ORIGIN } from './protocol'

/** 只允许把 http/https 交给系统浏览器；别的协议（file:/javascript: 之类）一律拒掉。 */
function isSafeExternal(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 无边框主窗口。
 *
 * 无边框窗口的常规做法：原生标题栏去掉，最小化/最大化/关闭由页面里的
 * `.win-controls` 接管，所以这里 `frame: false` + 一条 IPC 通道把三个动作送回来。
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    // 尺寸对齐原版对照截图（1280×800），这样逐页比对时不会被缩放干扰
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    // 与暗色主题一致：这是渲染层画出第一帧之前的底色。
    // 原来用的是移植源那套浅色（#eef3fd），暗色主题下会在启动/重载时闪一下白。
    backgroundColor: '#060a13',
    // 图标由 scripts/make-icons.mjs 从摸头伴侣的立绘生成（多尺寸 ICO）
    icon: join(__dirname, '../../resources/icon-multi.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 首帧渲染完再显示，避免无边框窗口先闪一块白底
  win.once('ready-to-show', () => win.show())

  /**
   * 外链一律交给系统浏览器，**不要在应用里开新窗口**。
   *
   * 控制页那个「运行中 · http://127.0.0.1:…」是 `<a target="_blank">`，
   * 点击走的是 `window.open`。Electron 在没有 `setWindowOpenHandler` 时会给它开一个
   * **新的 Electron 窗口**（而不是默认浏览器），表现就是"点了没反应 / 要手动复制"。
   * 插件页的「市场页 / 仓库」链接同理 —— 所以修在这里，一次覆盖所有外链。
   *
   * 非 http(s) 一律 deny 且不打开（`isSafeExternal`），避免 file: / javascript: 被带进来。
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 兜底：直接把窗口本身导航走的外链（没有 target 的 <a>）也拦下来交给系统浏览器，
  // 否则整个应用窗口会被替换成外部页面，用户就回不来了。
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    if (!isSafeExternal(url)) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  const emitMaximized = (): void => {
    if (!win.isDestroyed()) win.webContents.send(WINDOW_CHANNELS.maximizedChanged, win.isMaximized())
  }
  win.on('maximize', emitMaximized)
  win.on('unmaximize', emitMaximized)

  // 关窗口不等于退出（和原版一致：托盘还在）。拦截后交给上层决定，窗口壳阶段先藏起来。
  win.on('close', (event) => {
    if (!win.isDestroyed() && !isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  // dev 走 Vite 的 http 服务（HMR）；打包后走自定义协议，而不是 file://（原因见 protocol.ts）
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) win.loadURL(rendererUrl)
  else win.loadURL(`${APP_ORIGIN}/index.html`)

  return win
}

/** 真正要退出时置位，让上面的 close 拦截放行。 */
let isQuitting = false

export function markQuitting(): void {
  isQuitting = true
}

/** 窗口控制 IPC。只注册一次。 */
export function registerWindowIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.on(WINDOW_CHANNELS.minimize, () => getWindow()?.minimize())

  ipcMain.on(WINDOW_CHANNELS.toggleMaximize, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on(WINDOW_CHANNELS.close, () => getWindow()?.close())

  ipcMain.handle(WINDOW_CHANNELS.isMaximized, () => getWindow()?.isMaximized() ?? false)

  ipcMain.handle(WINDOW_CHANNELS.openExternal, async (_event, url: unknown) => {
    const target = String(url ?? '')
    if (!isSafeExternal(target)) throw new Error(`拒绝打开非 http(s) 地址：${target}`)
    await shell.openExternal(target)
  })
}
