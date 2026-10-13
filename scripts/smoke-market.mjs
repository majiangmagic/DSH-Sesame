/**
 * 市场库冒烟测试：**真的调一次**它最核心的能力，而不只是检查函数存在。
 *
 * 为什么需要：`check-market-version.mjs` 只探测"11 个内部导出还在不在"——
 * 函数在、但**返回结构变了**（字段改名、层级挪动）同样会让启动器读到空数据，
 * 而那种坏法在类型层面完全看不出来（我们收窄时对缺失字段是宽容的，会退化成空串）。
 *
 * 所以这里把 `market.ts` 的收窄逻辑照搬一遍，对**真实返回**做断言：
 *   · loadRegistry 拿到的条目里，我们依赖的那几个字段有没有值
 *   · assessProfile / listSnapshots 能不能不抛地跑完
 *
 * 需要网络（要拉市场目录）。用法：
 *   node scripts/smoke-market.mjs
 *   node scripts/smoke-market.mjs --region global
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const require_ = createRequire(import.meta.url)
const root = dirname(require_.resolve('dshmarket/package.json'))
const version = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)
const region = process.argv.includes('--region')
  ? process.argv[process.argv.indexOf('--region') + 1]
  : 'china'

console.log(`dshmarket ${version} · region=${region}`)

/** 与 src/main/domain/plugins/market.ts 同一套收窄 —— 保持同步，别在这里另立一套 */
const asString = (v) => (typeof v === 'string' ? v : '')
const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const asStringArray = (v) =>
  Array.isArray(v) ? v.filter((item) => typeof item === 'string') : []

let failed = false
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed = true
}

/* ---------- ① loadRegistry：最核心的能力，也是字段最容易被改的地方 ---------- */
console.log('\n--- loadRegistry ---')
let rows = []
try {
  const mod = require_(join(root, 'lib', 'registry.js'))
  const raw = await mod.loadRegistry(region)
  rows = Array.isArray(raw?.plugins) ? raw.plugins : []
  check('返回了 plugins 数组', rows.length > 0, `${rows.length} 条`)
  check('有 source/updated 元信息', asString(raw?.source) !== '' || asString(raw?.updated) !== '',
    `source=${asString(raw?.source).slice(0, 40)}`)

  if (rows.length > 0) {
    /*
     * 统计我们真正用到的字段有多少条有值。
     * 阈值故意放宽（不要求 100%）—— 目录是社区维护的，本来就有条目缺字段；
     * 但**大面积缺失**就说明市场改了结构，那是必须知道的。
     */
    const mapped = rows.map((row) => ({
      name: asString(row.name),
      npm: asString(row.npm),
      version: asString(row.version),
      owner: asString(row.owner),
      url: asString(row.url),
      category: asStringArray(row.category),
      screenshots: asStringArray(row.screenshots)
    }))
    const withName = mapped.filter((p) => p.name !== '').length
    const withNpm = mapped.filter((p) => p.npm !== '').length
    const withVersion = mapped.filter((p) => p.version !== '').length
    const withCategory = mapped.filter((p) => p.category.length > 0).length
    const withShot = mapped.filter((p) => p.screenshots.length > 0).length

    const pct = (n) => `${n}/${rows.length} (${Math.round((n / rows.length) * 100)}%)`
    check('name 有值', withName / rows.length > 0.9, pct(withName))
    check('npm 有值（「已装」判断靠它）', withNpm / rows.length > 0.5, pct(withNpm))
    check('version 有值（更新判定靠它）', withVersion / rows.length > 0.5, pct(withVersion))
    check('category 有值（分类筛选靠它）', withCategory / rows.length > 0.5, pct(withCategory))
    check('screenshots 部分有值（已知稀疏）', withShot > 0, pct(withShot))
  }
} catch (error) {
  check('loadRegistry 可调用', false, String(error?.message ?? error))
}

/* ---------- ② regions：图片代理要用它改写 GitHub 地址 ---------- */
console.log('\n--- regions ---')
try {
  const mod = require_(join(root, 'lib', 'regions.js'))
  const routes = mod.githubRoutesFor('raw', region)
  check('githubRoutesFor 返回数组', Array.isArray(routes), `${Array.isArray(routes) ? routes.length : '?'} 条`)
  check('activeRegion 可调用', typeof mod.activeRegion === 'function',
    String(mod.activeRegion?.() ?? ''))
} catch (error) {
  check('regions 可用', false, String(error?.message ?? error))
}

/* ---------- ③ updates：更新检查 ---------- */
console.log('\n--- updates ---')
try {
  const mod = require_(join(root, 'lib', 'updates.js'))
  const latest = await mod.fetchNpmLatest('dshmarket')
  // 返回 null 是合法的（发布冷却期内），所以只断言"没抛"
  check('fetchNpmLatest 可调用（null = 冷却期内，正常）', true, String(latest))
} catch (error) {
  check('updates 可用', false, String(error?.message ?? error))
}

/* ---------- ④ compatibility / snapshot：读真实 profile ---------- */
console.log('\n--- compatibility / snapshot（读真实 profile） ---')
const home = process.env.DSH_HOME || join(process.env.USERPROFILE ?? '', '.dsh')
const webDir = join(home, 'profiles', 'web')
try {
  const mod = require_(join(root, 'lib', 'compatibility.js'))
  const result = mod.assessProfile('web')
  check('assessProfile 不抛', true, typeof result === 'object' ? 'ok' : String(result))
} catch (error) {
  check('assessProfile 可用', false, String(error?.message ?? error))
}
try {
  const mod = require_(join(root, 'lib', 'snapshot.js'))
  const list = mod.listSnapshots(webDir)
  check('listSnapshots 不抛', true, `${Array.isArray(list) ? list.length : '?'} 份`)
} catch (error) {
  check('listSnapshots 可用', false, String(error?.message ?? error))
}

console.log(`\n${failed ? '❌ 有失败项' : '✅ 全部通过'}`)
process.exit(failed ? 1 : 0)
