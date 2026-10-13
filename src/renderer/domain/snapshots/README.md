# renderer/domain/snapshots

**快照页**（标签页「快照」，`/snapshots`）—— profile 配置的存与回退。

| 文件 | 作用 |
| --- | --- |
| `SnapshotsView.vue` | 页面（很薄：只放 `SnapshotManager`） |
| `SnapshotManager.vue` | 列表 + 存/回退/删 + 存之前的预演弹窗 |

> 目录名是 **snapshots**（复数），与标签页「快照」、共享模型
> `@shared/types/snapshots.ts` 一致。

## 「存一份」为什么先弹窗

因为存一次要把整个 `node_modules` 压缩（几百 MB、几十秒）。
弹窗里平铺列出会被一起存的配置文件与插件，让用户先看一眼再决定。

## 回退是可逆的

主进程保证：**回退前会自动先存一份 `pre-rollback`**。
所以点错了也能退回来，界面据此不给二次确认的恐吓式文案。
