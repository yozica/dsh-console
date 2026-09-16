/**
 * 渲染层入口（由 Vite 构建）。
 *
 * 顺序有讲究，别调换：
 *   1. xterm 自带的样式在前、我们的 styles.css 在后（同权重靠顺序决定谁生效）
 *   2. app.ts 先求值（应用级胶水），再建立共享状态、挂载 Vue 组件
 *
 * 入口刻意**不用动态 import**：那会切出第二个 chunk，跨 chunk 就必须用模块语法，
 * 而产物是给 file:// 用的普通脚本（见 vite.config.mjs 的 classicScriptPlugin）。
 */

// 顺序要紧：xterm 自带的样式先加载，我们的 styles.css 最后 ——
// 两者对 .xterm-viewport 的规则同权重，靠顺序决定谁生效（踩过：黑底没被覆盖掉）
import '@xterm/xterm/css/xterm.css'
import './styles.css'

import './app.js'

import { installDevDiagnostics } from './dev-diagnostics.js'
import { snapshot, startStore } from './lib/store.js'
import { mountAll } from './mount.js'

// 先建立唯一的快照订阅，再挂载（组件一挂上就要读数据）
startStore().then(() => {
  // 诊断快捷键只在开发态装（打包后不装）。
  // 注意：这里必须用静态 import + 运行时判断，不能动态 import ——
  // 动态 import 会切出第二个 chunk，产物就不能是单文件普通脚本了（自检守着这条）。
  if (!snapshot.value?.env?.packaged) installDevDiagnostics()
})
mountAll()
