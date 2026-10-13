# main

主进程。**唯一持有系统能力的地方** —— 渲染层没有 Node，要什么都得经过这里。

## 放什么

| 目录 | 职责 | 判据 |
| --- | --- | --- |
| [ipc/](ipc/) | **怎么被调用** —— 全部通道注册 | 只做参数校验、进度转发、错误包装 |
| [domain/](domain/) | **做什么** —— 业务逻辑 | 目录名 = 界面上的标签页（正好 6 个） |
| [infrastructure/](infrastructure/) | **靠什么做** —— 文件、进程、网络、Electron 壳 | 被 ≥2 个领域用，且不含策略 |
| [api/](api/) | 给**外部程序**用的接口 | 当前为空，见那里的 README |
| `index.ts` | 装配点 | 只调初始化顺序 + 管生命周期 |

## 依赖方向

    index ──> ipc ──> domain ──> infrastructure

- `ipc` 可以调 `domain` 与 `infrastructure`；
- `domain` 可以调 `infrastructure`，**不许**调 `ipc` / `api`（方向反了）；
- `infrastructure` **不许**调 `domain` / `ipc` / `api` ——
  **有 1 处已知例外**：`infrastructure/imageProxy.ts` → `domain/plugins/market.ts`
  （图片代理要用市场的区域路由配置；理由与两种改法见 [infrastructure/README.md](infrastructure/README.md)）；
- `domain` 之间允许依赖，但**绝不许成环** —— 环会让人"只想改一处，却被迫理解整条链"。

当前 9 条领域间依赖边（`npm run check:graph -- --list` 可随时列出）。

## 为什么 IPC 集中在 ipc/ 而不是散在各 domain

一个领域目录里同时装"业务逻辑"和"通信适配"时，"这个文件属于哪一层"就变含糊了。
分开之后分工是死的：

    domain/          改一个功能的**行为**时进这里
    ipc/             改一个功能的**接口**时进这里
    infrastructure/  改"怎么读文件/起进程/发请求"时进这里

另外，全部通道注册集中在一处，想知道"这个应用对外暴露了什么"不用翻 6 个目录。

## 加一个新标签页

1. `domain/<标签页>/` 写业务逻辑；
2. `ipc/<标签页>.ts` 导出 `register<标签页>Ipc()`，在 `ipc/index.ts` 加一行；
3. 通道名加到 `@shared/constants/channels`，推送载荷（如有）加到 `@shared/types/events`；
4. 共享模型加到 `@shared/types/`；
5. 渲染层侧建 `renderer/domain/<标签页>/`，加路由与 `nav.*` 文案。

**不用改任何已有领域。**
