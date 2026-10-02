/**
 * 把当前这个 node.exe 复制到 node-bundle/node/，供 electron-builder 的 extraFiles 打进包。
 *
 * 落点是 <安装目录>/node/node.exe —— 正是 src/main/runtime.ts 的第三条解析路径
 * （`join(root, 'node', 'node.exe')`，kind: 'bundled'）。放进去就自动生效，不用改运行时代码。
 *
 * 为什么复制"当前运行的这个 node"而不是去找系统的：
 *   ① 它一定是个真正的 node.exe（Microsoft Store 版是转发壳，不能用来跑 dsh）
 *   ② 版本不用猜，就是这个
 *
 * 产物目录 node-bundle/ 在 .gitignore 里 —— 88 MB 的二进制不该进 git 历史。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const src = process.execPath
const destDir = join(ROOT, 'node-bundle', 'node')
const dest = join(destDir, isWin ? 'node.exe' : 'node')

if (!existsSync(src)) {
  console.error(`找不到当前运行的 node：${src}`)
  process.exit(1)
}

// 确认它真的是个 node（而不是某个转发壳）
let version = ''
try {
  version = execFileSync(src, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()
} catch (e) {
  console.error(`当前这个可执行文件不是可用的 node：${src}`)
  console.error(String(e))
  process.exit(1)
}
if (!/^v\d+\./.test(version)) {
  console.error(`版本输出不像 node：${JSON.stringify(version)}`)
  process.exit(1)
}

// Electron 的 V8 指纹不被 dsh 接受，所以这里必须是真 node —— 顺带挡一下自己
if (src.toLowerCase().includes('electron')) {
  console.error('当前运行在 Electron 里，不能拿它当 node 用（dsh 会拒绝它的 V8 指纹）。')
  process.exit(1)
}

mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)
const size = statSync(dest).size / 1024 / 1024
console.log(`  已内置 Node ${version}`)
console.log(`  来源  ${src}`)
console.log(`  落点  ${dest}`)
console.log(`  大小  ${size.toFixed(1)} MB`)

/*
 * 顺带把 7za.exe 放进同一个目录（运行时的 <应用目录>/node/7za.exe）。
 *
 * 为什么需要它：官方桌面端只发 **NSIS 安装包**，而那个安装器是**全局单实例**的 ——
 * 装第二个版本会先「卸载旧版本文件」，多版本无法并存，重复启动还会去重装（实测报
 * "Failed to uninstall old application files"）。所以启动器改成用 7za 把 NSIS 包
 * **解压成绿色版**（7za 能识别内嵌的 7z），于是每个版本一个独立目录、天然可复用。
 *
 * 7za 必须随包带：不能指望用户机器上装了 7-Zip。
 */
const sevenZip = findSevenZip()
if (sevenZip !== null) {
  const dest7za = join(destDir, isWin ? '7za.exe' : '7za')
  copyFileSync(sevenZip, dest7za)
  console.log(`  已内置 7za  ${(statSync(dest7za).size / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  来源  ${sevenZip}`)
} else {
  console.warn('  警告：没找到 7za.exe —— 用户机器上「解压桌面端」会失败。')
}

/*
 * 顺带把 pnpm 放进包（<应用目录>/node/pnpm + <应用目录>/node/bin/pnpm.cmd）。
 *
 * 为什么必须带：dsh 的插件管理器**调用 PATH 上的 `pnpm`**（它自己不带）。启动器既然已经
 * 自带 node 了，就不能再指望用户机器上装了 pnpm —— 实测有台新机器因此报
 * `'pnpm' 不是内部或外部命令`，插件完全装不了。
 *
 * 官方桌面端就是这么干的：它的 resources/runtime 里 node 与 pnpm 一起带
 * （versions.json: node 24.18.1 / pnpm 11.7.0），所以桌面端那条路从来不缺 pnpm。
 *
 * 来源优先 corepack 缓存 —— node 自带的 corepack 把 pnpm 真身下在这里：
 *   %LOCALAPPDATA%\node\corepack\v1\pnpm\<版本>\
 * 优先 11.7.0（与官方桌面端一致），没有就取版本最高的那个。
 */
const PREFERRED_PNPM = '11.7.0'

const pnpm = findPnpm()
if (pnpm !== null) {
  cpSync(pnpm.dir, join(destDir, 'pnpm'), { recursive: true })
  const binDir = join(destDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  /*
   * 垫片：dsh 调 `pnpm` 时命中它。路径用 %~dp0（脚本自身目录，带尾部反斜杠），
   * 所以整个 node/ 目录可以整体挪位置，不会因为换个安装目录就失效。
   */
  const shim = isWin
    ? '@ECHO OFF\r\n"%~dp0..\\node.exe" "%~dp0..\\pnpm\\bin\\pnpm.cjs" %*\r\n'
    : '#!/bin/sh\nexec "$(dirname "$0")/../node" "$(dirname "$0")/../pnpm/bin/pnpm.cjs" "$@"\n'
  writeFileSync(join(binDir, isWin ? 'pnpm.cmd' : 'pnpm'), shim, 'utf8')
  console.log(`  已内置 pnpm ${pnpm.version}`)
  console.log(`  来源  ${pnpm.dir}`)
  console.log(`  垫片  ${join(binDir, isWin ? 'pnpm.cmd' : 'pnpm')}`)
} else {
  console.warn('  警告：没找到 pnpm —— 用户机器上「安装插件」会失败（dsh 调的是 PATH 上的 pnpm）。')
  console.warn(`        先跑一次 \`corepack prepare pnpm@${PREFERRED_PNPM} --activate\` 或 \`npm i -g pnpm\`，再重新打包。`)
}

/** 找 pnpm 真身（那个含 bin/pnpm.cjs 的目录）。 */
function findPnpm() {
  const found = []
  const consider = (dir) => {
    if (!dir || !existsSync(join(dir, 'bin', 'pnpm.cjs'))) return
    let version = ''
    try {
      version = String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? '')
    } catch {
      // 读不出版本也照样能用，下面排序时排最后
    }
    found.push({ dir, version })
  }

  consider(join(ROOT, 'node_modules', 'pnpm'))

  const corepack = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'node', 'corepack', 'v1', 'pnpm')
    : ''
  if (corepack !== '' && existsSync(corepack)) {
    try {
      for (const entry of readdirSync(corepack)) consider(join(corepack, entry))
    } catch {
      // 读不动就跳过，上面会给警告
    }
  }

  if (found.length === 0) return null
  const preferred = found.find((item) => item.version === PREFERRED_PNPM)
  if (preferred) return preferred
  return found.sort((a, b) => compareVersions(a.version, b.version))[found.length - 1]
}

/** 只用于挑"最高的那个版本"，不追求完整 semver。 */
function compareVersions(a, b) {
  const part = (value) =>
    value
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((piece) => Number.parseInt(piece, 10) || 0)
  const pa = part(a)
  const pb = part(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 找 7za：优先 node_modules/7zip-bin，否则 electron-builder 的缓存目录。 */
function findSevenZip() {
  if (!isWin) return null

  const found = []
  const fromBin = join(ROOT, 'node_modules', '7zip-bin')
  for (const rel of [join('win', 'x64', '7za.exe'), join('win', 'ia32', '7za.exe')]) {
    const candidate = join(fromBin, rel)
    if (existsSync(candidate)) found.push(candidate)
  }

  const cache = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache')
    : ''
  if (cache !== '' && existsSync(cache)) {
    try {
      for (const entry of readdirSync(cache)) {
        if (!entry.startsWith('7zip')) continue
        const base = join(cache, entry)
        for (const inner of readdirSync(base)) {
          const candidate = join(base, inner, 'bin', '7za.exe')
          if (existsSync(candidate)) found.push(candidate)
        }
      }
    } catch {
      // 缓存目录读不动就跳过，下面会给出警告
    }
  }

  return found[0] ?? null
}
