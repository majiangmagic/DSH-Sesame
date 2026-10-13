# main/domain

主进程的**业务层**。目录名严格等于界面上的 6 个标签页：

| 目录 | 标签页 | 路由 | 管什么 |
| --- | --- | --- | --- |
| [control/](control/) | 控制 | `/control` | 启停、端口回退、就绪地址、桌面端启动、启动诊断 |
| [versions/](versions/) | 版本 | `/versions` | 版本池扫描、下载安装、卸载、远端版本表 |
| [plugins/](plugins/) | 插件 | `/plugins` | 插件开关、安装/卸载/更新、内置市场库 |
| [terminal/](terminal/) | 终端 | `/terminal` | 日志环形缓冲（终端页的数据） |
| [snapshots/](snapshots/) | 快照 | `/snapshots` | profile 配置快照：存 / 列 / 回退 |
| [settings/](settings/) | 设置 | `/settings` | 设置写入的校验与落盘编排 |

**IPC 注册不在这里** —— 在 [../ipc/](../ipc/)。这一层只写"做什么"。

## 三处同名，是刻意的

    标签页文案      nav.terminal = '终端'
    路由            /terminal
    目录            domain/terminal/

改名时三处一起改。这正是之前 `logs` 与「终端」对不上的原因 —— 只改了内容没改目录名。

## 判据：有没有自己的标签页

- **诊断**没有（入口是控制页上的「检查」按钮）→ 它在 [control/](control/) 里，不是第 7 个领域；
- **市场**没有（界面就在插件页里）→ 它在 [plugins/](plugins/) 里。

## 目录名是标签页名，不是"我给它起的领域名"

早先这里叫 `runtime`（想表达"运行时生命周期"）、`logs`（想表达"日志"），
结果与界面上的字对不上 —— 看到「终端」标签页的人猜不到代码在 `logs/` 里。
**标签页写什么，目录就叫什么。**

## 领域之间的依赖

允许，但必须看得见。当前 9 条边（`npm run check:graph -- --list` 可随时列出）：

| 边 | 为什么 |
| --- | --- |
| `control → plugins` | `control/sync.ts` 用 `pluginState.patchPathOf` 定位补丁层 |
| `control → terminal` | 把 dsh 子进程的输出推进日志缓冲 |
| `plugins → control` | 装插件前确保 profile 已初始化（`control/diagnose.ts`） |
| `plugins → snapshots` | 改 profile 前自动存档（`plugins/guard.ts`） |
| `plugins → terminal` | 操作日志 |
| `plugins → versions` | 挑一个已装版本来跑 pnpm |
| `settings → terminal` | 保存后记一行日志 |
| `snapshots → control` | 记下快照时的运行版本（`currentRun`） |
| `versions → control` | 读当前运行态，给已装版本打 status/url |

注意 `control ↔ plugins` 是**互指**：文件层面无环（`sync.ts → pluginState.ts`，
`pluginInstall.ts → diagnose.ts` 是两组不同文件），所以模块初始化顺序没问题。
但这也说明这两个领域的边界不够干净 —— 想彻底拆开，得把
`control/diagnose.ts` 里"读插件清单"那部分下沉到 infrastructure。

**绝不许成环** —— `npm run check:graph` 会拦。
