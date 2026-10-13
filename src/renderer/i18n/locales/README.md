# renderer/i18n/locales

语言包。**两份必须同 key** —— 少一条就会在界面上露出 key 本身。
（`en-US.ts` 用 `typeof zhCN` 约束，漏补直接编译不过。）

| 文件 | 作用 |
| --- | --- |
| `zh-CN.ts` | 中文（默认，**文案的唯一真相**） |
| `en-US.ts` | 英文 |

## 顶层区块名与标签页一致

| 标签页 | 区块 | 路由 | 目录 |
| --- | --- | --- | --- |
| 控制 | `control.` | `/control` | `domain/control/` |
| 版本 | `versions.` | `/versions` | `domain/versions/` |
| 插件 | `plugins.` | `/plugins` | `domain/plugins/` |
| 终端 | `terminal.` | `/terminal` | `domain/terminal/` |
| 快照 | `snapshots.` | `/snapshots` | `domain/snapshots/` |
| 设置 | `settings.` | `/settings` | `domain/settings/` |

另有跨页区块：`app.` / `common.` / `nav.` / `window.` / `progress.` / `status.` /
`modal.` / `ask.` / `gone.` / `check.` / `market.` / `snap.`。

（早先控制页的区块叫 `home.`、终端页叫 `log.` —— 与标签页对不上，已改。）

## 英文标签要和中文对得上

`nav.terminal` 中文是「终端」，英文就该是 `'Terminal'` ——
早先写的是 `'Log'`，那是照着代码里的目录名（`logs/`）写的，不是照着标签页写的。
**以中文标签为准**，因为它是产品上确定的那一份。

## 注意插值写法

带参数的文案（如 `check.disabled`、`control.portFallback`、`snap.restored`）
用 `{name}` 形式占位，两边参数名必须一致。
