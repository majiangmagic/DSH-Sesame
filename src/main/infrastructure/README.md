# main/infrastructure

**靠什么做** —— 文件系统、外部进程、网络、Electron 壳。
这里没有业务策略，只有机制。

| 文件 | 作用 | 谁在用 |
| --- | --- | --- |
| [boot.ts](boot.ts) | **启动原语**：`bootArgs` / `envFor` / `killTree` / `READY_RE` | control、control/diagnose |
| [paths.ts](paths.ts) | 数据根目录、版本池路径、旧数据迁移 | 5 个领域 |
| [runtime.ts](runtime.ts) | 解析真正的 `node.exe`（`SESAME_NODE` → PATH → 包内自带） | control、plugins、diagnose |
| [dshHome.ts](dshHome.ts) | `~/.dsh` 与 profile 目录 | 6 个模块 |
| [settings.ts](settings.ts) | 启动器设置的**原始读写**（JSON 文件、开机自启） | 7 个模块 |
| [registry.ts](registry.ts) | npm registry 客户端（拉 dsh 的 packument） | versions、plugins |
| [textDecode.ts](textDecode.ts) | 子进程输出解码（UTF-8 解不通退 GBK） | 5 个模块 |
| [window.ts](window.ts) | 主窗口的创建 / 唤起 / 单例状态 | index、ipc/window |
| [tray.ts](tray.ts) | 托盘图标与菜单 | index |
| [protocol.ts](protocol.ts) | 自定义协议 `app://bundle` 的注册与静态服务 | index、window |
| [imageProxy.ts](imageProxy.ts) | 远端图片代理 `/__img/?u=…` | protocol |

## 放进来的两条判据

1. **被 ≥2 个领域使用**。`settings` 被 7 个模块读、`paths` 被 5 个领域用 ——
   它们要是待在某个 `domain/` 里，其他领域就得跨领域 import。
2. **不承载策略**。`boot.ts` 是最好的例子：它只回答"参数怎么拼、环境变量怎么设、
   进程树怎么杀"，不回答"该不该启动、启动失败怎么办"。后者在
   `domain/control/runner.ts`。

## 一条实际的分界线：设置为什么留在这里

设置页的**校验与落盘编排**在 `domain/settings/apply.ts`，但**原始读写留在这里**。
原因不是"懒得搬"：`paths.ts` 与 `dshHome.ts` 都是文件系统层却要读设置
（版本池位置、DSH_HOME）。设置一旦搬进 domain，这两处就变成
**infrastructure → domain 的反向依赖**，而这一层是不许依赖 domain 的。

所以界线是：**机制留 infrastructure，策略放 domain。**
同理 `textDecode` 不能进 `utils/`（它用 `Buffer`，会把 Node 全局泄漏进渲染层）。

## ⚠️ 已知的分层例外

`imageProxy.ts` → `domain/plugins/market.ts`：**infrastructure 依赖 domain**，
按规则这是越界。保留它是因为：

- 它需要市场的**区域路由配置**（`regions.githubRoutesFor` / `activeRegion`）——
  目录里的截图全指向 `raw.githubusercontent.com`，**实测国内直连不通**，必须按市场配置改写；
- 两种改法都不划算：(a) 把 `imageProxy` 挪进 `domain/plugins/` ——
  越界边数不变，只是从"图片代理伸手进 domain"变成"协议层挂载 domain 的服务"；
  (b) 在 infrastructure 加一个注册钩子让 market 反向注入路由 —— 会引入
  **运行时注册顺序**耦合，比一条静态依赖更难读。

**当前选择：如实记录，不强行消除。** 这是全仓库唯一一处分层越界，
已登记在 `scripts/check-import-graph.mjs` 的 `ALLOWED` 里。

## `boot.ts` 的额外作用：断环

它同时解决了 `runner → sync → diagnose → runner` 这个环 —— 详见 [boot.ts](boot.ts) 顶部注释。
判断一个机制该不该进这一层时，"它是否让某个领域能脱离另一个领域"也是一条理由。
