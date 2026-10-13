import type { SesameApi } from '.'

/**
 * 暴露给 Renderer 的 API 类型。
 *
 * 这个文件被 `tsconfig.web.json` include，所以渲染层认得出 `window.sesame`。
 * 类型从 preload 的**实现**（`./index.ts`）用 `typeof` 推导 —— 一处定义，不手工镜像。
 *
 * 它必须是 `.ts` 而不是 `.d.ts`：`tsconfig.web.json` 里那条 include 写死了
 * `src/preload/*.d.ts`，一旦文件改名或增删就会**静默失配**（类型没了，但报错在
 * 渲染层各处冒出来，看不出根因）。写成一个明确的路径更稳。
 */
declare global {
  interface Window {
    sesame: SesameApi
  }
}

export {}