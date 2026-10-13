# renderer/i18n

**双语装配。**

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 装配 vue-i18n，导出 `setLocale` |
| [locales/](locales/) | 语言包（zh-CN / en-US） |

## 用语义化 key，不拿中文原文当 key

好处是改文案不必回头改调用点、英文缺失一眼能看出来；
代价是移植时必须逐个对照原词典，不能机械替换。对照表见 `docs/migration-map.md`。

## 改语言的两处副作用

`setLocale` 除了切 i18n 实例，还会设 `document.documentElement.lang`
（`en-US` → `en`，其余 → `zh-CN`）—— 影响字体回退与无障碍朗读。

## 语言状态在 `stores/locale.ts`

不在这个目录 —— 它跨页（每个页面都消费 i18n 实例），所以按"跨页状态"归到
[../stores/](../stores/)。这里只负责**装配**（建 i18n 实例、注册语言包）。
