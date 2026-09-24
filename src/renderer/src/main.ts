import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { i18n } from './i18n'

/**
 * 样式导入顺序是有语义的，别随手调换：
 *   1. tokens   —— 先定义 :root 变量
 *   2. base     —— 全局重置与元素级规则
 *   3. components —— 引用了 tokens 的组件规则
 *   4. app-mount —— 挂载点与 Electron 无边框窗口的适配
 *   5. custom   —— 必须最后
 *
 * 第 5 条的原因：custom.css 里有 `header, main { z-index: 3 }` 与
 * `main, .page { pointer-events: none }` / `.page > * { pointer-events: auto }`，
 * 前者要把卡片压在各背景层之上，后者要让页面容器透传鼠标事件、只有直接子元素可交互。
 * 这两组都必须排在 components.css **之后**才生效，所以 custom.css 用 import 收尾。
 * （Vite 会把打包 CSS 插到 head 末尾，用 <link> 反而会被压过。）
 */
import './assets/styles/tokens.css'
import './assets/styles/base.css'
import './assets/styles/components.css'
import './assets/styles/app-mount.css'
import './assets/styles/custom.css'

createApp(App).use(createPinia()).use(router).use(i18n).mount('#app')
