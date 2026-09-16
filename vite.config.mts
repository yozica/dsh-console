import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

/**
 * file:// 下不能加载 ES module（模块脚本一律走 CORS 检查，而 file:// 的 origin 是 null），
 * 所以把产物里的 <script type="module"> 改回普通脚本。
 * 前提是产物必须是**单个自包含 chunk**（不含 import/export），因此：
 *   - 入口只用静态 import（动态 import 会切出第二个 chunk，就跨不了模块边界了）
 *   - 关掉 modulePreload，避免注入 <link rel="modulepreload">
 * 顺手去掉 crossorigin —— file:// 下带它的样式表同样会走 CORS。
 */
function classicScriptPlugin(): Plugin {
  return {
    name: 'dsh-classic-script',
    enforce: 'post',
    transformIndexHtml(html: string) {
      return html
        .replace(/<script type="module" crossorigin /g, '<script defer ')
        .replace(/<script type="module" /g, '<script defer ')
        .replace(/ crossorigin(?=[^>]*href="\.\/assets\/)/g, '')
    }
  }
}

/**
 * 渲染层构建配置。
 *
 * - root 指到 src/renderer：index.html 仍是页面入口
 * - base './'：产物要被 Electron 以 file:// 打开，必须相对路径
 * - outDir 到项目根的 dist/renderer，主进程从那里加载（见 src/main/main.js）
 * - target esnext：只跑在 Electron 内置的 Chromium 里，不需要为老浏览器降级
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // <webview> 是 Electron 的原生自定义元素，不是 Vue 组件：
          // 不声明的话编译器会尝试解析组件并告警（内嵌页全靠它）。
          isCustomElement: (tag) => tag === 'webview'
        }
      }
    }),
    classicScriptPlugin()
  ],
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: true,
    assetsInlineLimit: 0,
    modulePreload: false,
    rollupOptions: {
      output: {
        // 不切分：保证产物是自包含的普通脚本（跨 chunk 就必须用模块语法）
        codeSplitting: false
      }
    }
  }
})
