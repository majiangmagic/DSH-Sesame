# renderer/components

**跨页复用**的 UI 组件。只被某一个页面用的组件不在这里，在那个页面的
`domain/<标签页>/` 里。

| 文件 | 作用 |
| --- | --- |
| `WinControls.vue` | 无边框窗口的最小化 / 最大化 / 关闭 |
| `ProgressBar.vue` | 不确定进度条（dsh 首次启动可能现场装依赖，不给假百分比） |
| `BackdropLayer.vue` | 背景层（`pointer-events: none`） |
| `PatCompanion.vue` | 摸头伴侣（在背景层**之上**，收回来的点击要落到它身上） |
| `SampleTag.vue` | 「样例数据」标注 |
| [overlays/](overlays/) | 三个遮罩层 |

## 判据

**这个组件会不会被第二个页面用？** 会 → 放这里；不会 → 放那个页面的 `domain/` 里。

例：`PluginPanel.vue` 被插件页与控制页共用，但它的数据来自
`domain/plugins/stores/`，所以它留在 `domain/plugins/` 而不是这里 ——
判据不是"用了几次"，而是"**它属不属于某个领域**"。
真正无领域归属的（窗口按钮、进度条、背景、遮罩）才在这里。
