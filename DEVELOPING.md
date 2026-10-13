# DSH-Sesame

dsh 的桌面启动器（Electron + Vue 3 + TypeScript）：管理 dsh 版本、启停进程、安装与开关插件、查看运行日志。

## 构建成品

```powershell
cd <项目目录>
npm run release
```

它等于 `node scripts/bundle-node.mjs && npm run dist && node scripts/publish-release.mjs`，分三步是有意的：

- **`node scripts/bundle-node.mjs`** —— 把当前这个 `node.exe` 拷进 `node-bundle/node/`，供打包时内置
  （`node-bundle/` 不入库；88 MB 的二进制不该进 git）。单独跑用 `npm run bundle:node`

- **`npm run dist`** —— typecheck + 编译 + electron-builder 打包，产物先写进**暂存目录**（不直接进顶层）
- **`node scripts/publish-release.mjs`** —— 确认构建完整（安装包非空）之后，才把产物提到顶层并删掉暂存目录

**为什么要分两步**：失败的构建会在暂存目录里留下看起来正常的半成品；先暂存、校验后再提，发布目录里就只会有完整的产物。

成品位置由 `electron-builder.yml` 的 `output:` 决定（默认是**与本项目平级**的 `DSH-Sesame-release\`）—— 发布脚本会读它，所以**只有那一处定义**；想换位置就改这一行。产物是 `DSH-Sesame-Setup-<版本>.exe` 及其 `.blockmap`、`latest.yml`（后两者由 electron-builder 自动生成）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（Vite HMR + Electron） |
| `npm run build` | 只编译到 `compiled/`（main / preload / renderer） |
| `npm run typecheck` | tsc（主进程）+ vue-tsc（渲染层） |
| `npm run check:graph` | 导入图自检：循环依赖 + 分层越界（加 `-- --list` 可列出全部领域间依赖边） |
| `npm run check:mirror` | 打印桌面端 profile 与 web profile 的**插件差异**（启动桌面端时**无条件**把桌面端重建为 web 的样子） |
| `npm run pack` | 只出免安装目录 `<发布目录>\_stage\win-unpacked` |
| `npm run dist` | 出安装包到 `_stage\`（不发布） |
| `npm run release` | = `dist` + 把产物提到顶层 |
| `npm run check:market` | 检查内置市场库（dshmarket）被依赖的内部 API 是否还在，并报版本差 |
| `npm run smoke:market` | **真调一次**市场库（拉目录、读 profile），断言返回结构没变 —— 需要网络 |
| `npm run check:update` | 拿 GitHub 上**真实的** `latest.yml` 验证启动器更新链路（解析 / 资产存在 / 版本比较） |

`pack` / `dist` 都会先跑 `typecheck` 与 `check:graph` —— 依赖方向错了就别想打出包来。

`check:mirror`、`check:update` 需要 **Node ≥ 22.6**（靠 Node 的类型剥离直接 import `.ts`，
为的是复用真实逻辑而不是复制一份）。

`check:update` 加 `--file <路径>` 可解析本地文件（网络受限时用系统栈抓下来再喂给它）；
加 `--tag v0.1.4` 可验历史版本。

## 环境上的三个坑

1. **npm 11 默认拦截生命周期脚本**，Electron 的二进制不会下载。若 `node_modules/electron/dist/electron.exe` 不存在，执行 `npm approve-scripts electron` 后 `npm rebuild electron`（esbuild 同理）。
2. **国内网络**：electron 与 electron-builder 的二进制走 `.npmrc` 里配置的 npmmirror 镜像。换机器后若下载 NSIS 失败，设置环境变量：
   `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`


## 目录结构

`src/` 下五个顶层目录：`main/`（Node，唯一持有系统能力）、`preload/`（出入口）、
`renderer/`（Chromium，界面）、`shared/`（三方共用的类型/常量/校验）、`utils/`（纯函数）。

**每个目录都有一份 `README.md`**，写它的职责、放什么、以及那个目录特有的约定与坑。
从 [`src/README.md`](src/README.md) 进去，或直接看 [`src/main/README.md`](src/main/README.md)。

主进程分三层，依赖方向单向：

    main/
      ipc/              怎么被渲染层调用（全部通道注册集中在这里）
      domain/           做什么 —— 目录名严格等于界面上的 6 个标签页
      infrastructure/   靠什么做（文件、进程、网络、Electron 壳）
      api/              给外部程序用的接口（当前为空，见那里的 README）
      index.ts          装配点

渲染层侧与 `domain/` 同名同数：

    renderer/
      domain/           6 个标签页的页面 + 专属组件 / store
      components/       跨页复用的 UI 组件
      layouts/ router/ stores/ i18n/
      api/              页面唯一的数据入口
      assets/ public/   index.html

**`domain/` 的目录名严格等于界面上的 6 个标签页**，一个目录对一个页面：

| 标签页 | 目录 | 路由 | i18n 区块 |
| --- | --- | --- | --- |
| 控制 | `domain/control/` | `/control` | `control.` |
| 版本 | `domain/versions/` | `/versions` | `versions.` |
| 插件 | `domain/plugins/` | `/plugins` | `plugins.` |
| 终端 | `domain/terminal/` | `/terminal` | `terminal.` |
| 快照 | `domain/snapshots/` | `/snapshots` | `snapshots.` |
| 设置 | `domain/settings/` | `/settings` | `settings.` |

**正好 6 个，没有第 7 个。** 判据是"有没有自己的标签页"：诊断没有（入口是控制页上的
「检查」按钮），所以它是 `domain/control/diagnose.ts`；市场没有（界面就在插件页里），
所以它在 `domain/plugins/market.ts`。

四处同名（**标签页文案 / 路由 / 目录 / i18n 区块**）是刻意的：从任何一个入口都能直接找到
另外三个。改名时四处一起改 —— 只改内容不改目录名，就会出现"代码在 `logs/` 里，
界面上写的是「终端」"这种对不上的情况。

## 几条必须知道的架构约定

- **系统能力只在 `src/main/`。** 渲染层没有 Node、也没有网络：要显示远端图片必须经主进程代理（页面里写同源的 `/__img/?u=<编码后的 URL>`）。
- **页面只 `import { api } from '@/api'`**，从不直接 `fetch` / `ipcRenderer` / `window.sesame`。契约（只有类型）在 `src/renderer/api/contract.ts`。
- **通道名只在 `src/shared/constants/channels.ts` 定义一次**，主进程与 preload 各注册一次。推送载荷在 `src/shared/types/events.ts`。
- **`domain/` 的目录名 = 界面上的标签页名**（正好 6 个），路由与 `nav.*` 文案同名。通道名**不**跟着目录改名 —— 它是线上协议（所以 `domain/terminal/` 下的通道仍叫 `log:*`）。
- **依赖方向**：`main/index → ipc → domain → infrastructure`；`infrastructure` 不许依赖 `domain`/`ipc`/`api`，`domain` 不许依赖 `ipc`/`api`；`shared` 与 `utils` 是叶子，不许反向依赖。`domain` 之间允许依赖，但**绝不许成环**。
- **`electron-vite` 的 outDir 必须留在项目内**（原因见 `electron.vite.config.ts` 顶部注释）。
- **插件与数据按 profile 隔离、不按 dsh 版本隔离** —— 所有 dsh 版本共用 `~/.dsh/profiles/<name>`。
- **启动需要真正的 `node.exe`**：不能用 Electron 自带的（dsh 的加载器会拒绝它的 V8 指纹）。解析顺序见 `src/main/infrastructure/runtime.ts`。

## 还缺什么（已知缺口，按重要性排）

1. **没有任何自动化测试。** devDependencies 里没有 vitest / jest，`src/` 约 1.1 万行、
   涉及下载、解压 NSIS、杀进程树、文件回滚，全靠人工验证。这是当前最大的风险 ——
   目录摆得再整齐也替代不了它。
   最好测的纯函数（无 IO、无 Electron）：`utils/version.ts` 的 `parseVer` / `cmpVer`、
   `shared/schemas/settings.ts` 的 `normalizeSettingsPatch`、
   `infrastructure/settings.ts` 的 `splitArgs`、
   `domain/plugins/pluginState.ts` 的 yml 开关逻辑、
   `domain/snapshots/snapshot.ts` 的指纹与预演、`infrastructure/paths.ts` 的迁移判定、
   `domain/control/diagnose.ts` 的输出解析。
2. **没有 lint / 格式化强制。** 只有 `.editorconfig` 和 tsconfig 的
   `strict` + `noUnusedLocals`。`main/domain/plugins/market.ts` 里有一条
   `/* eslint-disable @typescript-eslint/no-explicit-any */` —— 说明曾经打算上 eslint。
3. **分层边界只有部分强制。** 循环依赖与五类越界（renderer→main、shared/utils→上层、
   infrastructure→domain/ipc/api、domain→ipc/api）现在由 `npm run check:graph` 检查，
   `pack` / `dist` 会跑它。但它只覆盖这几条 —— 更细的规则
   （比如"某个领域不许依赖另一个领域"）还没有。
   想全面接管可以上 `eslint-plugin-boundaries` 或 `dependency-cruiser`；
   当前那颗脚本刻意零依赖，因为这点检查不值得加一条依赖链。
4. **类型契约是手工镜像的。** `renderer/api/contract.ts` 的 `ManagerApi` 与
   `preload/index.ts` 暴露的能力面各写一遍，`api/index.ts` 的
   `api: ManagerApi = realApi` 只保证 `real` 实现了 `contract`，
   **不保证 contract 覆盖了 preload 的全部能力**。改法：让 contract 从 preload 的
   `SesameApi` 推导。同理 `shared/types/settings.ts` 与 `infrastructure/settings.ts` 的
   `LauncherSettings` 也是手工同步的。
5. **一处已知的分层越界**：`main/infrastructure/imageProxy.ts` → `main/domain/plugins/market.ts`。
   保留的理由与两种改法见 [`src/main/infrastructure/README.md`](src/main/infrastructure/README.md)。
6. **IPC 错误协议不统一。** Electron 的 `invoke` reject 会被包上
   `Error invoking remote method '…'` 前缀，渲染层各处 `catch` 各自处理消息。
7. **`main/domain` 内部还有互指**：`control ↔ plugins`（经不同文件，故不成环，
   但边界不够干净）。想彻底拆开得把 `control/diagnose.ts` 里"读插件清单"那部分
   下沉到 infrastructure。
8. **`main/api/` 是空的。** 目标结构里留了这个位置（给外部程序调用的接口），
   但项目至今没有对外接口。见 [`src/main/api/README.md`](src/main/api/README.md)。


