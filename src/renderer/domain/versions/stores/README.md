# renderer/domain/versions/stores

| 文件 | 作用 |
| --- | --- |
| `versions.ts` | 版本总览 + **启停动作** + 错误与进度状态 |

## 为什么启停也在这里

因为控制页与版本页消费的是**同一份运行态**（"哪个版本正在跑"）。
`start` / `stop` 放在这个 store 里，控制页（`domain/control/ControlView.vue`）
直接用，不再自己维护一份。

## 状态字段的分工

- `installedNumbers` / `runningVersion` / `running` —— 从 `getVersionOverview()` 来；
- `action`（`starting` / `stopping` / `restarting` / `updating`）—— 界面动作，
  控制页的提示行按它选文案；
- `progressText` —— 桌面端启动时主进程推来的「下载 / 安装 / 启动」进度，
  优先于上面那些文案显示；
- `error` —— 最高优先级，控制页的提示行优先报错。

## 启动是"等到就绪才 resolve"的

`start()` 会一直等到主进程返回就绪地址（首次启动可能现场装依赖，会比较慢）。
所以界面不会出现"点了没反应"的中间态，也**不做假的进度条** ——
那是 dsh 侧的真实耗时。
