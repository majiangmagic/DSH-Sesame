import type zhCN from './zh-CN'

/**
 * English copy.
 *
 * 用 `typeof zhCN` 约束形状：中文那边加了 key 而这里忘了补，`vue-tsc` 会直接报错，
 * 不会等到运行时才发现界面上冒出一个英文 key。
 * 品牌名统一为 DSH-S。
 */
const enUS: typeof zhCN = {
  app: {
    title: 'DSH-S'
  },

  common: {
    loading: 'Loading…',
    /** Marks areas still backed by sample data so it is not mistaken for real state */
    sampleData: 'Sample data',
    sampleHint: 'This area is not wired to real logic yet; it shows sample data.'
  },

  /** In-progress notices for the Control page hint line */
  progress: {
    starting: 'Starting…',
    stopping: 'Stopping…',
    restarting: 'Restarting…',
    updating: 'Updating…',
    installing: 'Installing…',
    uninstalling: 'Uninstalling…',
    downloading: 'Downloading…'
  },

  /** Version management（real scan in the main process + npm registry） */
  versions: {
    title: 'Version management',
    subtitle: '{installed} installed · {remote} remote',
    refresh: 'Reload',
    noRemote: 'No versions were read (this happens when the remote fetch fails).',
    download: 'Download',
    downloading: 'Downloading…',
    uninstall: 'Uninstall',
    uninstalling: 'Uninstalling…',
    uninstallRunningHint: 'A running version cannot be uninstalled — stop it first',
    managedMeta: 'Installed by this app',
    notInstalled: 'Not installed',
    localOnly: 'Local version (not in the remote list)',
    rootHint:
      'Versions are installed in {dir}; plugins and data always live in .dsh in your home directory and are not removed with a version.',
    remoteFailed: 'Could not read the remote version list: {message}'
  },

  nav: {
    home: 'Control',
    plugins: 'Plugins',
    log: 'Log',
    settings: 'Settings',
    versions: 'Versions'
  },

  window: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    close: 'Close'
  },

  home: {
    versionLabel: 'Version',
    loadingVersion: 'Loading…',
    noVersions: 'No versions',
    hint: 'Plugins and data live in .dsh in your home directory.',
    actionUpdate: 'Update',
    actionStart: 'Start',
    actionStop: 'Stop'
  },

  plugins: {
    title: 'Plugins',
    refresh: 'Refresh',
    empty: 'No plugins installed in this profile.',
    disabled: 'Disabled',
    rows: 'rows {ids}',
    subtitle: '{profile} profile · {total} total · {on} enabled',
    willEnable: 'Enable {name} (removes its disabled row from cordis.patch.yml)',
    willDisable: 'Disable {name} (writes disabled: true for its row in cordis.patch.yml)',
    /**
     * Why a plugin cannot be toggled.
     *
     * Two strings per reason: the short one goes into `.plugin-meta` (it shares a single line
     * with the version and row ids, so it must stay short); the `*Why` one becomes the row's
     * `title` and explains the real reason where there is room to be clear.
     */
    reason: {
      noRows: 'No toggleable loader row',
      official: 'Official component — no toggle',
      market: 'Market-owned row — no toggle',
      noRowsWhy:
        'This package injects no loader row into the profile. It is a client-side plugin mounted at runtime by the plugin marketplace, so the patch layer has no row to write — there is nowhere for a toggle to land.',
      officialWhy:
        'Official runtime component (@deepseek-ai/*). Its loader rows are shared by several official packages; disabling any one of them can stop dsh from starting at all, so no toggle is offered.',
      marketWhy:
        'These row ids belong to the plugin marketplace’s own namespace (mkt- / client- / include:). Writing them into the patch layer would leave orphaned patches pointing at rows that no longer exist once the marketplace is removed or renamed — so it owns them and no toggle is exposed.'
    }
  },

  /** Plugin marketplace (a DSH-Sesame addition; data comes from the bundled dshmarket library) */
  market: {
    title: 'Plugin marketplace',
    subtitle: '{total} in catalog · {installed} installed',
    refresh: 'Reload catalog',
    searchPlaceholder: 'Search name / author / description',
    allCategories: 'All',
    noMatch: 'No matching plugins.',
    clearFilters: 'Clear filters',
    showing: 'Showing {shown} of {matched} matches',
    hidden: '{count} more not shown — narrow it down with search or a category',
    loadMore: 'Load more ({count} left)',
    sortDefault: 'Catalog order',
    sortStars: 'By stars',
    sortDownloads: 'By downloads',
    sortName: 'By name',
    sortHint: 'Cycle: catalog order → stars → downloads → name',
    sameName: 'same name ×{count}',
    sameNameHint:
      'Several packages by different authors share this short name. “Installed” is matched by npm package name, so only the one you actually installed is marked.',
    starsHint: 'GitHub stars (from the catalog)',
    downloadsHint: 'Interval downloads (from the catalog)',
    installTitle: 'Install command: {command}',
    repo: 'Repo',
    openRepo: 'Open the repository page in your browser',
    page: 'Market page',
    openPage: 'Open this plugin’s detail page on the market site',
    unlisted:
      '{count} installed plugin(s) are not in the catalog: {names} (unlisted ones do not appear here but still work)',
    install: 'Download',
    installing: 'Downloading…',
    uninstall: 'Uninstall',
    uninstalling: 'Uninstalling…',
    uninstallTitle: 'Uninstall command: {command}',
    installPending: 'Installing is not wired up yet'
  },

  status: {
    latest: 'Latest',
    installed: 'Installed',
    running: 'Running',
    stopped: 'Stopped',
    starting: 'Starting',
    stopping: 'Stopping',
    installing: 'Installing'
  },

  log: {
    clear: 'Clear'
  },

  settings: {
    autoStart: 'Start at login',
    seedMarket: 'Plugin marketplace',
    autoDisable: 'Compatibility mode',
    advanced: 'Advanced',
    profile: 'Start profile',
    port: 'Manager port',
    uiLang: 'Interface language',
    args: 'Extra startup arguments',
    argsPlaceholder: 'e.g. --log-level debug',
    argsHint:
      'Appended to the end of the dsh command line (split on spaces; quote values with spaces). Installed plugins and data are unaffected.',
    dataDir: 'Version directory',
    browse: 'Browse…',
    save: 'Save',
    saved: 'Saved.'
  },

  modal: {
    updateAvailable: 'Update available',
    notNow: 'Not now',
    actionFailed: 'Action failed',
    ok: 'OK'
  },

  ask: {
    dshItself: 'dsh itself',
    launcherItself: 'Launcher',
    updateTo: 'Update to {latest}',
    risk:
      'Upgrading stops the running dsh, then downloads and installs the new version. Plugins are maintained by third parties and usually lag behind dsh, so a new version can break them or stop a page from opening (that happened to the plugin market). Other installed versions are kept, so you can switch back any time.',
    notesUnavailable: 'This version is not in the recent release notes.'
  },

  gone: {
    title: 'DSH-S has exited',
    sub: 'The manager has stopped; this page can be closed.',
    close: 'Close page'
  }
}

export default enUS
