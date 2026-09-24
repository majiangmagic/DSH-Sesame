#!/usr/bin/env node
/**
 * 从摸头伴侣的立绘生成应用图标（窗口 / 托盘 / 安装包）。
 *
 * 源    `src/renderer/public/pat/dsniang.png`（610×610，取自 dsh-whale-widget-bowl，MIT）
 * 产物  `resources/icon.ico`、`resources/icon.png`、`resources/tray.ico`
 *
 * **为什么用 Electron 的 nativeImage 而不是装 sharp / png-to-ico：**
 * Electron 自带 nativeImage，能读 PNG、缩放、再导出 PNG —— 依赖本来就在，
 * 不必为一次性生成图标再拉一个原生图像库（那还会引入编译产物与平台差异）。
 *
 * **ICO 的写法**：Vista 起 ICO 允许条目内容是 PNG（不必是 BMP+掩码），
 * 所以这里把缩放后的 PNG 直接塞进 ICO 容器。容器格式很简单：
 *   6 字节文件头 + 每张 16 字节目录项 + 各张 PNG 数据。
 * 托盘图标给多档尺寸（16/24/32/48）—— 托盘显示的是 16px，用一个 256px 缩下去会糊。
 *
 * 用法（必须在 Electron 里跑，不是 node）：
 *   npx electron scripts/make-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, nativeImage } from 'electron'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'renderer', 'public', 'pat', 'dsniang.png')
const OUT = join(ROOT, 'resources')

/**
 * 把若干「尺寸 + PNG 字节」打包成 ICO。
 * @param {Array<{ size: number, png: Buffer }>} entries - 按尺寸从大到小
 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  entries.forEach((entry, index) => {
    const at = index * 16
    // 宽高各 1 字节，256 用 0 表示
    const dim = entry.size >= 256 ? 0 : entry.size
    dir.writeUInt8(dim, at + 0)
    dir.writeUInt8(dim, at + 1)
    dir.writeUInt8(0, at + 2) // 调色板数
    dir.writeUInt8(0, at + 3) // reserved
    dir.writeUInt16LE(1, at + 4) // 色彩平面
    dir.writeUInt16LE(32, at + 6) // 位深
    dir.writeUInt32LE(entry.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((entry) => entry.png)])
}

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(SRC)
  if (source.isEmpty()) {
    console.error(`读不出源图：${SRC}`)
    app.exit(1)
    return
  }
  const size = source.getSize()
  console.log(`源图  ${SRC}  ${size.width}×${size.height}`)

  /** 等比缩放到正方形边长 size，导出 PNG 字节 */
  const at = (target) => source.resize({ width: target, height: target, quality: 'best' }).toPNG()

  mkdirSync(OUT, { recursive: true })

  // 安装包/可执行文件图标：单张 256 足够（Windows 会自行缩小）
  const iconEntries = [{ size: 256, png: at(256) }]
  writeFileSync(join(OUT, 'icon.ico'), buildIco(iconEntries))

  // 窗口图标：多档，任务栏与 Alt-Tab 各取所需
  const windowEntries = [256, 128, 64, 48, 32, 16].map((s) => ({ size: s, png: at(s) }))
  writeFileSync(join(OUT, 'icon-multi.ico'), buildIco(windowEntries))

  // 托盘：显示尺寸很小，必须带 16/24/32
  const trayEntries = [48, 32, 24, 16].map((s) => ({ size: s, png: at(s) }))
  writeFileSync(join(OUT, 'tray.ico'), buildIco(trayEntries))

  // PNG 版留着（某些平台/工具链更认 PNG）
  writeFileSync(join(OUT, 'icon.png'), at(256))

  for (const name of ['icon.ico', 'icon-multi.ico', 'tray.ico', 'icon.png']) {
    const check = nativeImage.createFromPath(join(OUT, name))
    const got = check.isEmpty() ? '读不回' : `${check.getSize().width}×${check.getSize().height}`
    console.log(`产物  resources/${name.padEnd(14)} ${got}`)
  }

  app.exit(0)
})
