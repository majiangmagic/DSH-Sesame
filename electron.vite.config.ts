import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * 三段构建：main / preload / renderer。
 * 入口沿用 electron-vite 约定，不显式指定，减少配置漂移：
 *   src/main/index.ts · src/preload/index.ts · src/renderer/index.html
 *
 * 产物目录 `compiled/`（框架默认叫 `out/`，改成 `compiled` 是因为 `out` 看不出内容：
 * `src/` 是源码，`compiled/` 是编译后能跑的代码）。
 *
 * **必须留在项目内。** 实测把 outDir 指到项目外（D:\agent\DSH-Sesame-compiled）会出事：
 * `npm run dist` 跑到打包阶段报 `ENOENT ...\main\index.js`，事后整个外部目录被清空 ——
 * 构建链里有环节会清理 outDir，而项目外的目录不在 Vite 的"不自动清理"保护范围内。
 * 而且 electron-builder 的 files 本来就以项目目录为根。
 */
const root = process.cwd()
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared'),
        '@utils': resolve(root, 'src/utils')
      }
    },
    build: { outDir: 'compiled/main' }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared'),
        '@utils': resolve(root, 'src/utils')
      }
    },
    build: { outDir: 'compiled/preload' }
  },
  renderer: {
    resolve: {
      alias: {
        // 渲染层的根就是 src/renderer（Vite 的 root 也是它），不再多套一层 src
        '@': resolve(root, 'src/renderer'),
        '@shared': resolve(root, 'src/shared'),
        '@utils': resolve(root, 'src/utils')
      }
    },
    plugins: [vue()],
    // 原版把版本号写在校验占位符 __APP_VERSION__ 里，由服务端替换；这里改成构建期注入
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    build: {
      outDir: 'compiled/renderer',
      // 看板娘与背景图是二进制大件，交给 Vite 原样拷贝，别内联成 base64
      assetsInlineLimit: 0
    }
  }
})
