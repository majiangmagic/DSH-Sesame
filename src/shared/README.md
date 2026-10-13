# shared

**三方共用的契约** —— 主进程、preload、渲染层都要用的东西。**只有类型、常量与校验，没有副作用。**

| 目录 | 放什么 | 判据 |
| --- | --- | --- |
| [types/](types/) | 领域模型与事件载荷（纯类型） | 三方需要**同一份形状** |
| [constants/](constants/) | 通道名 | 三方需要**同一个字面量** |
| [schemas/](schemas/) | 运行时校验（纯函数） | 三方需要**同一条校验规则** |

## 为什么它必须独立在顶层

两个 tsconfig 是**按层** include 的，`shared` 是**唯一被两边同时 include 的目录**：

    tsconfig.node.json  → main / preload / shared / utils
    tsconfig.web.json   → renderer / preload/types.ts / shared / utils

把共享类型放进 `main/`，渲染层要 import 它就得把 `src/main/**` 加进 web 那份 ——
而那个目录里有 `node:fs`、`node:child_process`，渲染层的 lib 里没有 node 类型，
**编译立刻失败**。

## 它兑现的约定

> **通道名只在 `shared/constants/channels.ts` 定义一次**，主进程与 preload 各注册一次。

没有它，同一个通道名要在注册处和调用处各写一遍，改一处忘一处**编译器不会报错**。
`shared/types/` 同理：`VersionOverview` 由主进程产出、preload 声明、渲染层消费 ——
三处必须一致。

## 它不许依赖任何进程层

`shared` 是叶子。反向依赖（`shared → main`）会立刻造成上面那个编译问题。
`npm run check:graph` 会拦。

## 为什么是 types / constants / schemas 三分

按**"这份契约是什么性质"**分，而不是按业务领域分：

- 形状（interface / type）→ `types/`
- 值（字符串常量）→ `constants/`
- 规则（校验函数）→ `schemas/`

按领域分（`shared/versions/`、`shared/plugins/`）会让一个领域的东西散在三处；
按性质分则"我要加一条校验规则"的去处是确定的。
