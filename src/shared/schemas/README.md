# shared/schemas

**跨进程数据的运行时校验** —— 纯函数，无副作用。

| 文件 | 内容 |
| --- | --- |
| `settings.ts` | `normalizeSettingsPatch()` / `isValidPort()` / `isValidLang()` |

## 为什么校验要在 shared

`LauncherSettingsPayload`（见 [../types/settings.ts](../types/settings.ts)）是跨进程共享的类型，
而"这个载荷是不是合法"两边都关心：主进程写入前**必须**验（载荷来自渲染层，
不能整包 trust 地写进磁盘），渲染层也可以在提交前先挡一道（目前只有主进程在验）。

校验规则与类型定义放在一起，改类型时不容易忘了改校验。

## 为什么单独一份而不是散在 IPC 处理函数里

那段校验原本是 8 个展开的 `typeof x === …` 三元表达式，混在通道注册里 ——
看通道注册时得先把校验读完。现在：

    形状    → @shared/types/settings.ts
    校验    → 这里
    编排    → main/domain/settings/apply.ts
    通道    → main/ipc/settings.ts

## 校验是**逐字段宽容**的

认不出的字段直接丢掉，**不报错**；某一项不合法**不影响其它项**。

理由：渲染层可能比主进程新（前端先加了字段），报错会让整次保存失败，
而丢掉一个新字段只是"这次没存上"，下次两边对齐后自然就好了。
同理，界面上一项填错（比如端口超范围）不该让"开机自启"这个改动也一起丢掉。

## 目前还没有 schema 库

没有引 zod / valibot —— 这几条规则用几十行手写函数就够，不值得为它加一条依赖链。
等校验规则变多（比如快照 manifest 的解析、市场返回数据的收窄）再考虑。
