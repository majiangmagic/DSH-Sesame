# renderer/domain

渲染层的业务层。**目录名严格等于界面上的 6 个标签页**，与
[../../main/domain/](../../main/domain/) 一一同名：

| 目录 | 标签页 | 路由 |
| --- | --- | --- |
| [control/](control/) | 控制 | `/control` |
| [versions/](versions/) | 版本 | `/versions` |
| [plugins/](plugins/) | 插件 | `/plugins` |
| [terminal/](terminal/) | 终端 | `/terminal` |
| [snapshots/](snapshots/) | 快照 | `/snapshots` |
| [settings/](settings/) | 设置 | `/settings` |

## 每个领域的标准形状

    domain/<标签页>/
      <标签页>View.vue       页面（路由指向它）
      <专属组件>.vue          只被这个页面用的组件
      stores/<名字>.ts        只服务这个页面的 store

**跨页复用的组件不放这里**，放 [../components/](../components/)。
判据很简单：这个组件会不会被第二个页面用。

## 三处同名，是刻意的

    标签页文案      nav.terminal = '终端'
    路由            /terminal
    目录            renderer/domain/terminal/

改名时三处一起改（外加主进程那份同名目录、以及 i18n 的区块名）。

## 视图文件名与目录同名

`control/ControlView.vue`、`terminal/TerminalView.vue` ——
目录叫什么，页面组件就叫什么（`<标签页>View.vue`）。
