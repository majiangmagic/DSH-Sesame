# shared/constants

**跨进程共享的常量。** 目前只有一份：通道名。

| 文件 | 内容 |
| --- | --- |
| `channels.ts` | 9 组通道名 + 各自的联合类型 |

## 通道名是线上协议

主进程在 `main/ipc/*.ts` 注册、preload 在 `preload/index.ts` 调用 ——
**两边都从这里取常量，不写字面量**。

它**不随目录划分变化**：主进程侧 `ipc/terminal.ts` 注册的仍是 `log:get` /
`log:clear` / `log:line`（不是 `terminal:*`）。目录改名是纯重组，
通道名一旦发布就不能随便改。

## 9 组

`WINDOW_CHANNELS` · `VERSION_CHANNELS` · `PLUGIN_CHANNELS` · `MARKET_CHANNELS` ·
`LOG_CHANNELS` · `SETTINGS_CHANNELS` · `DESKTOP_CHANNELS` · `DIAGNOSE_CHANNELS` ·
`SNAPSHOT_CHANNELS`

注意分组**不按 `domain/` 的目录走**：`VERSION_CHANNELS` 里的
`start` / `stop` 由 `ipc/control.ts` 注册，`overview` / `install` / `uninstall`
由 `ipc/versions.ts` 注册 —— 分属两个领域，但共用同一组通道名，
因为对渲染层来说它们是同一件事（"这个版本"）。
