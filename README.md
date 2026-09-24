# DSH-Sesame

dsh 的桌面启动器（Electron + Vue 3 + TypeScript）：管理 dsh 版本、启停进程、安装与开关插件、查看运行日志。

## 构建成品

```powershell
cd <项目目录>
npm run dist && node scripts/publish-release.mjs
```

等价于 `npm run release`。成品落在**与本项目平级的** `DSH-Sesame-release\`（用环境变量 `SESAME_RELEASE_DIR` 可改到别处）：
`DSH-Sesame-Setup-<版本>.exe` 及其 `.blockmap`、`latest.yml`（后两者由 electron-builder 自动生成）。

**为什么分两步**：electron-builder 先写进 `_stage\`，`publish-release.mjs` 确认构建完整（安装包非空）才提到顶层 —— 这样失败的构建不会在发布目录里留下看起来正常的半成品。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（Vite HMR + Electron） |
| `npm run build` | 只编译到 `compiled/`（main / preload / renderer） |
| `npm run typecheck` | tsc（主进程）+ vue-tsc（渲染层） |
| `npm run pack` | 只出免安装目录 `<发布目录>\_stage\win-unpacked` |
| `npm run dist` | 出安装包到 `_stage\`（不发布） |
| `npm run release` | = `dist` + 把产物提到顶层 |
| `npm run check:market` | 检查内置市场库（dshmarket）被依赖的内部 API 是否还在 |

## 环境上的三个坑

1. **npm 11 默认拦截生命周期脚本**，Electron 的二进制不会下载。若 `node_modules/electron/dist/electron.exe` 不存在，执行 `npm approve-scripts electron` 后 `npm rebuild electron`（esbuild 同理）。
2. **国内网络**：electron 与 electron-builder 的二进制走 `.npmrc` 里配置的 npmmirror 镜像。换机器后若下载 NSIS 失败，设置环境变量：
   `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`


## 几条必须知道的架构约定

- **系统能力只在 `src/main/`。** 渲染层没有 Node、也没有网络：要显示远端图片必须经主进程代理（页面里写同源的 `/__img/?u=<编码后的 URL>`）。
- **页面只 `import { api } from '@/api'`**，从不直接 `fetch` / `ipcRenderer`。契约（只有类型）在 `src/renderer/src/api/contract.ts`。
- **通道名只在 `src/shared/ipc.ts` 定义一次**，主进程与 preload 各注册一次。
- **`electron-vite` 的 outDir 必须留在项目内**（原因见 `electron.vite.config.ts` 顶部注释）。
- **插件与数据按 profile 隔离、不按 dsh 版本隔离** —— 所有 dsh 版本共用 `~/.dsh/profiles/<name>`。
- **启动需要真正的 `node.exe`**：不能用 Electron 自带的（dsh 的加载器会拒绝它的 V8 指纹）。解析顺序见 `src/main/runtime.ts`。

