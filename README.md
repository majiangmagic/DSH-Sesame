# DSH-Sesame

dsh 的桌面启动器：用 Electron + Vue 3 + TypeScript 写的图形界面。
负责管理 dsh 的版本、启动与停止进程、插件的安装与开关、以及运行日志。

> 文档与冻结参考件**刻意放在仓库外**（`D:\agent\DSH-Sesame-docs`），让仓库保持精简。

## 技术栈

| | |
| --- | --- |
| 运行时 | Electron 44（无边框窗口 + 托盘） |
| 界面 | Vue 3.5 · vue-router 5（hash）· Pinia 4 · vue-i18n 11 |
| 构建 | electron-vite 5 · Vite 7 · TypeScript 5.9 |
| 打包 | electron-builder 26（NSIS 安装包 + 便携版，x64） |

## 内置的插件市场库

插件页的市场功能不是自己实现的，而是把 **`dshmarket` 当库调用**（它的 `lib/` 是纯 Node 库，
0 处依赖 `@deepseek-ai/*`，所以能在启动器主进程里跑，**不需要 dsh 在跑**）。

它锁死在 `package.json` 的 `dependencies` 里，实际位置是 `node_modules/dshmarket`。

⚠️ **我们依赖的是它没有稳定性承诺的内部 API。** 所以在发布前、或隔一段时间，跑一次：

```powershell
npm run check:market
```

它会报告内置版本、注册表最新版、市场判定的更新目标，以及**我们依赖的内部导出是否还齐全**
（缺了就说明市场改了内部 API，对应功能必须降级）。

完整说明、风险表、更新步骤与"发布冷却"的实测发现见
`D:\agent\DSH-Sesame-docs\market-dependency.md`（在仓库外，所以不是可点的相对链接）。

## 命令

```sh
npm run dev          # 开发模式（Vite HMR + Electron）
npm run build        # 只构建到 out/（main / preload / renderer 三段）
npm run typecheck    # tsc（主进程）+ vue-tsc（渲染层）
npm run pack         # 构建 + 打免安装目录（…\DSH-Sesame-release\_stage\win-unpacked）
npm run dist         # 构建 + 出安装包（暂存在 …\DSH-Sesame-release\_stage）
npm run release      # dist + 校验后把安装包提到 D:\agent\DSH-Sesame-release 顶层
```

首次安装依赖前注意：npm 11 默认拦截生命周期脚本，Electron 的二进制不会下载。
若 `node_modules/electron/dist/electron.exe` 不存在，执行 `npm approve-scripts electron` 后
`npm rebuild electron`；esbuild / electron-winstaller 同理。

国内网络下 electron 与 electron-builder 的二进制走 .npmrc 里配置的 npmmirror 镜像；
若换机器后 electron-builder 下载 NSIS 失败，设置环境变量：

```sh
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

> **便携版 / 安装包启动失败先看磁盘空间。**
> 这两者都是自解压程序，运行时要往 `%TEMP%`（默认在 C 盘）解出约 300 MB 再启动。
> C 盘空间不足时表现为**双击毫无反应、退出码 1、解包目录里始终没有主程序**，
> 而此时 `release/win-unpacked/DSH-Sesame.exe` 是能正常跑的 —— 看着像打包坏了，其实是空间不够。
> 验证时把 `TEMP` / `TMP` 指到大盘即可：
>
> ```powershell
> $env:TEMP='D:\some\big\dir'; $env:TMP=$env:TEMP
> .\DSH-Sesame-0.1.0-portable.exe
> ```

## 目录结构

```
src/
├─ main/          Electron 主进程：窗口壳 + 托盘 + 自定义协议
│   ├─ index.ts     生命周期、单实例锁、托盘
│   ├─ window.ts    无边框窗口 + 窗口控制 IPC
│   ├─ tray.ts      常驻托盘
│   └─ protocol.ts  app:// 协议（替代 file://，原因见下）
├─ preload/       contextBridge 暴露 window.sesame（目前只有窗口壳能力）
├─ shared/        主进程与渲染层共用的通道名
└─ renderer/
    ├─ public/    原样 URL 的静态资源（mascot/、背景图、图标、两个原生脚本）
    └─ src/
        ├─ api/       ★ 接口层：contract.ts（只有类型）+ mock.ts（假数据）
        ├─ assets/styles/  tokens → base → components → app-mount → mascot
        ├─ components/     通用组件 + overlays/ 三个遮罩
        ├─ layouts/        AppShell（顶栏 + 页面容器）
        ├─ views/          四个 tab 各一个
        ├─ stores/         Pinia（只放界面状态）
        └─ i18n/           中英文案
（文档与冻结参考件在仓库外：`D:\agent\DSH-Sesame-docs\`
   migration-map.md       移植对照表与状态
   market-dependency.md   内置市场库的依赖说明与风险
   reference/             冻结的参考快照、抽取文档、对照截图）
```

## 几条必须知道的架构约定

**1. 逻辑全部收口在 `src/renderer/src/api/`。** 页面只 `import { api } from '@/api'`，
从不直接 `fetch` / `ipcRenderer`。现在 `api/index.ts` 导出 mock 实现；接逻辑时只换这一行导出，
组件一行不用改。契约字段是逐个核对原 `server.js` 抄出来的，不是凭空设计。

**2. 样式三层 + 两个适配文件，不写进组件里。** `tokens.css` 定变量、`base.css` 放全局与元素级
规则、`components.css` 放组件规则，三者逐字符照搬原版（postcss 复核过 206 规则 / 703 声明）。
新增的只有 `app-mount.css`（Vue 挂载点 + Electron 窗口适配）。组件里只用 `var(--accent)`
这类令牌，不出现裸色值。

**3. `mascot.css` 必须最后加载。** 它含 `header, main { z-index: 3 }`，靠**顺序**压过
`components.css` 的 `z-index: 1`，从而把卡片放在看板娘（`z-index: 2`）之上。Vite 会把打包 CSS
插到 `<head>` 末尾，所以它用 import 而不是 `<link>` —— 顺序反了看板娘就会盖住卡片。

**4. 渲染层走自定义协议 `app://bundle`，不是 `file://`。** 原版前端引用资源写死了绝对路径
（`url("/background-character.png")`、`<image href="/mascot/base.png">`），`file://` 下会被解析成
磁盘根目录而 404。自定义协议让 `/x` 等于产物根下的 x，原版路径一个字都不用改。

**5. 两个原生脚本在挂载后注入。** `water.js` 上来就查 `.water-surface`，`mascot.js` 出错时要读
`.backdrop-character`；用 `<script defer>` 会赶在 Vue 渲染之前跑掉，所以由
`BackdropLayer.vue` 在 `onMounted` 里按顺序注入。

## 本阶段范围

已完成：原版四个页面与三个遮罩、无边框窗口壳与托盘、窗口壳 IPC、界面所需的中英文案、
mock 数据层、打包与发布链路。

**DSH-Sesame 在原版基础上新增的部分**（不是复刻，见 `D:\agent\DSH-Sesame-docs\migration-map.md` 第七节）：

- **「版本」标签页**（导航第 5 项）：已安装版本列表（版本号 / 装法 / 运行状态 / 卸载）
  与可下载版本列表（下载）；运行中的版本不允许卸载，与原版 `removeEl.hidden` 判据一致。
- **控制页**：版本下拉**只列已安装的版本**；下方新增「插件开关」卡片，与插件页共用
  同一个 store，任一页改动另一页立刻同步。**插件页本身结构未变。**
- **启动/停止/重启/更新**已接到 `stores/versions.ts`：启动有 `starting → running` 中间态，
  提示行会显示「正在启动…」，主按钮转圈并禁用。

这些动作目前全部由 `api/mock.ts` 的**有状态假数据**驱动（下载会真的进已装列表、启动会
产生假地址），所以交互可以完整验收；接真实逻辑时只换 `api/index.ts` 的导出。

未做（有意）：原 `index.html` 第 924–2276 行的业务逻辑本身 —— 真实的进程管理、pnpm 调用、
SSE 进度、终端流、设置落盘。逐项状态见 `D:\agent\DSH-Sesame-docs\migration-map.md`。

## 预览遮罩

三个遮罩没有逻辑驱动，用路由 query 预览：

```
#/home?overlay=ask     更新询问
#/home?overlay=notice  操作失败
#/home?overlay=gone    已退出
```
