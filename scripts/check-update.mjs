/**
 * 校验**更新链路最risky的一环**：`latest.yml` 的解析。
 *
 * 为什么需要它：这条链路上别的东西坏了都会报错，只有它是**静默**的 ——
 * electron-builder 改了输出格式、或者解析正则写错，表现是"检查更新永远失败"
 * 或"下载了错的包"，而两者在类型层面完全看不出来（解析结果全是 string）。
 *
 * **它直接 import 真实实现**（`src/main/domain/settings/updateMeta.ts`），不是复制一份 ——
 * 复制出来的那份迟早会和真身漂移，然后给出让人安心的错误结论。
 * 能做到这一点是因为 `updateMeta.ts` 刻意不依赖 Electron（只用类型）。
 *
 * 它抓的是 GitHub 上**真实的** `latest.yml`：这是"无法运行打包后的应用"时，
 * 唯一能做的端到端验证。
 *
 * 用法：
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/check-update.mjs
 *   node ... scripts/check-update.mjs --tag v0.1.5     # 验某个历史版本（回归用）
 *   node ... scripts/check-update.mjs --file x.yml     # 解析本地文件（离线 / 网络受限时用）
 *
 * ⚠️ 需要 **Node ≥ 22.6**（靠类型剥离直接 import `.ts`）。
 * ⚠️ 需要网络（`--file` 模式除外）。
 *
 * ⚠️ **它用 Node 的 `fetch`，而应用用的是 Electron 的 `net`** —— 两者不是一回事。
 * 在挂了代理 / TUN 的机器上 undici 可能连不上（`UND_ERR_CONNECT_TIMEOUT`），
 * 那时本脚本会以退出码 2 明确说明"网络不可达"，而不是假装解析失败。
 * 应用本身不受这个限制（`net` 走系统代理与系统证书库）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseLatestYml,
  releaseAssetUrl,
  releasePageUrl,
  repoSlugFrom
} from '../src/main/domain/settings/updateMeta.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const tagArg = process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : null
const fileArg = process.argv.includes('--file') ? process.argv[process.argv.indexOf('--file') + 1] : null
const slug = repoSlugFrom(pkg.repository) ?? 'majiangmagic/DSH-Sesame'

let failed = false
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed = true
}

console.log('='.repeat(66))
console.log('启动器更新链路检查')
console.log('='.repeat(66))
console.log(`本地版本        ${pkg.version}`)
console.log(`package.json 里声明的仓库  ${pkg.repository ? JSON.stringify(pkg.repository) : '(没写，用常量兜底)'}`)
console.log(`识别出的 owner/repo        ${slug}`)

/* ---------- ① 仓库坐标能从 package.json 认出来吗 ---------- */
console.log('\n--- 仓库坐标解析（纯函数，不联网） ---')
const slugCases = [
  ['https://github.com/o/n.git', 'o/n'],
  ['git+https://github.com/o/n.git', 'o/n'],
  ['github:o/n', 'o/n'],
  ['o/n', 'o/n'],
  ['https://gitlab.com/o/n', null]
]
for (const [input, want] of slugCases) {
  const got = repoSlugFrom(input)
  check(`repoSlugFrom(${JSON.stringify(input)})`, got === want, `→ ${got}（期望 ${want}）`)
}

/* ---------- ② 拿一份真实的 latest.yml 并解析 ---------- */
const ymlUrl = tagArg
  ? `https://github.com/${slug}/releases/download/${tagArg}/latest.yml`
  : releaseAssetUrl(slug, 'latest.yml')

let text = ''

if (fileArg !== null) {
  // 离线模式：文件由调用方用系统栈抓下来（绕开 undici 的代理限制）
  console.log(`\n--- 本地 latest.yml ---\n  ${fileArg}`)
  try {
    text = readFileSync(fileArg, 'utf8')
    check('读到了文件', text.length > 0, `${text.length} 字节`)
  } catch (error) {
    check('读文件', false, String(error?.message ?? error))
  }
} else {
  console.log(`\n--- 真实 latest.yml ---\n  ${ymlUrl}`)
  try {
    const res = await fetch(ymlUrl, { headers: { 'user-agent': 'dsh-sesame-check' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
    check('取到了 latest.yml', text.length > 0, `${text.length} 字节`)
  } catch (error) {
    const cause = error?.cause
    const code = cause?.code ?? ''
    /*
     * 这个脚本用 Node 的 `fetch`（undici），而**应用本身用的是 Electron 的 `net`**
     * （Chromium 网络栈）—— 两者不一样，这是刻意的（见 domain/settings/update.ts 顶部）：
     * undici 不认系统代理、也不认 Windows 证书库，挂了代理 / TUN 做 TLS 中间人的机器上
     * 会以 `UND_ERR_CONNECT_TIMEOUT` 收场且不给原因。
     *
     * 所以这里遇到连接超时时要说清是**环境限制**，别让人以为是解析代码坏了 ——
     * 尤其 `--tag` 那条路：tag 资产会 302 到 `objects.githubusercontent.com`，
     * 那个域名在受限网络里往往不可达，而 `latest` 那条可能恰好可达。
     */
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_SOCKET' || code === 'ENOTFOUND') {
      console.log(`  ⚠️ 连不上（${code}）—— 这是 Node/undici 的网络限制，不是解析代码的问题。`)
      console.log('     应用本身走 Electron 的 net（系统代理 + 系统证书库），不受这个限制。')
      console.log('     想验证解析逻辑：用系统栈把文件抓下来，再用 --file 跑本脚本。')
      console.log(`\n${'='.repeat(66)}`)
      console.log('⚠️ 跳过（网络不可达，无法验证）')
      process.exit(2)
    }
    check('取到 latest.yml', false, String(error?.message ?? error))
  }
}

if (text !== '') {
  const meta = parseLatestYml(text)
  check('解析成功', meta !== null, meta ? '' : '（关键键缺失 —— 形状变了？）')

  if (meta !== null) {
    console.log(`     version ${meta.version}`)
    console.log(`     file    ${meta.file}`)
    console.log(`     size    ${meta.size} 字节（${(meta.size / 1024 / 1024).toFixed(1)} MB）`)
    console.log(`     sha512  ${meta.sha512.slice(0, 24)}…（${meta.sha512.length} 字符）`)

    check('version 是非空版本号形状', /^\d+\.\d+\.\d+/.test(meta.version), meta.version)
    check('file 是 .exe', /\.exe$/i.test(meta.file), meta.file)
    /* 文件名里应当含版本号 —— 这是 electron-builder 的 artifactName 模板，也是我们判断"解析到的是不是同一个包"的依据 */
    check('file 名里含版本号', meta.file.includes(meta.version), `${meta.file} ⊃ ${meta.version}`)
    check('size 合理（> 1 MB）', meta.size > 1024 * 1024, `${meta.size}`)
    /* sha512 base64 固定 88 字符（64 字节 → base64 补 '=='） */
    check('sha512 是 base64 的 64 字节', meta.sha512.length === 88, `${meta.sha512.length} 字符`)

    /*
     * ---------- ③ 那个安装包真的存在吗 ----------
     *
     * `--file` 模式下**跳过**：那份 yml 可能是历史版本的，而 URL 是按
     * `releases/latest` 拼的 —— 拿 v0.1.4 的文件名去 latest 里找必然 404，
     * 那是错报，不是真问题。
     */
    if (fileArg === null) {
      console.log('\n--- 安装包资产是否存在（只发 HEAD，不下载 140 MB）---')
      try {
        const head = await fetch(releaseAssetUrl(slug, meta.file), {
          method: 'HEAD',
          headers: { 'user-agent': 'dsh-sesame-check' }
        })
        check('安装包可下载', head.ok, `HTTP ${head.status}`)
        const len = Number(head.headers.get('content-length') ?? 0)
        if (len > 0 && meta.size > 0) {
          check('HEAD 的 content-length 与 latest.yml 的 size 一致', len === meta.size, `${len} vs ${meta.size}`)
        }
      } catch (error) {
        const code = error?.cause?.code ?? ''
        if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_SOCKET') {
          console.log(`  ⚠️ 连不上（${code}）—— 同上，Node 网络限制，跳过这一项`)
        } else {
          check('安装包可下载', false, String(error?.message ?? error))
        }
      }
    } else {
      console.log('\n--- 安装包资产 ---（--file 模式跳过：URL 按 latest 拼，历史版本必然 404）')
    }

    /* ---------- ④ 版本比较（我们用的那套）---------- */
    console.log('\n--- 版本比较 ---')
    const { compareVersionStrings } = await import('../src/utils/version.ts')
    const cmp = compareVersionStrings(meta.version, pkg.version)
    console.log(`     远端 ${meta.version}  vs  本地 ${pkg.version}  →  ${cmp}`)
    check('两个版本号都能解析', cmp !== null, String(cmp))
    console.log(
      cmp === null
        ? '     （解析不了）'
        : cmp > 0
          ? '     → 远端更新（设置页会显示「更新到 …」按钮）'
          : '     → 本地已是新版或相同（设置页显示「已是最新」）'
    )
  }
}

console.log(`\nRelease 页面  ${releasePageUrl(slug)}`)
console.log('='.repeat(66))
console.log(failed ? '❌ 有失败项' : '✅ 全部通过')
process.exit(failed ? 1 : 0)