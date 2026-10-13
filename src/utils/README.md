# utils

**环境无关的纯函数。** 主进程与渲染层共用。

| 文件 | 作用 |
| --- | --- |
| `version.ts` | semver 解析与比较（`parseVer` / `cmpVer` / `compareVersionStrings`） |

## 准入条件（严格）

**不用 Node、不用 DOM、不用 Electron。**

这条不是洁癖。`utils/` 会被 `tsconfig.web.json` include，
而那份 tsconfig 没有 `"types"` 字段、`@types/node` 会被自动拉进来 ——
所以一个用了 `Buffer` 的函数放进来，渲染层就会**隐式拿到 Node 全局**：
编译能过，但"渲染层没有 Node"这个边界被悄悄破坏了。

反例：`main/infrastructure/textDecode.ts` 的签名是 `decodeChunk(chunk: Buffer)`，
所以它**必须**留在主进程侧，不能进这里。

## 与 `shared` 的区别

| | `shared` | `utils` |
| --- | --- | --- |
| 内容 | 类型、常量、校验规则 | 有逻辑的通用计算 |
| 判断标准 | 三方需要**同一份定义** | 三方都可能**调用**它 |

两者都是被所有层引用的叶子，都不许反向依赖进程层。

## 它修掉的真实缺陷

`version.ts` 原先有两套实现：主进程侧是完整版（含预发布段逐段比较），
渲染层侧是个"只比数字段"的简化版。而 dsh 的新版本**常常只挂在 alpha / next 上**
（实测 `latest=0.1.5-rc.3` 而 `alpha=0.1.7-alpha.2`），
那个简化版会把 `0.2.0-rc.2` 判成比 `0.2.0` 新（其实更旧），
于是插件页会推一个降级。

现在两边共用这一份。

## 边界

这里放"纯计算"。有网络、有文件、有进程的都不行 —— 那些属于
`main/infrastructure/`（例如 `registry.ts` 有 `fetch`，留在主进程侧）。
