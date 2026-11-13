/**
 * 插件写操作的**串行闸**。
 *
 * 为什么必须有它：改 profile 的三条路径都会**读—改—写**同一个文件，而它们此前
 * 完全没有任何互斥：
 *
 *   · `pluginState.setPluginEnabled`：读 `cordis.patch.yml` → 增删一行 → 写回
 *   · `pluginInstall.install/uninstall/update`：起 dsh CLI（→ pnpm）改 `package.json`
 *
 * 两个开关同时按下时，后写的一方用的是**改之前**读到的旧文本，于是先那一笔
 * 被静默覆盖（丢更新）——表现就是"两个插件都点了，只有一个生效"。
 *
 * 为什么闸在这里而不是留在渲染层：渲染层原来用"单个 busy 槽 + 直接 return"来避免
 * 并发，代价是**新点击被静默丢弃**——用户点了却什么都没发生。正确做法是让调用**排队**，
 * 由这一层保证"同一时刻只有一个写在跑"，界面只负责显示"排队中/进行中"。
 *
 * 只串行**写**操作。读（`listPlugins`、市场目录）不受影响，不会因为一个安装而卡住界面。
 */
let tail: Promise<unknown> = Promise.resolve()

/**
 * 把一个可能异步的写操作排进队列，返回它自己的结果。
 *
 * 前一个任务失败**不会**拖垮队列：失败被吞在这一层之外（调用方仍拿到真实的 reject）。
 */
export function withPluginWriteLock<T>(job: () => Promise<T> | T): Promise<T> {
  const run = tail.then(job, job)
  // 队列的"接续"必须永远处于 resolved 状态，否则一次失败会让后续全部跳过
  tail = run.then(
    () => undefined,
    () => undefined
  )
  return run as Promise<T>
}
