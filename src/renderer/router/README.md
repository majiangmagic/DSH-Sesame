# renderer/router

**路由配置** —— 6 个标签页各一条。

| 文件 | 作用 |
| --- | --- |
| `index.ts` | `createRouter` + 路由表 |

## 路由名 / 目录名 / i18n 区块名三处同名

| 标签页 | 路由 | 目录 | 文案 key |
| --- | --- | --- | --- |
| 控制 | `/control` | `domain/control/` | `nav.control` |
| 版本 | `/versions` | `domain/versions/` | `nav.versions` |
| 插件 | `/plugins` | `domain/plugins/` | `nav.plugins` |
| 终端 | `/terminal` | `domain/terminal/` | `nav.terminal` |
| 快照 | `/snapshots` | `domain/snapshots/` | `nav.snapshots` |
| 设置 | `/settings` | `domain/settings/` | `nav.settings` |

从任何一个入口（界面上的字 / URL / 目录）都能直接找到另外两个。

## 用 hash 模式

打包后页面由自定义协议（`app://bundle`）承载，hash 不参与服务端路径解析，
不会有 history 模式那种"直接打开 `/plugins` 找不到文件"的问题。

## 视图是同步导入的，不要改成懒加载

原版把几个页面全放在 DOM 里，切 tab 是瞬时的。懒加载会让首次切到某个 tab 时
先空白一下（等 chunk），既不像原版，也会让 tab 的入场动画看起来"迟到"。
这些页面加起来只有几十 KB，又都是本地文件，同步导入没有代价。
