/**
 * 把数据目录从**安装目录里**搬到安装目录**隔壁**。
 *
 * 用法：
 *   node scripts/migrate-data.mjs                     # 预演（只打印计划，不动文件）
 *   node scripts/migrate-data.mjs --apply             # 真的搬
 *   node scripts/migrate-data.mjs --from D:\DSH-Sesame --to D:\DSH-Sesame-data
 *
 * ## 为什么非搬不可
 *
 * NSIS 的升级流程（`app-builder-lib/templates/nsis/uninstaller.nsh:164-187`）在 `isUpdated` 时：
 *
 *   1. `atomicRMDir` 把 `$INSTDIR` 里**每一项**逐个改名到 `%TEMP%\old-install`
 *   2. 只要有一个文件**被占用**，就 `Abort`（静默模式下不显示任何东西，安装器直接退出）
 *   3. 最后 `RMDir /r $INSTDIR`
 *
 * 数据放在安装目录里时，第 1 步要搬 1~2 GB（`dsh/` 版本池 + `desktop/` 解压出来的桌面端）；
 * 只要桌面端或某个 dsh 正在跑，文件就被锁着 → 第 2 步 Abort → 启动器已关、什么都没回来。
 * 就算侥幸搬成功，第 3 步也会把版本池与快照一起删掉。
 *
 * 0.1.9 起默认数据根改到 `<安装目录的父目录>\DSH-Sesame-data`，并会在启动时自动迁移；
 * 但**装 0.1.9 的那一次**仍然由旧版本 + 旧布局执行，所以必须先手动搬。
 *
 * ## 搬什么
 *
 *   dsh/        版本池（每个 dsh 版本一套 node_modules）
 *   desktop/    解压出来的官方桌面端（1 GB 量级）
 *   snapshots/  插件配置快照（如果它在安装目录里的话；设置里另指了位置就不在这儿）
 *
 * 同盘用 rename（瞬间完成）；跨盘退回复制再删。**目标已存在就整体跳过**，不覆盖任何东西。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const pick = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} 需要一个值`)
  return v
}

/** 猜一个安装目录：优先「DSH-Sesame.exe 所在目录」的常见位置 */
function guessInstallDir() {
  const candidates = [
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'DSH-Sesame'),
    join(process.env['PROGRAMFILES'] ?? '', 'DSH-Sesame'),
    'D:\\DSH-Sesame'
  ]
  for (const dir of candidates) {
    if (dir !== '' && existsSync(join(dir, 'DSH-Sesame.exe'))) return dir
  }
  return candidates[2]
}

const from = resolve(pick('from', guessInstallDir()))
const to = resolve(pick('to', join(dirname(from), 'DSH-Sesame-data')))

console.log('数据迁移' + (apply ? '（执行）' : '（预演，加 --apply 才真的搬）'))
console.log(`  安装目录 ${from}`)
console.log(`  新数据根 ${to}`)

if (!existsSync(from)) {
  console.error(`\n安装目录不存在：${from}\n用 --from 指定实际位置。`)
  process.exit(2)
}
if (from === to || to.startsWith(from + '\\')) {
  console.error('\n新数据根不能放在安装目录里面 —— 那样升级时照样会被删。')
  process.exit(2)
}

const NAMES = ['dsh', 'desktop', 'snapshots']
const plan = []
for (const name of NAMES) {
  const src = join(from, name)
  const dst = join(to, name)
  if (!existsSync(src)) continue
  const bytes = dirSize(src)
  plan.push({ name, src, dst, bytes, blocked: existsSync(dst) })
}

if (plan.length === 0) {
  console.log('\n安装目录里没有需要搬的数据（dsh / desktop / snapshots 都不存在）。')
  process.exit(0)
}

console.log('\n计划：')
for (const item of plan) {
  const mb = (item.bytes / 1024 / 1024).toFixed(1)
  console.log(
    `  ${item.name.padEnd(10)} ${String(mb).padStart(9)} MB` + (item.blocked ? '   ← 目标已存在，将跳过' : '')
  )
}

if (!apply) {
  console.log('\n预演结束。确认无误后重跑并加 --apply。')
  console.log('⚠️ 执行前请先关掉：启动器、以及它拉起的桌面端（DeepSeek Harness）。')
  process.exit(0)
}

let failed = 0
for (const item of plan) {
  if (item.blocked) {
    console.log(`\n跳过 ${item.name}：${item.dst} 已存在`)
    continue
  }
  try {
    mkdirSync(dirname(item.dst), { recursive: true })
    try {
      renameSync(item.src, item.dst)
      console.log(`\n✓ ${item.name} 已移动（rename）`)
    } catch (error) {
      // 跨盘 / 被占用都会走到这里：复制能成功就继续，否则如实报错
      console.log(`\n  ${item.name} rename 失败（${error.code ?? error.message}），改复制…`)
      cpSync(item.src, item.dst, { recursive: true })
      rmSync(item.src, { recursive: true, force: true })
      console.log(`✓ ${item.name} 已复制并删除原目录`)
    }
  } catch (error) {
    failed += 1
    console.error(`\n✗ ${item.name} 搬迁失败：${error.code ?? error.message}`)
    if (error.code === 'EBUSY' || error.code === 'EPERM') {
      console.error('  有文件正被占用 —— 先把启动器和桌面端（DeepSeek Harness）都关掉再试。')
    }
  }
}

if (failed > 0) {
  console.error(`\n有 ${failed} 项没搬成，数据仍在原处（没有丢失）。处理占用后重跑本脚本。`)
  process.exit(1)
}
console.log('\n完成。现在可以安装新版本了；新版启动时会直接使用' + to)
console.log('（旧版本如果还开着，它仍会去安装目录找数据 —— 装完新版再打开即可。）')

function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        try {
          total += statSync(full).size
        } catch {
          // 读不到就跳过（被占用 / 权限）
        }
      }
    }
  }
  return total
}
