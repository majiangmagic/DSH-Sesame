/**
 * 发布：把 electron-builder 的产物提到发布目录的**顶层**。
 *
 * 目录布局（成品目录与本项目**平级**）：
 *   <本项目>\..\DSH-Sesame-release\           ← 成品目录
 *       DSH-Sesame-Setup-0.1.0.exe
 *       DSH-Sesame-Setup-0.1.0.exe.blockmap
 *       latest.yml
 *       _stage\                             ← 打包暂存，发布完成后被删除
 *
 * 为什么 electron-builder 不直接输出到顶层：构建中途失败会在那儿留下看起来正常的
 * 半成品，之后很难分辨哪份是好的。所以让它写进 `_stage`，校验通过才提到顶层 ——
 * 失败的构建只会留下一个明显的临时子目录，顶层安装包不受影响。
 *
 * 用法：
 *   node scripts/publish-release.mjs --dry-run
 *   node scripts/publish-release.mjs
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
// 默认取**项目目录的同级目录**（用脚本自身位置推算，所以与谁在哪台机器上克隆无关）。
/**
 * 从 electron-builder.yml 的 `output:` 反推成品目录与暂存目录名。
 *
 * **让 yml 成为唯一真相**：原来两边各自硬编码 DSH-Sesame-release 这个名字，
 * 恰好一致但靠人写对 —— 改了 yml 这边就会静默找不到目录。
 * 解析不了（文件不在、格式变了）就退回"与本项目平级"的默认值并警告，不因此崩掉。
 */
function resolveFromYml() {
  const fallback = {
    target: join(ROOT, '..', '..', 'DSH-Sesame-release'),
    stage: '_stage'
  }
  try {
    const yml = readFileSync(join(ROOT, '..', 'electron-builder.yml'), 'utf8')
    const m = /^\s*output:\s*(.+?)\s*$/m.exec(yml)
    if (!m) return fallback
    const raw = m[1].replace(/^["']|["']$/g, '')
    // output 是**相对项目目录**的路径；去掉末尾那一级（暂存目录）就是成品目录
    const staged = resolve(join(ROOT, '..'), raw)
    return { target: dirname(staged), stage: basename(staged) }
  } catch {
    console.warn('读不到 electron-builder.yml 的 output，改用默认的成品目录位置。')
    return fallback
  }
}

const fromYml = resolveFromYml()
const TARGET = fromYml.target
const STAGE_NAME = fromYml.stage

/*
 * 安全防护：成品目录不得是**项目目录本身**，也不得是它的**祖先**。
 *
 * 这个脚本收尾时会"清理上一次发布的产物" —— 删掉成品目录顶层除暂存目录外的所有东西。
 * 如果 electron-builder.yml 的 output 写成 `dist`（**那正是 electron-builder 的默认值**，
 * 很容易被顺手写上），成品目录就解析成项目根，那一步会删掉 src/、package.json、
 * scripts/ 乃至 **.git/** —— 项目直接没了。指向祖先则会把本项目整个删掉，后果更重。
 * 宁可在这里中止，也不要靠"没人会那么写"。
 */
const PROJECT_DIR = resolve(ROOT, '..')
const resolvedTarget = resolve(TARGET)
if (resolvedTarget === PROJECT_DIR || PROJECT_DIR.startsWith(resolvedTarget + sep)) {
  console.error(`成品目录解析成了项目目录${resolvedTarget === PROJECT_DIR ? '本身' : '的祖先'}：${resolvedTarget}`)
  console.error('这会让"清理上一次产物"删掉项目里的文件（含 .git）。已中止。')
  console.error('请把 electron-builder.yml 的 output 改成项目之外的目录，')
  console.error('例如：output: ../DSH-Sesame-release/_stage')
  process.exit(1)
}
const SOURCE = join(TARGET, STAGE_NAME)
const dryRun = process.argv.includes('--dry-run')

if (!existsSync(SOURCE)) {
  console.error(`找不到打包暂存目录：${SOURCE}`)
  console.error('先跑 `npm run dist`（electron-builder 的输出目录见 electron-builder.yml）。')
  process.exit(1)
}

/** 顶层要跳过的中间文件 */
const SKIP_TOP_LEVEL_FILES = new Set(['builder-debug.yml'])

/** 递归列出所有文件（相对路径、正斜杠归一）；顶层目录一律跳过（全是中间产物）。 */
async function walk(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const topLevel = base === dir
    if (topLevel && entry.isDirectory()) continue
    if (topLevel && SKIP_TOP_LEVEL_FILES.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path, base)))
    else out.push(relative(base, path).split(sep).join('/'))
  }
  return out
}

const files = await walk(SOURCE)
/** 真正要分发的是暂存根目录下的安装包；嵌套的 exe（app 主程序、elevate 之类）不按大小判。 */
const installers = files.filter((file) => !file.includes('/') && /\.(exe|msi)$/i.test(file))

if (installers.length === 0) {
  console.error(`${SOURCE} 根目录下没有 .exe / .msi 安装包，构建可能没走完。`)
  process.exit(1)
}

const entries = []
for (const file of files) {
  const info = await stat(join(SOURCE, file))
  // 校验安装包非空：electron-builder 失败时会留下 0 字节的壳
  if (installers.includes(file) && info.size < 1024 * 1024) {
    console.error(`安装包 ${file} 只有 ${info.size} 字节，明显不完整，已中止。`)
    process.exit(1)
  }
  entries.push({ file, size: info.size })
}

const pkg = JSON.parse(await readFile(join(ROOT, '..', 'package.json'), 'utf8'))
const totalBytes = entries.reduce((sum, item) => sum + item.size, 0)

console.log(`暂存  ${SOURCE}`)
console.log(`发布  ${TARGET}`)
console.log(`版本  ${pkg.version}`)
console.log(`文件  ${entries.length} 个，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
console.log(`安装包 ${installers.join('、')}`)
console.log(dryRun ? '模式  DRY RUN（不写盘）\n' : '模式  实际发布\n')

if (dryRun) {
  for (const item of entries.slice(0, 20)) console.log(`  将提取 ${item.file}`)
  if (entries.length > 20) console.log(`  …另有 ${entries.length - 20} 个文件`)
  console.log(`\nDRY RUN 结束。实际发布会把上述文件提到 ${TARGET} 顶层，然后删除 ${STAGE_NAME}/。`)
  process.exit(0)
}

/**
 * 提出到顶层。只删顶层**上一次发布的文件**，不整体清空目标目录 ——
 * 因为暂存目录本身就在目标目录里面，整体清空会把自己也删掉。
 */
await mkdir(TARGET, { recursive: true })
/*
 * 只删**看起来是本项目产物**的文件，不再整目录清空。
 *
 * 原来是"除暂存目录外全删"：一旦 output 指错、或指向一个本来就有别的文件的目录，
 * 那些无关文件也会被删掉。改成按名字判断后，不认识的东西一律不碰。
 * （同时上面的安全防护仍然拦着"成品目录 = 项目目录或其祖先"那种情况。）
 */
const REMOVABLE = /^(DSH-Sesame-.*\.(exe|exe\.blockmap|blockmap)|latest\.ya?ml|MANIFEST\.txt)$/i
let cleanedCount = 0
for (const entry of await readdir(TARGET, { withFileTypes: true })) {
  if (entry.name === STAGE_NAME) continue
  if (!REMOVABLE.test(entry.name)) continue
  await rm(join(TARGET, entry.name), { recursive: true, force: true })
  cleanedCount += 1
}

console.log(cleanedCount > 0 ? `清理上一次产物 ${cleanedCount} 个` : '没有需要清理的上一次产物')
console.log('提取产物到顶层…')
for (const item of entries) {
  const dest = join(TARGET, item.file)
  await mkdir(dirname(dest), { recursive: true })
  await cp(join(SOURCE, item.file), dest)
}


console.log('清理暂存…')
await rm(SOURCE, { recursive: true, force: true })

console.log(`\n完成：${entries.length} 个文件已发布到 ${TARGET}`)
