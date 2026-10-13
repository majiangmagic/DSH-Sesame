# main/domain/settings

**设置页**（标签页「设置」，`/settings`）的写入策略，以及**启动器自己的更新**。

| 文件 | 作用 |
| --- | --- |
| `apply.ts` | `applySettingsPatch()` —— 校验载荷 → 落盘 → 记日志 |
| `update.ts` | 检查 GitHub Releases → 下载 → 校验 sha512 → 静默安装 → 退出 |
| `updateMeta.ts` | `latest.yml` 解析 + 仓库坐标识别（**纯函数，不依赖 Electron**） |

IPC 在 [../../ipc/settings.ts](../../ipc/settings.ts)。
**设置的原始读写不在这里**，在 [../../infrastructure/settings.ts](../../infrastructure/settings.ts)。

## 启动器自己的更新

入口是设置页上的按钮。数据源是**本仓库的 GitHub Releases** ——
`scripts/publish-release.mjs` 每次发版都会把 `DSH-Sesame-Setup-<版本>.exe` 与
`latest.yml`（electron-builder 生成）一起传上去，所以**不需要额外服务端**。

流程：读 `latest.yml` → 比版本（用 `@utils/version`，不信任何"latest"字面）
→ 下载 → 校验 sha512 → `Setup.exe /S --updated --force-run` → 应用退出、安装器重启它。

### 三个标志都核对过 electron-builder 的 NSIS 模板，不是猜的

| 标志 | 作用 |
| --- | --- |
| `/S` | NSIS 的静默开关 |
| `--updated` | 按"这是升级"处理：**跳过所有页面**，且**不删用户数据**（`installUtil.nsh` 明确"总是传它以保证不删数据"） |
| `--force-run` | 装完自动重启应用。assisted 安装器只在**静默**时才看它，而我们正好是静默 |

白名单来自 `NsisTarget.js` 的 `flags([...])`；`nsisScriptGenerator.js` 里那句
`// without -- !!!` 说明命令行形式是 `--updated` 而不是 `-updated`。
写成 `--force-run 1` 这种带值的写法**不会被识别**。

### 为什么不用 electron-updater

它能做这件事，但会带来一条依赖链，而且它的下载走 Node 的 undici —— 那**不认系统代理、
也不认 Windows 证书库**。实测过同类问题：挂了代理 / TUN 做 TLS 中间人的机器上会以
`fetch failed` / `UND_ERR_CONNECT_TIMEOUT` 收场且不给原因。
这里用 Electron 的 `net`（Chromium 网络栈），与下载桌面端同一套
（`domain/control/desktop.ts` 有同样结论的详细记录）。

### 只在本机、只在打包后

`app.isPackaged` 为 false 时（`npm run dev`）**拒绝自更新** ——
那会把开发目录搅坏。检查更新仍然可用，只是提示不可安装。

### `updateMeta.ts` 为什么单独一个文件

它是整条链上**唯一会静默坏掉**的一环：electron-builder 改了输出格式、或者解析正则写错，
表现是"检查更新永远失败"或"下载了错的包" —— 而这两件事在类型层面完全看不出来
（解析结果全是 string）。

所以它**不 import 任何东西**，好让 `scripts/check-update.mjs`（`npm run check:update`）
直接 import 真实实现、抓 GitHub 上**真实的** `latest.yml` 跑一遍。
这是"无法运行打包后的应用"时唯一能做的端到端验证，实测覆盖了 0.1.6 与 0.1.4 两个真实文件。

### 仓库坐标是常量，`package.json` 里刻意不写 `repository`

换 fork 改 `update.ts` 的 `FALLBACK_REPO` 那一处即可。

**为什么不用 `repository` 字段**：electron-builder 会从它**推断 publish 配置**
（`PublishManager.js` 的 "no publishConfigs, detect using repository info"），
加上它会改变打包行为 —— 可能改 `latest.yml` 的形状、或要求 `GH_TOKEN`。
为一个元数据字段去动发布链路不划算。
读取逻辑仍然留着（`repoSlugFrom`）：谁哪天有意加了 `repository`，这里会自动认出来。

## 为什么设置的原始读写留在 infrastructure

不是"懒得搬"。`infrastructure/paths.ts` 与 `infrastructure/dshHome.ts` 都是
文件系统层却要读设置（版本池位置、DSH_HOME）。设置一旦搬进 domain，
这两处就变成 **infrastructure → domain 的反向依赖**，而那一层是不许依赖 domain 的。

所以界线是：**机制留 infrastructure，策略放 domain。**

| 关注点 | 住在哪 |
| --- | --- |
| JSON 文件读写、默认值、开机自启落注册表 | `infrastructure/settings.ts` |
| "来自渲染层的载荷该不该收"（逐字段校验） | [../../shared/schemas/settings.ts](../../shared/schemas/settings.ts) |
| "收下之后怎么落盘、要不要记日志" | 这里的 `apply.ts` |
| 通道 | `ipc/settings.ts` |

校验单独放 `@shared/schemas/` 是因为 `LauncherSettingsPayload` 是跨进程共享的类型 ——
"这个载荷合法吗"两边都关心（目前只有主进程在验）。

## 存哪、不存哪

存 `<userData>/settings.json`，**刻意不放 `~/.dsh`** —— 后者是 dsh 的数据目录
（profiles、插件、会话），而这几项只关于"启动器怎么启动 dsh"，混进去会让那个目录的
含义变模糊，也会在换启动器时被误读。

## 校验是逐字段宽容的

认不出的字段直接丢掉，**不报错**：渲染层可能比主进程新（前端先加了字段），
报错会让整次保存失败，而丢掉一个新字段只是"这次没存上"。
某一项不合法也**不影响其它项** —— 界面上一项填错不会导致整次保存失败。
