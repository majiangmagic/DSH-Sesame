# renderer/domain/versions

**版本页**（标签页「版本」，`/versions`）—— 逐版本的下载与卸载。

| 文件 | 作用 |
| --- | --- |
| `VersionsView.vue` | 页面（很薄：只放 `VersionManager`） |
| `VersionManager.vue` | 版本表格 + 安装/卸载操作 |
| `VersionSelect.vue` | 版本下拉（带徽标），控制页也复用 |
| [stores/versions.ts](stores/versions.ts) | 版本总览、启停动作、错误与进度状态 |

## 「最新」不是 `dist-tags.latest`

跨 tag 取 **semver 最高**的那个。原因见
[../../../utils/version.ts](../../../utils/version.ts)：
dsh 的新版本常常只挂在 alpha / next 上，实测 `latest=0.1.5-rc.3` 而
`alpha=0.1.7-alpha.2`，直接信 latest 会把降级当升级推给用户。

## store 里为什么同时管"启停"

因为控制页与版本页消费的是同一份运行态（"哪个版本正在跑"）。
`start` / `stop` 在 `stores/versions.ts` 里，控制页
（`domain/control/ControlView.vue`）直接用。
