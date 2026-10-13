# renderer/stores

**跨页的全局状态**（Pinia）。三个文件，一个关注点一个。

| 文件 | store | 谁在用 |
| --- | --- | --- |
| `overlay.ts` | `useOverlayStore` | `App.vue`（按路由 query 驱动）+ 三个遮罩组件 |
| `bubble.ts` | `useBubbleStore` | `AppShell`（显示）、控制页 / 快照管理（弹） |
| `locale.ts` | `useLocaleStore` | 设置页（切换）、i18n 实例（消费） |

## 判据：什么该放这里

**被 ≥2 个页面用，且不属于某个领域。** 三个都符合：

- `overlay` —— 根组件驱动、三个遮罩消费；
- `bubble` —— 挂在 `AppShell` 上，任何页面都能弹（端口回退发生在"启动"那一刻，
  而那时用户可能已经切到别的标签页了）；
- `locale` —— 改的是全局 i18n 实例与 `document.documentElement.lang`，
  设置页只是它的**编辑入口**（所以不放在 `domain/settings/`，
  否则"改语言"会显得像设置页的私事，而实际上每个页面都在消费它）。

## 只服务某一个页面的 store 不在这里

它们在那个页面的目录下：`domain/versions/stores/versions.ts`、
`domain/plugins/stores/{plugins,market}.ts`。

## 这三个 store 原先是一个文件

它们曾经都挤在 `stores/ui.ts` 里。问题是那个文件里的三个 ref **各自指向不同的归属**
（`overlay` 是应用级、`locale` 只有设置页用、`bubble` 跨页），
于是"这个文件该放哪个目录"没有唯一答案 —— 放哪儿都只对三分之一。

拆开后每个都有唯一归属。**这是一条可检验的标准**：随便挑一个文件，
两个人都应该能独立说出它该进哪个目录。

## 业务数据不放这里

版本、插件、设置都走 [../api/](../api/) 层。
这里只放"界面自己的状态"。
