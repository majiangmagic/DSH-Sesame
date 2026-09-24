/** 诊断结果类型 —— 放在 shared，因为渲染层也要用（项目惯例：@shared/versions、@shared/plugins） */

/** dsh 报出来的一个有问题的插件 */
export interface DiagnosedProblem {
  /** dsh 报出来的层 id */
  id: string
  /** 是否声明为必需（必需插件起不来 ⇒ 整个启动判定失败） */
  required: boolean
  /** dsh 给的包名；有它就用它去匹配已装插件（比 id 稳，id 可能被用户改过） */
  pkg: string | null
  /** 失败原因的第一行 */
  error: string | null
}

/** 一次诊断的结果 */
export interface DiagnosisResult {
  outcome: 'ready' | 'failed' | 'timeout'
  durationMs: number
  /**
   * **只有 `Failed plugins` 那一段** —— 根因。
   *
   * 同一份输出里的 `Plugins waiting for services` 是**一个根因引发的连锁**
   * （webserver 没起来 → 依赖它的插件都在"等"），取它会导致去禁用一堆无辜插件。
   */
  problems: DiagnosedProblem[]
  /** bundle 层被跳过的（声明不全 / overlay 读不到） */
  skipped: Array<{ name: string; reason: string }>
  /** 启动失败时 dsh 落的那份日志 */
  logPath: string | null
  /** 原样尾部，供界面兜底展示 */
  rawTail: string[]
}
