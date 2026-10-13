import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'

let tray: Tray | null = null

/**
 * 常驻托盘：关掉窗口不退出应用，点菜单再叫回来。
 *
 * 目前只有"显示/退出"两项。"在浏览器里打开运行页面"之类的入口以后再加。
 */
export function createTray(onShow: () => void): Tray {
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/tray.ico'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('DSH-Sesame')

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: onShow },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )

  // 左键单击也叫回来，符合 Windows 上的习惯
  tray.on('click', onShow)

  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
