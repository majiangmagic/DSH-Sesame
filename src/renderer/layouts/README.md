# renderer/layouts

**页面整体布局** —— 包住路由视图的外壳。

| 文件 | 作用 |
| --- | --- |
| `AppShell.vue` | 顶栏（logo + 版本号 + tab 导航 + 窗口按钮）+ 页面容器 + 轻提示气泡 |

## 三处"与原版脚本等价但必须重写"的交互

1. **tab 切换**：原版靠 `data-tab` + 显示/隐藏 `.page`，这里交给 vue-router；
2. **胶囊指示器**：原版把 `--tab-x` / `--tab-width` 写到 nav 上，让 `nav::before` 滑过去
   —— 这里在路由变化后 `nextTick` 重算（字体加载完还要再算一次，否则按钮宽度变了会停偏）；
3. **页面进入动画**：原版按 tab 顺序加 `view-enter-next` / `view-enter-prev`。

## `TABS` 是路由与标签页的唯一对应表

`path` 与 `label` 三处同名（见 [../router/](../router/)）：

    { path: '/terminal', label: 'nav.terminal' }

## 端口回退提示在这里

气泡挂在 header 之后，任何页面都能看到。检测方式是**不新增 IPC**：
就绪地址里带着真实端口，和设置里的端口一比就知道有没有回退。
每次读设置都重新读（端口可以在设置页改），且每个地址只提示一次。
