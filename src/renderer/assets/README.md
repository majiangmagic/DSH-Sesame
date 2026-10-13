# renderer/assets

前端静态样式资源。

| 路径 | 作用 |
| --- | --- |
| [styles/](styles/) | 5 个分层 CSS |

## 为什么样式放在 assets/ 而不是跟组件放一起

样式是**分层覆盖**的（tokens → base → components → app-mount → custom），
不是按组件切分的 —— 放在这里能一眼看出覆盖顺序。
如果哪天改成组件级 scoped 样式，那才是把它拆到各组件旁边的时候。

## 导入顺序在 `main.ts`

顺序由 [../main.ts](../main.ts) 的 import 顺序决定，且**有语义**（见 styles/README.md）。
