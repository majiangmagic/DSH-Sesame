# main/ipc

**IPC 通信注册与处理。** 全部通道的注册都集中在这个目录 ——
主进程里唯一"知道所有通道"的地方。

| 文件 | 通道 | 对应标签页 |
| --- | --- | --- |
| [index.ts](index.ts) | `registerAllIpc()` —— 总入口 | — |
| [control.ts](control.ts) | `versions:start` / `stop` / `diagnose:run` | 控制 |
| [versions.ts](versions.ts) | `versions:overview` / `install` / `uninstall` | 版本 |
| [plugins.ts](plugins.ts) | `plugins:*` / `market:*` | 插件 |
| [terminal.ts](terminal.ts) | `log:get` / `log:clear` | 终端 |
| [snapshots.ts](snapshots.ts) | `snapshot:*`（6 条） | 快照 |
| [settings.ts](settings.ts) | `settings:get` / `save` | 设置 |
| [window.ts](window.ts) | `window:*` / `shell:open-external` | **无**（窗口壳） |

## 这一层只做四件事

1. **参数校验** —— 载荷来自渲染层，不能整包 trust（如"缺少版本号"就抛）；
2. **进度转发** —— 把领域回调转成 `event.sender.send(通道, 载荷)`；
3. **错误包装** —— 领域抛出的异常原样往上，渲染层统一处理；
4. **边界日志** —— `pushTagged('启动器', …)` 记一行"用户做了什么"。

**不写业务逻辑。** 判据：如果这段代码在"没有 Electron"的环境里也应该成立，
它就不属于这里 —— 放 `domain/`。

例：`plugins.ts` 里那句 `autoSnapshotBefore`（改 profile 前先存档）看着像编排，
但它是一条**业务规则**，所以函数住在 `domain/plugins/guard.ts` ——
否则将来 `api/` 让外部程序也能装插件时，那条路会绕过它。

## 通道名不在这里定义

通道名是**线上协议**，只在 `@shared/constants/channels` 定义一次，
主进程（这里）与 preload 各引用一次。它不随目录划分变化 ——
所以 `terminal.ts` 注册的仍是 `log:*` 而不是 `terminal:*`。

## window.ts 为什么是个例外

它不对应任何标签页 —— 服务的是窗口本身（最小化/最大化/关闭/选目录/开外链）。
放在这里而不是 `infrastructure/window.ts`，是为了守住分工：
`infrastructure` 管窗口怎么建、怎么显示；`ipc` 管它怎么被渲染层调用。
窗口实例从 `currentWindow()` 取（单例，状态在 infrastructure 那边）。
