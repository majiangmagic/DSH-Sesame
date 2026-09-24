<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import WinControls from '@/components/WinControls.vue'
import { useUiStore } from '@/stores/ui'
import { useVersionsStore } from '@/stores/versions'
import { api } from '@/api'

/**
 * 顶栏 + 页面容器。
 *
 * 三处与原版脚本等价、但必须重写的交互：
 *  1. tab 切换：原版靠 `data-tab` + 显示/隐藏 `.page`，这里交给 vue-router；
 *  2. 胶囊指示器：原版把 `--tab-x` / `--tab-width` 写到 nav 上，让 `nav::before` 滑过去；
 *  3. 页面进入动画：原版按 tab 顺序给 `.page` 加 `view-enter-next` / `view-enter-prev`。
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

/**
 * 顺序即左右方向，决定切换时的动画朝向。
 *
 * 「版本」按需求紧跟在「控制」后面 —— 控制页只负责"启哪个版本"，版本管理就在它隔壁。
 * 其余三个（插件 / 终端 / 设置）保持原版的相对顺序。
 */
const TABS: Array<{ path: string; label: string }> = [
  { path: '/home', label: 'nav.home' },
  { path: '/versions', label: 'nav.versions' },
  { path: '/plugins', label: 'nav.plugins' },
  { path: '/log', label: 'nav.log' },
  { path: '/settings', label: 'nav.settings' }
]

const version = __APP_VERSION__
const ui = useUiStore()
const versions = useVersionsStore()

/**
 * 端口回退提示。
 *
 * 设置里是固定端口（默认 3080），但 runner 发现被占用时会**回退到系统分配的空闲端口**
 * 并只在终端页写一行日志 —— 用户在控制页只看到地址变了，不知道发生了什么
 * （"换了倒是弹个气泡告诉一声啊"）。
 *
 * 这里不新增 IPC：就绪地址里带着真实端口，和设置里的端口一比就知道有没有回退。
 * 每个地址只提示一次，避免轮询反复弹。
 */
const configuredPort = ref<number | null>(null)
let noticedUrl = ''

void api.getSettings().then((s) => {
  configuredPort.value = s.port
})

watch(
  () => versions.running?.url ?? '',
  (url) => {
    if (url === '' || url === noticedUrl || configuredPort.value === null) return
    let actual = 0
    try {
      actual = Number(new URL(url).port)
    } catch {
      return
    }
    if (actual === 0 || actual === configuredPort.value) return
    noticedUrl = url
    ui.showBubble(
      t('home.portFallback', { configured: configuredPort.value, actual })
    )
  },
  { immediate: true }
)
const navEl = ref<HTMLElement | null>(null)
const transitionClass = ref('')
/** 启动器自身有新版本时才显示；本阶段没有逻辑驱动，恒为 false */
const hasLauncherUpdate = ref(false)

let lastIndex = Math.max(0, TABS.findIndex((tab) => tab.path === route.path))

/** 把胶囊指示器挪到当前 tab 下（原版就是这两个变量的语义：offsetLeft / offsetWidth） */
function movePill(): void {
  const nav = navEl.value
  if (!nav) return
  const active = nav.querySelector<HTMLButtonElement>('button.view-active')
  if (!active) return
  nav.style.setProperty('--tab-x', `${active.offsetLeft}px`)
  nav.style.setProperty('--tab-width', `${active.offsetWidth}px`)
}

watch(
  () => route.path,
  async (path) => {
    const index = TABS.findIndex((tab) => tab.path === path)
    if (index >= 0 && index !== lastIndex) {
      transitionClass.value = index > lastIndex ? 'view-enter-next' : 'view-enter-prev'
      lastIndex = index
    }
    await nextTick()
    movePill()
  }
)

function onResize(): void {
  movePill()
}

onMounted(() => {
  movePill()
  // 字体加载完成后按钮宽度会变，指示器必须重算，否则会停在偏左的位置
  void document.fonts?.ready.then(() => movePill())
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => window.removeEventListener('resize', onResize))
</script>

<template>
  <header>
    <div class="logo-block">
      <div class="logo">{{ t('app.title') }}</div>
      <span class="app-version" id="appVer">{{ version }}</span>
      <button type="button" class="self-upgrade" id="selfUpdate" :hidden="!hasLauncherUpdate">
        {{ t('home.actionUpdate') }}
      </button>
    </div>
    <div class="header-actions">
      <nav ref="navEl">
        <button
          v-for="tab in TABS"
          :key="tab.path"
          :class="{ 'view-active': route.path === tab.path }"
          @click="router.push(tab.path)"
        >
          {{ t(tab.label) }}
        </button>
      </nav>
      <WinControls />
    </div>
  </header>
  <!--
    轻提示气泡。挂在 header 之后，任何页面都能看到 —— 端口回退发生在"启动"那一刻，
    而那时用户可能已经切到别的标签页了。
  -->
  <div v-if="ui.bubble" class="app-bubble" role="status">{{ ui.bubble }}</div>

  <main>
    <router-view v-slot="{ Component }">
      <component :is="Component" :class="transitionClass" />
    </router-view>
  </main>
</template>
