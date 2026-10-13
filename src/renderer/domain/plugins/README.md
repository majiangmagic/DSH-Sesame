# renderer/domain/plugins

**插件页**（标签页「插件」，`/plugins`）—— 插件开关、安装/卸载/更新，以及插件市场。

| 文件 | 作用 |
| --- | --- |
| `PluginsView.vue` | 页面：市场目录 + 已装列表 + 搜索/排序/筛选 |
| `PluginPanel.vue` | 插件开关面板（控制页也复用） |
| `PluginRow.vue` | 单行插件 |
| [stores/plugins.ts](stores/plugins.ts) | 已装插件与开关状态 |
| [stores/market.ts](stores/market.ts) | 市场目录、排序/筛选/分页、更新判定 |

## 市场没有自己的目录

它的界面就在这一页里，**没有自己的标签页** —— 所以不构成一个独立领域。
共享模型同理：市场类型与插件类型都在
[../../../shared/types/plugins.ts](../../../shared/types/plugins.ts)。

## 「已装」判断必须用 npm 包名，不能用短名

目录里存在不同作者的同名短名（实测 186 个短名重复，`dsh-pet` 就有两位作者各一份）。
按短名匹配会把别人的包也标成已装 —— 而且版本、更新目标也都是错的。
所以严格按 `npm` 字段比，空 `npm` 一律不算已装。

## 更新判定用 `@utils/version`

`stores/market.ts` 的 `updateTarget` 调 `compareVersionStrings`（`@utils/version`），
与主进程**同一份实现**。这里原先是个"只比数字段"的简化版，会把
`0.2.0-rc.2` 判成比 `0.2.0` 新（其实更旧），于是界面会推一个降级。

## 目录有四千余条，所以分页

`PAGE_STEP = 120`，一次全渲染会把界面拖死。
