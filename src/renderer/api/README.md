# renderer/api

**页面唯一的数据入口。**

| 文件 | 作用 |
| --- | --- |
| `contract.ts` | 接口契约 —— **只有类型，没有实现** |
| `real.ts` | 真实实现（全部走 `window.sesame` 的 IPC） |
| `index.ts` | 出口：`export const api = realApi`，并 re-export 契约类型 |

## 规则

组件只 `import { api } from '@/api'`，**不要**直接 `fetch` / `ipcRenderer` /
`window.sesame`。这样将来把某个能力从 IPC 换成别的实现时，组件不用改。

## 契约层存在的意义

`contract.ts` 定义了界面需要的形状，`real.ts` 负责把它接到 IPC 上。
中间这层可以**过滤与收窄**，例如 `getPlugins()` 会把 `@deepseek-ai/*` 官方组件滤掉
（它们是官方运行时、一律不可开关，展示出来只会占位）——
过滤放在这一层，控制页与插件页拿到的是同一份，不会两处不一致。

## ⚠️ 已知缺口：契约与 preload 是手工镜像

`contract.ts` 的 `ManagerApi` 和 `preload/index.ts` 暴露的能力面是**各写一遍**的。
`api/index.ts` 的 `api: ManagerApi = realApi` 只保证 `real` 实现了 `contract`，
**不保证 contract 覆盖了 preload 的全部能力** —— preload 加了方法而 contract 忘了加，
编译器不会响。

改法（尚未实施）：让 `contract.ts` 从 preload 的 `SesameApi` 类型推导，
而不是手写。见根目录 `DEVELOPING.md` 的"还缺什么"。

## `SAMPLE_DATA`

`index.ts` 里保留了一个统一开关，标明哪些数据仍是**样例**。
现在三项全为 `false`（都接了真实逻辑）。留着它是为了将来某块临时退回假数据时，
在**一处**置 `true`，对应界面就自动挂出「样例数据」标注。
