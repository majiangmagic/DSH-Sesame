# main/domain/snapshots

**快照页**（标签页「快照」，`/snapshots`）背后的逻辑。

| 文件 | 作用 |
| --- | --- |
| `snapshot.ts` | 存 / 列 / 回退 / 删 / 预演；含 node_modules 整包与指纹去重 |

IPC 在 [../../ipc/snapshots.ts](../../ipc/snapshots.ts)（6 条通道）。

## 几条关键决策

- **存在 `<userData>/snapshots/`，不在安装目录** —— 覆盖安装会把安装目录清空。
- **回退前自动先存一份 `pre-rollback`**，所以回退本身也可逆。
- **全量打包 `node_modules`，不做"哪些是 npm / 哪些是私有"的分类**。
  分类不准还会误导，而全量打包本来就不需要知道来源。
- **每份上百 MB，所以用指纹去重**（文件清单 + 大小 + 修改时间）：
  内容没变就不再存一份整包。指纹只算一次，比压缩几十秒便宜得多。
- 最多保留 10 份。

## 谁在调它

- 快照页（走 IPC）；
- [../plugins/guard.ts](../plugins/guard.ts) 的 `autoSnapshotBefore` ——
  **改 profile 之前自动存一份**。这是本领域被别的领域依赖的唯一入口，
  而且它是一条业务规则，所以那个函数住在 domain 里而不是 ipc 层。
