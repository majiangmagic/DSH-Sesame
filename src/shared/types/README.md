# shared/types

**跨进程共享的形状** —— 纯类型，没有实现，编译后基本被擦除。

| 文件 | 对应标签页 | 内容 |
| --- | --- | --- |
| `control.ts` | 控制 | `DiagnosisResult` / `DiagnosedProblem` |
| `versions.ts` | 版本 | `InstalledVersion` / `VersionOverview` / `RemoteVersionInfo` |
| `plugins.ts` | 插件 | `PluginEntry` / `PluginList` + 市场四件套 |
| `snapshots.ts` | 快照 | `SnapshotEntry` / `RestoreResult` / `SnapshotPreview` |
| `settings.ts` | 设置 | `LauncherSettingsPayload` |
| `events.ts` | — | 主进程 → 渲染层的进度推送载荷（3 个） |

## 为什么没有 `terminal.ts`

终端页的数据就是 `string[]`（一行一条日志），**没有需要共享的模型类型** ——
所以不建一个空文件充数。这是 6 个标签页里唯一没有模型文件的。

## `events.ts` 为什么在这里而不在 constants/

它是**形状**（interface），不是值。通道名是值，所以在 `constants/channels.ts`。
两者的消费者也不同：通道名只被主进程注册处与 preload 引用，事件载荷还要被渲染层的 store 消费。

## 两处归并，判据都是"有没有自己的标签页"

- **市场并进 `plugins.ts`**：市场的界面就在插件页里，没有独立标签页；
- **诊断并进 `control.ts`**：诊断的入口是控制页上的「检查」按钮。

## `settings.ts` 与主进程那份的关系

`infrastructure/settings.ts` 的 `LauncherSettings` 是**读写真身**，
这里的 `LauncherSettingsPayload` 是**跨进程传的那一份**，
渲染层 `api/contract.ts` 的 `SettingsPayload` 再在其上做面向界面的包装。
三份必须一致 —— 目前是手工同步，见根目录 `DEVELOPING.md` 的"还缺什么"。
