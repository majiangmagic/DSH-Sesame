# main/domain/terminal

**终端页**（标签页「终端」，`/terminal`）的数据 —— 日志环形缓冲。

| 文件 | 作用 |
| --- | --- |
| `logbus.ts` | 上限 3000 行的缓冲 + `pushTagged` 带来源前缀的追加 + 实时推给所有窗口 |

IPC 在 [../../ipc/terminal.ts](../../ipc/terminal.ts)（`log:get` / `log:clear`）。

## 为什么缓冲在 domain 而不是 infrastructure

它是**终端页这个领域的数据**，不是通用机制 —— 早先放在 `infra/logbus.ts`，
结果 `domain/terminal/` 空得只剩一个 ipc 文件，"domain = 标签页"这条规则名存实亡。

代价是别的领域要 `import` 它（control 推子进程输出、plugins 与 settings 推操作事件），
于是多出 3 条 `→ terminal` 的领域间依赖边。这是**可接受的**：
领域之间允许依赖，只要不成环 —— 而 logbus 本身不依赖任何领域，所以它不会带出环。

## 目录叫 terminal，通道叫 log —— 这不矛盾

- **目录 / 路由 / 标签页**统一用 `terminal`（「终端」）；
- **通道名**仍是 `log:get` / `log:clear` / `log:line`。

通道名是**线上协议**：主进程与 preload 靠它对接，改名没有任何收益，
反而会让"改目录"这种纯重组动作变成一次协议变更。

## 内容是什么

**真实发生过的事**：dsh 子进程的 stdout/stderr（启动、就绪地址、插件加载报错、退出码）、
以及版本与插件的增删进度。原版管理页就是把 dsh 的输出行追加到一个 `<pre>` 里，
这里做同一件事，只是缓冲放在主进程 —— 这样切换页面不会丢、重开窗口也能补齐。

每行带来源前缀（`[dsh 0.1.7]` / `[启动器]` / `[桌面端]`），
一眼能看出是 dsh 说的还是启动器说的。

**上限 3000 行**：dsh 跑久了会持续输出，无上限的数组会一路吃内存。
