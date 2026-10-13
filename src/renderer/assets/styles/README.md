# renderer/assets/styles

5 个分层 CSS。**导入顺序是有语义的**，由 [../../main.ts](../../main.ts) 的 import 顺序决定。

| 文件 | 作用 |
| --- | --- |
| `tokens.css` | `:root` 变量（颜色、间距、时长） |
| `base.css` | 全局重置与元素级规则 |
| `components.css` | 组件规则（引用 tokens） |
| `app-mount.css` | 挂载点与 Electron 无边框窗口的适配 |
| `custom.css` | **必须最后**（原因见下） |

## 为什么 `custom.css` 必须收尾

它里面有 `header, main { z-index: 3 }` 与
`main, .page { pointer-events: none }` / `.page > * { pointer-events: auto }`：

- 前者要把卡片压在各背景层（看板娘、背景图）之上；
- 后者要让页面容器**透传**鼠标事件、只有直接子元素可交互
  （否则 `.page` 会盖住 `PatCompanion`，摸头点不到）。

这两组都必须排在 `components.css` **之后**才生效。
Vite 会把打包 CSS 插到 head 末尾，所以用 `<link>` 反而会被压过 —— 只能用 import 收尾。

## 改动这里的验证方式

`npm run build` 之后看 `compiled/renderer/assets/index-<hash>.css` 的**哈希有没有变**：
纯重组（搬文件、改 import）不该让 CSS 哈希变化 —— 变了就说明动了样式或顺序。
