/**
 * 调用 **dsh 的 CLI** 时共用的东西。
 *
 * 为什么单独一个文件：这些参数被**两个领域**用到 ——
 * `domain/plugins/pluginInstall.ts`（装 / 卸 / 更新 web 的插件）与
 * `domain/control/sync.ts`（把 web 的插件一比一搬到桌面端）。
 *
 * 放在 `infrastructure/` 而不是其中任何一个领域里，是本项目分层规则的直接结果：
 * **被 ≥2 个领域使用的机制不下沉到某一个领域**。放错地方不只是不好看 ——
 * 实测过：把下面这个常量从 `pluginInstall` 导出给 `sync` 用，会立刻形成
 *   `sync → pluginInstall → versions → runner → sync`
 * 的循环依赖（`npm run check:graph` 抓到的）。挪到这里，环就断了。
 */

/**
 * 一次性关掉 pnpm 的"最小发布年龄"闸。
 *
 * pnpm 对刚发布不久的版本有一道供应链保护。它的行为**不是报错，而是静默保留旧版本、
 * 以退出码 0 结束** —— 所以"更新成功"是假的，包根本没变。实测三个目标版本分别只有
 * 0.6 / 1 / 3.6 天大，全部被跳过（真实 profile 里 package.json 一直停在 09/19 没动过、
 * pnpm 连操作日志都没产生）。
 *
 * dshmarket 自己的 `lib/install.js` 就是这么绕的：
 *   export const RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'
 * 用户是**明确点了"更新到某个版本"**（或明确点了"启动桌面端"），属于知情操作；
 * 但不是静默绕过 —— 调用处都会把这件事写进日志，让终端页留痕。
 *
 * 三个使用点，各自的理由：
 *  - `pluginInstall.updatePlugin`：先不带它跑，只有出现"版本没变"或发布年龄特征才带它重试；
 *  - `pluginInstall.uninstallPlugin`：**卸载也要带** —— `pnpm remove` 会校验整个 lockfile，
 *    只要有一条"发布太新"的记录（哪怕是别的包），整条命令就被拒。卸载不引入新包，无风险；
 *  - `sync.removeFromDesktop`：同卸载的理由。
 */
export const RELEASE_AGE_BYPASS = '--config.minimumReleaseAge=0'
