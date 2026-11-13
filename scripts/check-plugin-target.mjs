/**
 * 自检：目录条目 → 安装目标的三段式解析（`src/utils/pluginTarget.ts`）。
 *
 * 用法：
 *   node scripts/check-plugin-target.mjs
 *   node scripts/check-plugin-target.mjs --live   # 再拿真实目录跑一遍分布统计（需要网络）
 *
 * ## 为什么要有这个脚本
 *
 * 这段逻辑决定**点「下载」时到底装什么**，而它的失败方式是安静的：
 * 解析错了不会报错，只会去打一个不存在的包、或装成别人的同名包。
 * 它是纯字符串逻辑（无 IO、无 Electron），所以能像这样直接断言，不需要起界面。
 *
 * **它直接 import 真实实现**，不复制一份规则 —— 复制的那份迟早漂移，
 * 然后给出让人安心的错误结论（`check-desktop-mirror.mjs` 开头也说了同一件事）。
 *
 * ## 三条规则（与 dsh 自己的市场 `dshmarket/lib/sources.js` 一致）
 *
 *   ① npm 名合法 → 用它
 *   ② `tarball` 是**同一个仓库**的 Release 产物 → 用它
 *   ③ 兜底 `github:owner/repo`，monorepo 子包带 `#path:/sub`
 *
 * ②的"同一个仓库"是安全边界：只认 url 里那个 owner/repo 自己的 Release，
 * 否则一条记录可以写着可信仓库、却指向别处的压缩包去安装。
 *
 * ⚠️ 需要 **Node ≥ 22.6**：靠类型剥离直接 import `.ts`。
 */
import { resolveInstallTarget, repoOfSpec, subpathOfSpec, specMatchesTarget } from '../src/utils/pluginTarget.ts'

let failures = 0
let checks = 0

function eq(label, actual, expected) {
  checks += 1
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log(`❌ ${label}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`)
  }
}

/** 只比 target 与 kind，省得每条都写全 */
function target(label, entry, expected) {
  checks += 1
  const got = resolveInstallTarget(entry)
  const brief = got === null ? null : { target: got.target, kind: got.kind }
  const ok = JSON.stringify(brief) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log(`❌ ${label}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(brief)}`)
  }
}

/* ---------------- ① npm 名 ---------------- */

target('npm 名合法 → 直接用', { npm: '@scope/pkg', url: 'https://github.com/a/b' }, {
  target: '@scope/pkg',
  kind: 'npm'
})
target('npm 名合法但没 url → 仍可用', { npm: 'plain-pkg', url: null }, {
  target: 'plain-pkg',
  kind: 'npm'
})
// 目录里真实存在 npm 字段写着"显示名"的记录：当包名传给 pnpm 会装错东西
target(
  'npm 字段不是合法包名 → 不采纳，退回仓库',
  { npm: 'Some Display Name', url: 'https://github.com/a/b' },
  { target: 'github:a/b', kind: 'github' }
)
target('npm 字段带大写 → 不采纳', { npm: 'UpperCase', url: 'https://github.com/a/b' }, {
  target: 'github:a/b',
  kind: 'github'
})

/* ---------------- ③ GitHub 仓库兜底 ---------------- */

target('只有仓库 → github:owner/repo', { npm: null, url: 'https://github.com/Anmulzhao/DSH-AGINT' }, {
  target: 'github:Anmulzhao/DSH-AGINT',
  kind: 'github'
})
target('npm 空串视同没有', { npm: '   ', url: 'https://github.com/a/b' }, {
  target: 'github:a/b',
  kind: 'github'
})
target('末尾斜杠要容忍', { npm: '', url: 'https://github.com/a/b/' }, {
  target: 'github:a/b',
  kind: 'github'
})
target(
  'monorepo 子包 → #path:',
  { npm: null, url: 'https://github.com/zhoulvyuan/dsh-plugin/tree/master/dsh-claude-code-web' },
  { target: 'github:zhoulvyuan/dsh-plugin#path:/dsh-claude-code-web', kind: 'github' }
)
target(
  '多层子路径',
  { npm: null, url: 'https://github.com/a/b/tree/main/packages/worktable' },
  { target: 'github:a/b#path:/packages/worktable', kind: 'github' }
)
// `..` 会跳出仓库，必须整条拒绝（不是退回仓库根 —— 那是另一种行为）
target('子路径含 .. → 拒绝', { npm: null, url: 'https://github.com/a/b/tree/main/../../etc' }, null)
target('非 GitHub 地址 → 拒绝', { npm: null, url: 'https://gitlab.com/a/b' }, null)
target('什么都没有 → 拒绝', { npm: null, url: null, tarball: null }, null)

/* ---------------- ② 同仓库 Release 产物 ---------------- */

const repo = 'https://github.com/CanaryJing/dsh-big-fat-whale-maid-adaptive'
const ownTarball =
  'https://github.com/CanaryJing/dsh-big-fat-whale-maid-adaptive/releases/download/v3.2.3/x-3.2.3.tgz'

target('同仓库 Release 产物 → 用 tarball', { npm: null, url: repo, tarball: ownTarball }, {
  target: ownTarball,
  kind: 'tarball'
})
target('npm 优先于 tarball', { npm: 'pkg', url: repo, tarball: ownTarball }, {
  target: 'pkg',
  kind: 'npm'
})

/* 安全边界：url 写可信仓库、tarball 指向别处 —— 必须退回仓库源码，不能装那个压缩包 */
target(
  'tarball 属于别的仓库 → 不采纳',
  {
    npm: null,
    url: repo,
    tarball: 'https://github.com/evil/repo/releases/download/v1/p.tgz'
  },
  { target: 'github:CanaryJing/dsh-big-fat-whale-maid-adaptive', kind: 'github' }
)
target(
  'tarball 不是 /releases/ 路径 → 不采纳',
  { npm: null, url: repo, tarball: 'https://github.com/CanaryJing/dsh-big-fat-whale-maid-adaptive/x.tgz' },
  { target: 'github:CanaryJing/dsh-big-fat-whale-maid-adaptive', kind: 'github' }
)
target(
  'tarball 是 http（非 https）→ 不采纳',
  { npm: null, url: repo, tarball: ownTarball.replace('https://', 'http://') },
  { target: 'github:CanaryJing/dsh-big-fat-whale-maid-adaptive', kind: 'github' }
)
target(
  'tarball 在 release-assets CDN 上（无 owner/repo）→ 不采纳',
  {
    npm: null,
    url: repo,
    tarball: 'https://release-assets.githubusercontent.com/x/releases/download/v1/p.tgz'
  },
  { target: 'github:CanaryJing/dsh-big-fat-whale-maid-adaptive', kind: 'github' }
)

/* ---------------- 已装规格串的反查 ---------------- */

eq('repoOfSpec github:', repoOfSpec('github:burning-frappuccino/dsh-turbo'), 'burning-frappuccino/dsh-turbo')
eq('repoOfSpec 带 #sha', repoOfSpec('github:o/r#0123abc'), 'o/r')
eq('repoOfSpec 带 #path:', repoOfSpec('github:o/r#path:/sub/pkg'), 'o/r')
eq('repoOfSpec git+https', repoOfSpec('git+https://github.com/o/r.git#abc'), 'o/r')
eq('repoOfSpec 代理前缀', repoOfSpec('https://gh-proxy.com/https://github.com/o/r'), 'o/r')
eq('repoOfSpec codeload', repoOfSpec('https://codeload.github.com/o/r/tar.gz/' + 'a'.repeat(40)), 'o/r')
eq('repoOfSpec 版本范围 → null', repoOfSpec('^1.2.3'), null)
eq('repoOfSpec 空 → null', repoOfSpec(''), null)

eq('subpathOfSpec', subpathOfSpec('github:o/r#path:/packages/x'), 'packages/x')
eq('subpathOfSpec 无 → null', subpathOfSpec('github:o/r'), null)

/* ---------------- 「是不是这个目标装的」 ---------------- */

const npmTarget = resolveInstallTarget({ npm: '@a/b', url: 'https://github.com/a/b' })
const gitTarget = resolveInstallTarget({ npm: null, url: 'https://github.com/a/b' })
const subTarget = resolveInstallTarget({ npm: null, url: 'https://github.com/a/b/tree/main/p1' })
const otherSub = resolveInstallTarget({ npm: null, url: 'https://github.com/a/b/tree/main/p2' })

eq('npm 目标按包名认', specMatchesTarget('@a/b', npmTarget), true)
eq('npm 目标不认同名别的', specMatchesTarget('@a/c', npmTarget), false)
eq('git 目标认同仓库', specMatchesTarget('github:o/a#whatever', gitTarget), false)
eq('git 目标认自己', specMatchesTarget('github:a/b', gitTarget), true)
eq('git 目标认 .git 形态', specMatchesTarget('git+https://github.com/a/b.git#sha', gitTarget), true)
eq('子包目标要路径一致', specMatchesTarget('github:a/b#path:/p1', subTarget), true)
eq('子包目标不接受另一个子包', specMatchesTarget('github:a/b#path:/p2', subTarget), false)
eq('无子包目标接受仓库根', specMatchesTarget('github:a/b', otherSub), false)

/* ---------------- 结论 ---------------- */

if (failures === 0) {
  console.log(`✅ ${checks} 项断言全部通过`)
} else {
  console.log(`\n❌ ${failures}/${checks} 项失败`)
}

/* ---------------- 可选：真实目录分布 ---------------- */

if (process.argv.includes('--live')) {
  console.log('\n—— 真实目录（awesome-dsh-plugin.com）——')
  try {
    const res = await fetch('https://awesome-dsh-plugin.com/plugins.json')
    const data = await res.json()
    const counts = { npm: 0, tarball: 0, github: 0, none: 0 }
    const none = []
    for (const entry of data.plugins) {
      const got = resolveInstallTarget({ npm: entry.npm, url: entry.url, tarball: entry.tarball })
      if (got === null) {
        counts.none += 1
        if (none.length < 5) none.push(entry.name)
      } else {
        counts[got.kind] += 1
      }
    }
    const total = data.plugins.length
    const usable = total - counts.none
    console.log(`总数 ${total}`)
    console.log(`npm ${counts.npm} · tarball ${counts.tarball} · github ${counts.github}`)
    console.log(`可安装 ${usable}（${((usable / total) * 100).toFixed(2)}%）· 装不了 ${counts.none}`)
    if (none.length > 0) console.log(`装不了的例子：${none.join('、')}`)
  } catch (cause) {
    console.log(`（跳过：取不到目录 —— ${cause instanceof Error ? cause.message : String(cause)}）`)
  }
}

process.exit(failures === 0 ? 0 : 1)
