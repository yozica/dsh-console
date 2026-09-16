/**
 * 构建包装：在"子进程不能用管道"的环境里也能跑 Vite。
 *
 * 背景：Vite 的 optimizeSafeRealPathSync() 会 `exec('net use')` 探测 Windows 网络驱动器，
 * 而受限沙箱禁止任何带管道 stdio 的子进程（spawn EPERM），于是整个构建直接失败。
 * 那段探测只在"本机确实有映射的网络驱动器"时才有意义，所以这里把它短路成
 * "没有任何网络驱动器" —— 与普通开发机的默认结果一致，语义等价。
 *
 * 用法：npx tsx scripts/build.mts        （等价于 vite build）
 *      npx tsx scripts/build.mts --watch
 *
 * 正常环境直接 `npm run build` 即可，不需要这个包装。
 */

import { createRequire } from 'node:module'
import type { ChildProcess, ExecException, ExecOptions } from 'node:child_process'

/** exec 的回调形态（本包装只用到前两个参数，stdout / stderr 保持可选） */
type ExecCallback = (error: ExecException | null, stdout?: string, stderr?: string) => void

/**
 * 本包装只用到 exec 的"命令 + 选项 + 回调"这一种形态。
 * 不直接用 `typeof import('node:child_process')`：真实的 exec 是一组重载，
 * 而这里的写法是**一个实现接住所有形态**（运行时本来如此），与重载类型不相容。
 */
interface PatchedChildProcess {
  exec(
    command: string,
    options?: ExecOptions | ExecCallback,
    callback?: ExecCallback
  ): ChildProcess | undefined
}

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process') as PatchedChildProcess

const realExec = childProcess.exec
let bypassed = 0

childProcess.exec = function exec(
  this: unknown,
  cmd: string,
  options?: ExecOptions | ExecCallback,
  callback?: ExecCallback
): ChildProcess | undefined {
  const command = String(cmd)
  if (/^\s*net\s+use\b/i.test(command)) {
    bypassed += 1
    const done = typeof options === 'function' ? options : callback
    // 空 stdout：Vite 会把 windowsNetworkMap 判为空，从而退回 fs.realpathSync.native
    if (typeof done === 'function') process.nextTick(() => done(null, ''))
    return undefined
  }
  return realExec.call(this, cmd, options, callback)
}

const { build } = await import('vite')

try {
  await build({ mode: process.argv.includes('--watch') ? 'development' : 'production' })
  console.log('构建完成' + (bypassed > 0 ? `（已短路 ${bypassed} 次 net use 探测）` : ''))
} catch (error) {
  // 与迁移前一致：优先打印 error.message，拿不到 message 时把原值打出来
  console.error('构建失败：', (error as { message?: unknown } | null)?.message || error)
  process.exitCode = 1
}
