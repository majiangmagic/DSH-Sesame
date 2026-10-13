# renderer

渲染层 —— Vue 3 界面。**权限最小的前端**：

- 跑在 Chromium 里，**没有 Node**（`nodeIntegration: false`、`contextIsolation: true`）；
- **不能直连网络**（CSP 把 `connect-src` 限死在本机），远端图片必须走主进程代理；
- 拿系统能力的唯一途径是 `window.sesame`，而且只能经 [api/](api/) 使用。

## 目录

| 目录 | 作用 |
| --- | --- |
| [domain/](domain/) | 按**标签页**分的页面与它专属的组件 / store —— 正好 6 个 |
| [components/](components/) | 跨页复用的 UI 组件 |
| [layouts/](layouts/) | 页面整体布局 |
| [router/](router/) | 路由配置 |
| [stores/](stores/) | 跨页的全局状态 |
| [i18n/](i18n/) | 双语装配与语言包 |
| [api/](api/) | **页面唯一的数据入口** |
| [assets/](assets/) | 样式 |
| [public/](public/) | Vite 原样拷贝的静态资源（看板娘素材） |
| `main.ts` | 渲染进程入口 |
| `App.vue` | 根组件 |
| `env.d.ts` | 全局类型声明 |
| `index.html` | Vite 的入口 HTML |

## 为什么这里没有那层 `src`

electron-vite 的默认模板是 `renderer/src/`，多出来的那层只是为了把 `index.html`
和"源码"分开放。Vite 的 root 是 `src/renderer`（electron-vite 里写死的默认值），
`index.html` 必须待在 root 下，但源码没有理由再套一层。

所以 `@` 别名指向 `src/renderer` 本身，入口是 `/main.ts`。

## `domain/` 的目录名 = 界面上的 6 个标签页

控制 `control` · 版本 `versions` · 插件 `plugins` · 终端 `terminal` · 快照 `snapshots` · 设置 `settings`

与 [../main/domain/](../main/domain/) 一一同名，**路由路径与 `nav.*` 文案也同名**：

    nav.terminal = '终端'   →   /terminal   →   domain/terminal/TerminalView.vue

改名时三处一起改，不要只改内容不改目录名 —— 那正是之前 `logs` 与「终端」对不上的原因。

## 两处"结构上删不掉"的东西

目标结构里没有列，但它们**不能删**：

- **`index.html`** —— Vite 的入口，必须待在 root（`src/renderer`）下；
- **`public/`** —— Vite 的 `publicDir`，位置由 root 决定。里面的东西被**原样拷贝**进产物，
  所以那里刻意**不放 README**（会被逐字拷进 `compiled/renderer/`）。
  两个目录的说明写在 [public 那一节](#关于-public唯一没有自己-readme-的目录) 与
  [assets/](assets/) 里。

另外保留了 [api/](api/) 与 [i18n/](i18n/)、[assets/](assets/)：
前者是"页面唯一数据入口"（删了组件就得直接调 `window.sesame`），
后两者是样式与双语的装配点。

## 关于 `public/`（唯一没有自己 README 的目录）

    public/pat/dsniang.png      看板娘立绘（默认）
    public/pat/dsniang-alt.png  看板娘立绘（另一状态）
    public/pat/rua.gif          摸头动画

页面按固定 URL 直接引用（`/pat/dsniang.png`），不经过打包器、不做哈希、不被内联。
`electron.vite.config.ts` 里还有一道保险 `assetsInlineLimit: 0` ——
看板娘与背景图是二进制大件，必须原样拷贝。

## 加一个标签页的顺序

1. `domain/<标签页>/` 建 View + 它专属的组件与 store；
2. 主进程侧建 `domain/<标签页>/` + `ipc/<标签页>.ts`；
3. 通道与模型：`@shared/constants/channels`、`@shared/types/`；
4. `api/contract.ts` 加方法、`api/real.ts` 实现；
5. `router/index.ts` 加路由、`layouts/AppShell.vue` 的 `TABS` 加一项；
6. 两处语言包 `i18n/locales/` 加文案（区块名与标签页同名）。

第 4 步目前是**手工镜像**（contract 与 preload 的能力面各写一遍），
编译器不保证两者一致 —— 见根目录 `DEVELOPING.md` 的"还缺什么"。
