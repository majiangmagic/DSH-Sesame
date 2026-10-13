# preload

主进程与渲染层之间的**唯一出入口**。

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 把主进程能力组织成 `window.sesame`，经 `contextBridge` 暴露 |
| [types.ts](types.ts) | 让渲染层认识 `window.sesame`（被 `tsconfig.web.json` include） |

## 为什么这里是单文件，不按 domain 拆

整个 preload 只有 189 行，而且**没有业务逻辑** —— 它是直通管道：
每个方法就是一次 `ipcRenderer.invoke(通道名, 参数)`。
按标签页拆成 6 个 20 行的文件不会让任何东西更清晰，
只会让"加一个功能"从改 3 处变成改 4 处。

渲染层侧的分层靠 [../renderer/api/](../renderer/api/) 那层包装来兑现。

## `types.ts` 必须是 `.ts`，不能是 `.d.ts`

`tsconfig.web.json` 里那条 include 写的是一个**明确路径** `src/preload/types.ts`。
之前写的是 glob `src/preload/*.d.ts` —— 一旦文件改名或增删就会**静默失配**：
类型没了，但报错在渲染层各处冒出来（`Property 'sesame' does not exist on type 'Window'`），
看不出根因。明确路径 + `.ts` 更稳。

## 三条约定

1. **通道名从 `@shared/constants/channels` 取**，不写字面量 —— 与主进程同一份定义。
2. **订阅类方法返回"取消订阅"函数**（`onProgress` / `onLogLine` / `onMaximizedChanged`），
   组件在 `onBeforeUnmount` 里调用它，避免泄漏。
3. **渲染层只能通过 `renderer/api` 使用这些能力**，不要在组件里直接调 `window.sesame` ——
   这样将来把某个能力从 IPC 换成别的实现时，组件不用改。
