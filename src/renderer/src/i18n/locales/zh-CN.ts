/**
 * 中文文案。
 *
 * 本文件是文案的**唯一真相**：key 命名约定是 `<区域>.<用途>`，与
 * src/renderer/src/views 下的页面一一对应。新增 key 时同步补 en-US.ts
 * （en-US.ts 用 `typeof zhCN` 约束，漏补会直接编译不过）。
 */
export default {
  app: {
    title: 'DSH-S'
  },

  common: {
    loading: '加载中…',
    /** 标注这块界面用的还是样例数据，避免被误当成真实状态 */
    sampleData: '样例数据',
    sampleHint: '这块还没接真实逻辑，显示的是样例数据。'
  },

  /** 动作进行中的提示（原词典里就有这几句，这里单独成组，供控制页提示行使用） */
  progress: {
    starting: '正在启动…',
    stopping: '正在停止…',
    restarting: '正在重启…',
    updating: '正在更新…',
    installing: '正在安装…',
    uninstalling: '正在卸载…',
    downloading: '正在下载…'
  },

  /** 版本管理（数据来自主进程真实扫描 + npm registry） */
  versions: {
    title: '版本管理',
    subtitle: '已装 {installed} 个 · 远端 {remote} 个',
    refresh: '重新读取',
    noRemote: '没有读到任何版本（远端拉取失败时会这样）。',
    download: '下载',
    downloading: '下载中…',
    uninstall: '卸载',
    uninstalling: '卸载中…',
    uninstallRunningHint: '正在运行的版本不能卸载，请先停止再卸',
    managedMeta: '本应用安装',
    notInstalled: '尚未安装',
    localOnly: '本地版本（远端列表里没有）',
    rootHint: '版本装在 {dir}；插件和数据始终在用户目录的 .dsh，卸载版本不会带走它们。',
    remoteFailed: '读不到远端版本：{message}'
  },

  nav: {
    home: '控制',
    plugins: '插件',
    log: '终端',
    settings: '设置',
    versions: '版本'
  },

  window: {
    minimize: '最小化',
    maximize: '最大化',
    close: '关闭'
  },

  home: {
    versionLabel: '版本',
    loadingVersion: '加载中…',
    noVersions: '暂无版本',
    hint: '插件和数据在用户目录的 .dsh。',
    actionUpdate: '更新',
    actionStart: '启动',
    actionStop: '停止'
  },

  plugins: {
    title: '插件',
    refresh: '刷新',
    empty: '这个 profile 里没有已安装的插件。',
    disabled: '已禁用',
    rows: '行 {ids}',
    subtitle: '{profile} profile · 共 {total} 个 · {on} 个启用',
    willEnable: '启用 {name}（从 cordis.patch.yml 删掉它的禁用行）',
    willDisable: '停用 {name}（在 cordis.patch.yml 里为它的行写上 disabled: true）',
    /**
     * 不可开关的原因。
     *
     * 原版这里是后端直接返回中文整句、前端再拿这句中文当 key 去 EN 词典里查。
     * 这里改成**原因码**：后端只说是哪一类，文案由前端决定，加语言不用动后端。
     *
     * 每类两条：
     *  - 短的那条进 `.module-meta`，和版本号、行 id 挤在同一行，必须短；
     *  - `*Why` 那条挂整行的 `title`，讲清**为什么**不能关 —— 空间够，才说得明白。
     */
    reason: {
      noRows: '没有可开关的加载行',
      official: '官方组件，不提供开关',
      market: '市场自管行，不提供开关',
      noRowsWhy:
        '这个包不向 profile 注入 loader 行。它属于「客户端插件」，由插件市场在运行时挂载，补丁层里没有可写的目标行 —— 开关无处落笔，所以不给。',
      officialWhy:
        '官方运行时组件（@deepseek-ai/*）。它是一组被多个官方包共用的 loader 行，关掉其中任意一条都可能让 dsh 直接起不来，所以不提供开关。',
      marketWhy:
        '这些行 id 属于插件市场自己的命名空间（mkt- / client- / include:）。若补丁层写进这些 id，一旦市场被卸载或改名，就会留下永远指向不存在行的孤儿补丁 —— 因此由市场自管，不开放开关。'
    }
  },

  /** 插件市场（DSH-Sesame 新增；数据来自内置的 dshmarket 库） */
  market: {
    title: '插件市场',
    subtitle: '目录 {total} 个 · 已装 {installed} 个',
    refresh: '刷新目录',
    searchPlaceholder: '搜索插件名 / 作者 / 简介',
    allCategories: '全部',
    noMatch: '没有匹配的插件。',
    clearFilters: '清空筛选',
    showing: '显示 {shown} / 匹配 {matched} 条',
    hidden: '还有 {count} 条未显示 —— 用搜索或分类缩小范围',
    loadMore: '加载更多（还有 {count} 条）',
    sortDefault: '目录顺序',
    sortStars: '按星数',
    sortDownloads: '按下载量',
    sortName: '按名称',
    sortHint: '切换排序：目录顺序 → 星数 → 下载量 → 名称',
    sameName: '同名 ×{count}',
    sameNameHint:
      '目录里有多个不同作者的同名包。「已装」按 npm 包名判断，所以只有你真正装的那一个会被标成已装。',
    starsHint: 'GitHub 星数（目录自带）',
    downloadsHint: '区间下载量（目录自带）',
    installTitle: '安装命令：{command}',
    repo: '仓库',
    openRepo: '在浏览器打开仓库页',
    page: '市场页',
    openPage: '在市场站点打开这个插件的详情页',
    unlisted: '另有 {count} 个已装插件未被目录收录：{names}（未收录的插件不会出现在这里，但仍可用）',
    install: '下载',
    installing: '下载中…',
    uninstall: '卸载',
    uninstalling: '卸载中…',
    uninstallTitle: '卸载命令：{command}',
    update: '更新',
    updating: '更新中…',
    updateTitle: '更新到 {version}',
    noNpmHint: '目录里这条记录没有 npm 包名，无法从市场安装',
    installPending: '安装动作尚未接入'
  },

  status: {
    latest: '最新',
    installed: '已装',
    running: '运行中',
    stopped: '未运行',
    starting: '启动中',
    stopping: '停止中',
    installing: '安装中'
  },

  log: {
    clear: '清空'
  },

  settings: {
    autoStart: '开机自启',
    seedMarket: '插件市场',
    autoDisable: '兼容模式',
    advanced: '高级设置',
    profile: '启动 profile',
    port: '管理页端口',
    uiLang: '界面语言',
    args: '额外启动参数',
    argsPlaceholder: '例如：--log-level debug',
    argsHint: '追加到 dsh 命令行末尾（空格分词，含空格的值用引号包起来）。已装的插件、数据不受影响。',
    portHint: 'dsh web 服务绑定的端口，默认 3080。被占用时启动会明确报错，不会自动换端口',
    dataDir: '版本目录',
    browse: '浏览…',
    save: '保存',
    saved: '已保存。'
  },

  modal: {
    updateAvailable: '检测到新版本',
    notNow: '暂不更新',
    actionFailed: '操作失败',
    ok: '确定'
  },

  ask: {
    dshItself: 'dsh 本体',
    launcherItself: '启动器',
    updateTo: '更新到 {latest}',
    /** 原版这段风险提示是写死在脚本里的整句，这里提到词典，方便改文案与加语言 */
    risk: '升级会先停掉正在运行的 dsh，再下载安装新版本。插件由第三方维护、通常滞后于 dsh，新版本可能让插件失效或页面打不开（插件市场就出过这种情况）。已装的其他版本会保留，随时可以切回。',
    notesUnavailable: '这个版本的更新内容不在最近的发布记录里。'
  },

  gone: {
    title: 'DSH-S 已退出',
    sub: '管理器已停止运行，这个页面可以关掉了。',
    close: '关闭页面'
  }
}
