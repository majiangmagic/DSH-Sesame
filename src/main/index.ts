import { app, BrowserWindow } from 'electron'
import { registerAppScheme, serveAppScheme } from './infrastructure/protocol'
import { registerAllIpc } from './ipc'
import { createMainWindow, markQuitting, showMainWindow } from './infrastructure/window'
import { createTray, destroyTray } from './infrastructure/tray'
import { stopAllSync } from './domain/control/runner'
import { syncAutoStartOnBoot } from './infrastructure/settings'
import { migrateLegacyData } from './infrastructure/paths'

/**
 * 主进程入口 —— **装配点**，不含业务逻辑。
 *
 * 这里只做两件事：
 *   1. 把各层的初始化按正确顺序调一遍（协议 → IPC → 窗口 → 托盘）；
 *   2. 管应用的生命周期（单实例锁、托盘常驻、退出收尾）。
 *
 * 三层各管什么（详见各自 README）：
 *   `ipc/`             怎么被渲染层调用（注册全部通道，只在这一处）
 *   `domain/`          做什么 —— 目录名严格对应界面上的 6 个标签页
 *   `infrastructure/`  靠什么做（文件、进程、网络、Electron 壳）
 */

// 必须在 app ready 之前登记：自定义协议的特权要在协议注册表建立前声明
registerAppScheme()

// 单实例锁放在最前面：托盘常驻的应用如果开两份，用户会看到两个图标、两套窗口状态
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    // 数据目录迁移：旧位置（应用目录里）的 dsh 池与快照搬到新的数据根目录。
    // 只在"新位置还没有、旧位置存在"时搬 —— 见 infrastructure/paths.ts 的说明。
    // 放在最前面：后面的 runner 与快照都按新位置找数据。
    const moved = migrateLegacyData()
    if (moved) console.log('[DSH-Sesame] ' + moved)

    serveAppScheme()
    registerAllIpc()

    // 把已保存的「开机自启」偏好同步一次 —— 用户可能在别处改过系统设置
    syncAutoStartOnBoot()

    createMainWindow()
    createTray(() => showMainWindow())

    app.on('activate', () => {
      // macOS 点 Dock 图标：没有窗口就重建，有就唤起
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      else showMainWindow()
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
