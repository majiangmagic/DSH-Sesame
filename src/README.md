# src

DSH-Sesame 的全部源码。**Electron 三进程 + 两个中立层**：

| 目录 | 运行环境 | 职责 |
| --- | --- | --- |
| [main/](main/) | Node | 主进程。唯一持有系统能力的地方 |
| [preload/](preload/) | Node（受限） | 唯一出入口，把主进程能力挂到 `window.sesame` |
| [renderer/](renderer/) | Chromium | 界面（Vue 3）。**没有 Node、没有网络** |
| [shared/](shared/) | 纯类型 | 三方共用的契约：类型、常量、校验 |
| [utils/](utils/) | 纯函数 | 不用 Node / DOM / Electron，任何层都能引用 |

## main 的三层

    main/
      ipc/              怎么被渲染层调用（全部通道注册集中在这里）
      domain/           做什么 —— 目录名严格等于界面上的 6 个标签页
      infrastructure/   靠什么做（文件、进程、网络、Electron 壳）
      api/              给**外部程序**用的接口（当前为空，见那里的 README）
      index.ts          装配点

依赖方向是单向的：`index → ipc → domain → infrastructure`，
且 `shared` / `utils` 是被所有层引用的叶子。

## 为什么 `shared` 与 `utils` 必须独立在顶层

两个 tsconfig 是**按层** include 的：

- `tsconfig.node.json` → `main/` `preload/` `shared/` `utils/`
- `tsconfig.web.json` → `renderer/` `preload/types.ts` `shared/` `utils/`

把共享类型塞进 `main/` 会让渲染层为了拿一个 `PluginEntry` 而 include 整个主进程目录 ——
那个目录里有 `node:fs`、`node:child_process`，而渲染层的 lib 里没有 node 类型，
**编译立刻失败**。所以"三方共用的东西"必须有一个不属于任何进程层的中立位置。

## domain 的目录名 = 界面上的 6 个标签页

控制 `control` · 版本 `versions` · 插件 `plugins` · 终端 `terminal` · 快照 `snapshots` · 设置 `settings`

`main/domain/` 与 `renderer/domain/` 下**正好是这 6 个名字**，路由与 `nav.*` 文案同名。
`diagnose` 与 `market` 不是第 7、第 8 个领域 —— 它们没有自己的标签页，
分别在 `control/`（「检查」按钮）与 `plugins/`（市场界面在插件页里）。

## 自检

改完目录结构后跑这三条：

    npm run typecheck     # 两个 tsconfig 都过
    npm run check:graph   # 循环依赖 + 分层越界
    npm run build         # 真能打包

`check:graph`（`scripts/check-import-graph.mjs`）是**唯一能强制分层规则的东西** ——
tsc 与 vite 都不管依赖方向。`pack` / `dist` 也会先跑它。
