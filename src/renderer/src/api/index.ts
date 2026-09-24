import type { ManagerApi } from './contract'
import { realApi } from './real'

/**
 * 页面唯一的数据入口。
 *
 * 组件只 `import { api } from '@/api'`，**不要**直接 fetch / ipcRenderer。
 * 版本 / 启动停止 / 插件 / 市场 / 终端 / 设置**全部接真**，没有任何一项还是样例数据。
 */
export const api: ManagerApi = realApi

/**
 * 哪些数据仍是**样例**。
 *
 * 现在三项**全为 false** —— 五个页面都接了真实逻辑。
 * 保留这个开关是留个统一的位置：将来某块临时退回假数据时，在这里置 true，
 * 对应界面就会自动挂出「样例数据」标注，不会再出现"看起来能用、其实没生效"的区域。
 */
export const SAMPLE_DATA = {
  plugins: false,
  settings: false,
  log: false
} as const

export type * from './contract'
