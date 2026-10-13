# main/domain/versions

**版本页**（标签页「版本」，`/versions`）背后的逻辑 —— 版本池。

| 文件 | 作用 |
| --- | --- |
| `versions.ts` | 扫描版本池、拼版本总览（已装 + 远端 + 运行态） |
| `installer.ts` | 下载安装（写私有清单 → npm 装进 `<版本根>/<版本号>`）、卸载 |

IPC 在 [../../ipc/versions.ts](../../ipc/versions.ts)。

## 版本池是什么

应用旁边的 `dsh/<版本号>` 目录，**只包含本应用自己装的版本**。

刻意不收录机器上 npm 全局安装的 dsh：版本池的意义是"这个启动器自己的东西、
可整份删掉重建"，而 npm 全局是全机器共享的、也不归本应用管 ——
混进来会让"独立"破一半，还会让同一个列表里出现两种卸载语义。

## 版本比较在 `@utils/version`

`parseVer` / `cmpVer` 在 [../../../utils/version.ts](../../../utils/version.ts)，
**与渲染层共用同一份**。原先渲染层自己写了个"只比数字段"的简化版，
会把 `0.2.0-rc.2` 判成比 `0.2.0` 新（其实更旧）—— 而 dsh 的新版本常常只挂在
alpha / next 上，所以那个简化版会推降级。这里的 `latestRemoteFor` 也**不信
`dist-tags.latest`**，而是跨 tag 取 semver 最高（实测 latest=0.1.5-rc.3 而
alpha=0.1.7-alpha.2）。

## 启动 / 停止不在这里

在 [../control/](../control/) —— 它们管的是进程，不是"磁盘上装了哪些版本"。
