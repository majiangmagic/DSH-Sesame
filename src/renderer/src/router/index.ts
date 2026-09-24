import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '@/views/HomeView.vue'
import LogView from '@/views/LogView.vue'
import PluginsView from '@/views/PluginsView.vue'
import SettingsView from '@/views/SettingsView.vue'
import VersionsView from '@/views/VersionsView.vue'
import SnapshotsView from '@/views/SnapshotsView.vue'

/**
 * 五个 tab 各是一个路由。
 *
 * 用 hash 模式：打包后页面由自定义协议（app://bundle）承载，hash 不参与服务端路径解析，
 * 不会有 history 模式那种"直接打开 /plugins 找不到文件"的问题。
 *
 * 视图**同步导入**，不用 `() => import()` 懒加载：
 * 原版把四个页面全放在 DOM 里，切 tab 是瞬时的；懒加载会让首次切到某个 tab 时先空白
 * 一下（等 chunk），既不像原版，也会让 tab 的入场动画看起来"迟到"。
 * 这些页面加起来只有几十 KB，又都是本地文件，同步导入没有代价。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/home' },
    { path: '/home', name: 'home', component: HomeView },
    { path: '/plugins', name: 'plugins', component: PluginsView },
    { path: '/log', name: 'log', component: LogView },
    { path: '/settings', name: 'settings', component: SettingsView },
    // DSH-Sesame 新增：版本管理独立成页（原版只有控制页顶部那几个作用于"当前版本"的按钮）
    { path: '/versions', name: 'versions', component: VersionsView },
    // 快照：profile 的 5 个配置文件，可存可回退（放 userData，覆盖安装不会清）
    { path: '/snapshots', name: 'snapshots', component: SnapshotsView },
    { path: '/:pathMatch(.*)*', redirect: '/home' }
  ]
})
