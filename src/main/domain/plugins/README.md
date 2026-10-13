# main/domain/plugins

**插件页**（标签页「插件」，`/plugins`）背后的逻辑，外加内置的插件市场库。

| 文件 | 作用 |
| --- | --- |
| `pluginState.ts` | 读插件清单、按包名整包开关（写 `cordis.patch.yml`） |
| `pluginInstall.ts` | 安装 / 更新 / 卸载，走 dsh 自己的 `plugin` 命令（→ pnpm） |
| `market.ts` | 把 `dshmarket` 当**库**调用：载入探测、目录、更新检查、兼容性 |
| `guard.ts` | 改 profile 前的自动存档（`autoSnapshotBefore`）—— 业务规则，不是 IPC 编排 |

> `pluginState.ts` 原名 `patch.ts`。改名是因为它和 `control/sync.ts` 里的
> `repairDesktopPatch` 撞了"patch"这个词 —— 两个都是"补丁"，一个是**插件开关**，
> 一个是**桌面端补丁层占位符修复**，读名字分不出来。

## 市场为什么在这个目录（而不是单开一个）

它的界面就在插件页里 —— **没有自己的标签页**，所以不构成一个独立领域。
共享模型也一样：市场类型与插件类型都在
[../../../shared/types/plugins.ts](../../../shared/types/plugins.ts)。

## 市场为什么要"当库调用"

它的界面是 dsh 的客户端插件，依赖 `window.__ModuleLoader__` + React + dsh 的
ui-primitives，并注册进 dsh 的 slot 系统，**没有独立挂载点**，搬不出来。
但它的 `lib/` 是纯 Node 库（实测 0 处 `import @deepseek-ai/*`），
所以能在启动器主进程里直接跑，**不需要 dsh 在跑**。

⚠️ 已知风险：`lib/*` 是**内部实现，没有任何稳定性承诺**，且不在 `exports` 里
（只能用绝对路径 require）。所以所有调用都先**探测**，缺什么就禁用对应能力并如实上报，
**不让它把整个应用打挂**。探测基准是 `market.ts` 里的 `REQUIRED` 表。

## dshmarket 的版本：启动器那份与 profile 那份是两回事

`package.json` 里锁死的 `dshmarket` 是**启动器自己**用的库（`loadRegistry` 拉目录、
`assessProfile` 判兼容性、`updates.fetchNpmLatest` 查更新）。
而 `profiles/<name>/node_modules/dshmarket` 是**profile 自己的插件**，由
`dsh plugin add dshmarket` 装 —— 两者独立演进，可以不同版本。

**但要盯住它们别差太远**：启动器拿旧版算法去读新版 profile 会出问题。
实测过一次：启动器锁 **1.58.0**，而 profile 里跑的是 **1.66.17** —— 跨了 8 个小版本，
`assessProfile` / `listSnapshots` 这类"读 profile"的能力就是在用旧代码读新数据。

两个脚本各管一半，升级前后都该跑：

| 命令 | 查什么 | 需要网络 |
| --- | --- | --- |
| `npm run check:market` | 11 个内部导出**还在不在**，以及版本差（含注册表最新版） | 是 |
| `npm run smoke:market` | **真调一次**并断言返回结构（目录字段有没有值、`assessProfile` 抛不抛） | 是 |

两者的分工是有意的：函数**在**、但**返回结构变了**（字段改名、层级挪动）同样会让启动器
读到空数据 —— 而那种坏法在类型层面看不出来，因为我们收窄时对缺失字段是宽容的
（`asString` 会退化成空串）。所以 `smoke:market` 断言的是**真实返回值**。

升级命令（照 `check:market` 的提示）：

    npm install --save-exact dshmarket@<版本>

**必须精确锁定**（不带 `^`）：内部签名一变就可能悄悄崩，而 `^` 会让它在某次
`npm install` 时被动升级。`check:market` 会检查这一点。

## 插件安装为什么不用 npm

profile 是 **pnpm 布局**，自己 `npm install` 会破坏依赖树；而且
`dsh.profile.bundles` 的启用清单由 dsh 在 pnpm 成功后一并 reconcile。
所以一律走 `dsh plugin --profile web add <pkg>`。

## `guard.ts` 为什么在 domain 而不是 ipc

"改 profile 前必须留退路"是一条**业务规则**，不是通信适配。
放在 ipc 层，只有走 Electron IPC 的那条路会受保护；将来 `main/api/`
让外部程序也能装插件时，那条路会绕过它。放在这里，任何调用方都得先经过它。

这也是 `domain/plugins` 对 `domain/snapshots` 的唯一一条跨领域依赖，刻意保留。
