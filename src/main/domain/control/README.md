# main/domain/control

**控制页**（标签页「控制」，`/control`）背后的全部逻辑。

| 文件 | 作用 |
| --- | --- |
| `runner.ts` | 启动 / 停止 dsh 子进程、端口回退、就绪判定、运行态（`currentRun`） |
| `desktop.ts` | 官方桌面端：下载 NSIS 包 → 用 7za 解压成绿色版 → 拉起它 |
| `sync.ts` | 启动桌面端前，把 web profile 的插件**无条件一比一重建**到桌面端 profile |
| `pluginMirror.ts` | 「两边差在哪」的**纯报告**（不依赖 Electron，可脱离应用验证） |
| `diagnose.ts` | 限时启动一次 dsh，解析它自己打印的失败诊断 |

IPC 在 [../../ipc/control.ts](../../ipc/control.ts)（3 条通道）。

## 插件同步：无条件一比一重建

官方把 Desktop 的 profile 设计成独立的一套（独占 `profiles/desktop`），所以插件要装两遍。
启动器采用「**web 为唯一基准**」，而且**每次启动桌面端都无条件重建**：

    ① 卸掉桌面端的全部插件（跳过 @deepseek-ai/*，那是桌面端自己的组件）
    ② 按 web 一比一装回来（含"版本声明落后"的兼容豁免）

**不做"看起来一致就跳过"的判断。** 这个功能改过两次，第二次的教训是关键：

| 版本 | 做法 | 结果 |
| --- | --- | --- |
| 最早 | 只补缺（web 有、桌面端没有的搬过去） | **永远删不掉**桌面端自己装的插件。实测 `dsh-store` 只在桌面端存在，于是每次启动都被一起加载 |
| 中间 | 加"一致就跳过"，靠 `pluginMirror` 判断 | 判断**只能看清单与磁盘上的版本号** —— `node_modules` 里坏掉、缺文件、装了一半的包在清单上完全看不出来，判断会说"一致"，然后桌面端带着一个坏掉的依赖启动 |
| 现在 | **无条件重建** | 没有漏的可能。代价是每次启动多等一两分钟（十几次 pnpm 往返） |

**为什么接受这个代价**：桌面端装的插件是"临时用一下"，正确性优先于这点时间。
而"判断漏一次"就等于这个功能不存在 —— 用户看到的仍然是"没同步"。

**补丁层不重建**：桌面端补丁层里有 web 没有的引导条目（`ui-chat` / `ui-settings` /
`ui-settings-account`），那是它首次启动时写下的账号与界面状态，清掉等于让用户重走引导。
插件是"临时用一下"，这三条不是。补丁层仍然只**补缺 + 对齐启停**。

**失败会一直重建**：如果某个插件装不上，下次启动还会重建（因为重建无条件是必然的）——
所以 `failed` 与"没卸干净"都会如实写进终端页。**这是刻意的可见性**：
一个一直装不上的插件不该悄悄循环，应该让人看见。

## `pluginMirror.ts` 为什么单独一个文件

它**不决定任何行为**（重建是无条件的），只把"两边差在哪"说清楚。单独一个文件是因为：

- 报告与搬运分开：`sync.ts` 读盘、跑 CLI、写日志；"差在哪"只在这里定义一次；
- **能脱离 Electron 验证** —— 一个普通 Node 脚本就能拿真实 profile 的数据跑它，
  见 `scripts/check-desktop-mirror.mjs`（`npm run check:mirror`）。它不 import 任何东西，
  所以那个脚本可以直接 import 真实实现，而不是复制一份逻辑（复制出来的迟早会漂移）。

它比四样：包名集合、**实际装上的版本**（不能只看清单里的范围 —— pnpm 的
最小发布年龄闸会"静默保留旧版本、退出码 0"）、非 registry 来源的规格串
（同一个包名可以是不同 commit）。

⚠️ 但它**看不到** `node_modules` 是否健康 —— 这正是它不再参与决策的原因。

## 为什么诊断也在这个目录

它**没有自己的标签页** —— 入口就是控制页上的「检查」按钮。
早先它单列一个 `domain/diagnose/`，那等于凭空多出第 7 个领域，
"domain 目录 = 界面上的标签页"这条规则就不成立了。

判据是"**有没有自己的标签页**"，不是"功能是否独立"。

## 为什么 `startVersion` / `stopVersion` 在这个领域，而 `overview` 不在

它们管的是**进程**，不是"磁盘上装了哪些版本"。后者在 [../versions/](../versions/)。
但通道名仍是同一组 `VERSION_CHANNELS` —— 对渲染层来说它们是同一件事（"这个版本"），
而通道名是线上协议，不跟着主进程的目录划分走。

## 四个容易踩的坑（都在代码注释里）

1. **必须用真正的 `node.exe`** —— dsh 的加载器会检查 V8 指纹，Electron 自带的那个会被拒。
   解析顺序在 [../../infrastructure/runtime.ts](../../infrastructure/runtime.ts)。
2. **端口回退必须写日志**。设置的固定端口被占用时回退到系统分配，但静默换端口会让地址
   重新变得不可预期，用户会以为启动器坏了。所以 `resolvePort` 一定推一行日志。
3. **桌面端与 dsh 实例互斥**，且同步 web 配置必须在**启动之前**做 ——
   桌面端跑起来就持有 profile 写锁。
4. **桌面端模式下诊断不能走 "spawn dsh"** —— CLI 明确拒绝 desktop profile
   （`managed exclusively by the Electron application`），硬跑只会得到一句假的"启动失败"。

## 循环依赖是怎么断的

原先 `runner → sync → diagnose → runner` 成环，因为 `diagnose` 要从 `runner` 拿
`bootArgs` / `envFor` / `killTree` / `READY_RE`。现在这四个在
[../../infrastructure/boot.ts](../../infrastructure/boot.ts)，环就断了。

注意：断环靠的是**把原语下沉到 infrastructure**，不是把 diagnose 搬出这个目录。

另有一条**差点被引入**的环：插件重置要用 `RELEASE_AGE_BYPASS`，若从
`domain/plugins/pluginInstall.ts` 导出给这里用，就会形成
`sync → pluginInstall → versions → runner → sync`。所以那个常量住在
[../../infrastructure/dshCli.ts](../../infrastructure/dshCli.ts) —— 由
`npm run check:graph` 抓到。
