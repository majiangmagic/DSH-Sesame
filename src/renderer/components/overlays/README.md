# renderer/components/overlays

三个遮罩层。显隐状态在 [../../stores/overlay.ts](../../stores/overlay.ts)，
由 `App.vue` 按路由 query 驱动（`#/control?overlay=notice` 可以单独预览某个遮罩，
方便校对样式）。

| 文件 | 作用 | 语义 |
| --- | --- | --- |
| `AskOverlay.vue` | 询问 | 需要用户做选择 |
| `NoticeOverlay.vue` | 通知 | **模态**（`role=alertdialog`），适合"操作失败"，必须点"确定" |
| `GoneOverlay.vue` | 失效 | 目标已不存在 |

## 与轻提示气泡的区别是刻意的

[../../stores/bubble.ts](../../stores/bubble.ts) 那个气泡是**非模态**的：
自动消失、不拦操作，适合"发生了你该知道、但不需要你点确定"的事（例如端口自动回退）。
端口回退不是失败，弹模态会打断人。
