/**
 * 检查内置的 dshmarket 是否需要更新，并探测它内部 API 是否还齐全。
 *
 * 用法：node scripts/check-market-version.mjs
 *
 * 为什么需要它：我们把 dshmarket 当库用，依赖的是它**没有稳定性承诺**的内部模块
 * （见 docs/market-dependency.md）。市场升级后如果改了导出，相关功能必须降级 ——
 * 这个脚本就是那个提醒。
 *
 * 它不开 Electron，直接在 Node 里载入，所以能在 CI 里跑。
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

/** 与 src/main/market.ts 的 REQUIRED 表保持一致 —— 改那边记得改这里 */
const REQUIRED = {
  profile: ['profileDir', 'readManifestDeps', 'readInstalled', 'readProfileBundles'],
  registry: ['loadRegistry'],
  updates: ['fetchNpmLatest', 'checkUpdates'],
  compatibility: ['assessProfile'],
  snapshot: ['createProfileSnapshot', 'listSnapshots', 'restoreSnapshot']
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pinned = pkg.dependencies?.dshmarket ?? '(未声明)'
const exact = /^\d/.test(pinned)

console.log('='.repeat(66))
console.log('内置插件市场库检查')
console.log('='.repeat(66))
console.log(`package.json 里锁的版本 : ${pinned}${exact ? '  (精确锁定 ✓)' : '  ⚠️ 不是精确版本，内部签名一变就可能悄悄崩'}`)

let marketRoot
try {
  marketRoot = dirname(require_.resolve('dshmarket/package.json'))
} catch (error) {
  console.log(`\n✗ 找不到 dshmarket：${error.message}`)
  console.log('  先跑：npm install')
  process.exit(1)
}
const installed = String(JSON.parse(readFileSync(join(marketRoot, 'package.json'), 'utf8')).version)
console.log(`实际安装的版本          : ${installed}`)
if (exact && installed !== pinned) {
  console.log(`  ⚠️ 与锁定的版本不一致 —— 依赖树可能被别的操作改过`)
}
console.log(`包目录                  : ${marketRoot}`)

// ---- 内部 API 探测 ----
console.log('\n--- 内部 API 探测 ---')
const missing = []
const ok = []
for (const [name, expected] of Object.entries(REQUIRED)) {
  let mod
  try {
    mod = require_(join(marketRoot, 'lib', `${name}.js`))
  } catch (error) {
    missing.push(...expected.map((fn) => `${name}.${fn}`))
    console.log(`  ✗ ${name}.js 载入失败：${error.message}`)
    continue
  }
  for (const fn of expected) {
    if (typeof mod[fn] === 'function') ok.push(`${name}.${fn}`)
    else missing.push(`${name}.${fn}`)
  }
}
console.log(`  可用 ${ok.length} 项，缺失 ${missing.length} 项`)
if (missing.length > 0) {
  console.log('\n  ✗ 缺失的导出（市场改了内部 API，对应功能必须降级）：')
  for (const item of missing) console.log(`      ${item}`)
  console.log('\n  处理：读 docs/market-dependency.md，改 src/main/market.ts 的 REQUIRED 表与调用点。')
} else {
  console.log('  ✓ 我们依赖的内部 API 全部存在')
}

// ---- 版本检查 ----
console.log('\n--- 版本检查 ---')
const registryBase = (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/$/, '')

/** 裸查注册表：注册表实际最新版（不受市场的发布冷却影响，只用于解释） */
async function rawLatest() {
  try {
    const res = await fetch(`${registryBase}/dshmarket/latest`, { headers: { accept: 'application/json' } })
    if (!res.ok) return { version: null, error: `HTTP ${res.status}` }
    const body = await res.json()
    return { version: typeof body.version === 'string' ? body.version : null, error: null }
  } catch (error) {
    return { version: null, error: error.message }
  }
}

/** 市场自己的判断：带 24 小时发布冷却，所以可能返回 null */
async function marketLatest() {
  try {
    const mod = require_(join(marketRoot, 'lib', 'updates.js'))
    if (typeof mod.fetchNpmLatest !== 'function') return { version: null, error: 'fetchNpmLatest 缺失' }
    const value = await mod.fetchNpmLatest('dshmarket')
    return { version: typeof value === 'string' && value ? value : null, error: null }
  } catch (error) {
    return { version: null, error: error.message }
  }
}

const [raw, market] = await Promise.all([rawLatest(), marketLatest()])
console.log(`  注册表最新版（裸查）    : ${raw.version ?? `不可用（${raw.error}）`}`)
console.log(`  市场判定的更新目标      : ${market.version ?? `null${market.error ? `（${market.error}）` : '（在发布冷却期内，属正常）'}`}`)
console.log(`  当前内置                : ${installed}`)

if (market.version && market.version !== installed) {
  console.log(`\n  → 建议更新：npm install --save-exact dshmarket@${market.version}`)
} else if (raw.version && raw.version !== installed && !market.version) {
  console.log(`\n  → 注册表已有 ${raw.version}，但市场认为发布太新（24 小时冷却），暂不作为更新目标。`)
  console.log(`    这是市场的供应链策略，启动器应遵循它（见 docs/market-dependency.md）。`)
} else if (raw.version === installed) {
  console.log('\n  → 已是最新')
} else {
  console.log('\n  → 无法判断（网络不可用？）')
}

console.log('\n' + '='.repeat(66))
process.exit(missing.length > 0 ? 1 : 0)
