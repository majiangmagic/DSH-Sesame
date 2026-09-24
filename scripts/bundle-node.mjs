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
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
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
