import { app, BrowserWindow } from 'electron'
import { registerAppScheme, serveAppScheme } from './protocol'
import { registerBusinessIpc } from './ipc'
import { createMainWindow, markQuitting, registerWindowIpc } from './window'
import { createTray, destroyTray } from './tray'
import { stopAllSync } from './runner'
import { syncAutoStartOnBoot } from './settings'
import { migrateLegacyData } from './paths'

// 必须在 app ready 之前登记：自定义协议的特权要在协议注册表建立前声明
registerAppScheme()

let mainWindow: BrowserWindow | null = null

// 单实例锁放在最前面：托盘常驻的应用如果开两份，用户会看到两个图标、两套窗口状态
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    // 数据目录迁移：旧位置（应用目录里）的 dsh 池与快照搬到新的数据根目录。
    // 只在"新位置还没有、旧位置存在"时搬 —— 见 paths.ts 的说明。
    // 放在最前面：后面的 runner 与快照都按新位置找数据。
    const moved = migrateLegacyData()
    if (moved) console.log('[DSH-Sesame] ' + moved)
    serveAppScheme()
    registerWindowIpc(() => mainWindow)
    registerBusinessIpc()
    // 把已保存的「开机自启」偏好同步一次 —— 用户可能在别处改过系统设置
    syncAutoStartOnBoot()
    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })

    createTray(() => showWindow())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
        mainWindow.on('closed', () => {
          mainWindow = null
        })
      } else {
        showWindow()
      }
    })
  })

  // 托盘常驻：窗口全关也不退出（退出只能走托盘菜单，避免误关）
  app.on('window-all-closed', () => {
    // 保持运行，交给托盘菜单退出
  })

  app.on('before-quit', () => {
    markQuitting()
    // 杀掉还在跑的 dsh，别在用户关掉启动器后留下孤儿进程（会一直占着一个端口）
    stopAllSync()
    destroyTray()
  })
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}
