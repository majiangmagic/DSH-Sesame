import { createRouter, createWebHashHistory } from 'vue-router'
import ControlView from '@/domain/control/ControlView.vue'
import VersionsView from '@/domain/versions/VersionsView.vue'
import PluginsView from '@/domain/plugins/PluginsView.vue'
import TerminalView from '@/domain/terminal/TerminalView.vue'
import SnapshotsView from '@/domain/snapshots/SnapshotsView.vue'
import SettingsView from '@/domain/settings/SettingsView.vue'

/**
 * 6 个标签页各是一个路由。
 *
 * **路由名与 `domain/` 的目录名、`nav.*` 的 i18n key 完全一致** ——
 * 控制 control · 版本 versions · 插件 plugins · 终端 terminal · 快照 snapshots · 设置 settings。
 * 三处同名是刻意的：从任何一个入口（URL / 目录 / 文案 key）都能直接找到另外两个。
 *
 * 用 hash 模式：打包后页面由自定义协议（app://bundle）承载，hash 不参与服务端路径解析，
 * 不会有 history 模式那种"直接打开 /plugins 找不到文件"的问题。
 *
 * 视图**同步导入**，不用 `() => import()` 懒加载：
 * 原版把几个页面全放在 DOM 里，切 tab 是瞬时的；懒加载会让首次切到某个 tab 时先空白
 * 一下（等 chunk），既不像原版，也会让 tab 的入场动画看起来"迟到"。
 * 这些页面加起来只有几十 KB，又都是本地文件，同步导入没有代价。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/control' },
    { path: '/control', name: 'control', component: ControlView },
    { path: '/versions', name: 'versions', component: VersionsView },
    { path: '/plugins', name: 'plugins', component: PluginsView },
    { path: '/terminal', name: 'terminal', component: TerminalView },
    { path: '/snapshots', name: 'snapshots', component: SnapshotsView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/:pathMatch(.*)*', redirect: '/control' }
  ]
})
