import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { WINDOW_CHANNELS } from '@shared/constants/channels'
import { APP_ORIGIN } from './protocol'

/**
 * 主窗口的**生命周期归属**。
 *
 * 这里持有"当前主窗口"，而不是让 `main/index.ts` 拿一个变量、再把它传给 IPC 注册 ——
 * 那样每加一处需要窗口的代码，就得再串一次参数。窗口是单例，状态放模块里最直接：
 *   - `createMainWindow()` 建窗并接管 closed 清理
 *   - `showMainWindow()`  唤起（没有就重建）
 *   - `currentWindow()`   给 IPC 层用（最小化/最大化/关闭/选目录）
 *
 * IPC 的**注册**在 `main/ipc/window.ts` —— 那层只调这三个函数，不碰窗口细节。
 */

/** 当前主窗口。托盘常驻的应用只有一个，关掉窗口只是隐藏。 */
let mainWindow: BrowserWindow | null = null

/** 当前主窗口；已销毁或没建过时返回 null。 */
export function currentWindow(): BrowserWindow | null {
  return mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null
}

/** 只允许把 http/https 交给系统浏览器；别的协议（file:/javascript: 之类）一律拒掉。 */
export function isSafeExternal(url: string): boolean {
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
 * `.titlebar-buttons` 接管，所以这里 `frame: false` + 一条 IPC 通道把三个动作送回来。
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

  mainWindow = win
  // 自己关掉（或被销毁）时清掉引用，免得 currentWindow() 拿到一个死窗口
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  return win
}

/** 真正要退出时置位，让上面的 close 拦截放行。 */
let isQuitting = false

export function markQuitting(): void {
  isQuitting = true
}

/**
 * 唤起主窗口：没有（或已销毁）就重建，否则还原 + 聚焦。
 *
 * 托盘菜单、`second-instance`（用户又点了一次图标）、macOS 的 `activate` 都走这里。
 */
export function showMainWindow(): void {
  const win = currentWindow()
  if (win === null) {
    createMainWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
