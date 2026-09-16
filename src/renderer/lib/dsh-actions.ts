/**
 * 需要"先确认再动手"的 dsh 操作。
 *
 * 这些流程有分支（外部实例要先征求同意、失败要报错），原先写在 app.ts 里，
 * 现在控制台页、Harness 页、归档页都要用，所以抽出来共用。
 * 依赖通过参数传入，模块本身不持有状态。
 */

import type { DshConsoleApi, DshSnapshot } from '../../shared/ipc'

/** 读取当前 dsh 状态的取值函数（各页传 `() => dsh.value` 这样进来） */
type GetDsh = () => DshSnapshot | null

/** 结束外部实例前先问一次：它会强制结束整棵进程树 */
async function confirmKillExternal(api: DshConsoleApi, dsh: DshSnapshot): Promise<boolean> {
  return api.confirm({
    type: 'warning',
    title: '结束外部 dsh 实例',
    message: `PID ${dsh.externalPid} 不是本应用启动的，确定要结束它吗？`,
    detail: '结束外部实例会强制结束该进程树，未保存的会话可能丢失。'
  })
}

/** 「停止」：外部实例先确认再强杀；自家实例走优雅退出（Ctrl+C → 超时才强杀） */
export async function stopFlow(api: DshConsoleApi, getDsh: GetDsh): Promise<void> {
  const dsh = getDsh()
  if (!dsh?.owned && dsh?.externalPid) {
    if (!(await confirmKillExternal(api, dsh))) return
    await api.stop({ killExternal: true, force: true })
    return
  }
  await api.stop({})
}

/** 「强制结束进程树」：跳过 Ctrl+C 的兜底手段，始终先确认 */
export async function forceStopFlow(api: DshConsoleApi): Promise<void> {
  const ok = await api.confirm({
    type: 'warning',
    title: '强制结束',
    message: '直接强制结束整棵进程树？',
    detail: '这会跳过 Ctrl+C 优雅退出，dsh 没有机会清理子进程或落盘。'
  })
  if (!ok) return
  await api.stop({ force: true, killExternal: true })
}

/**
 * 重启。受管实例直接重启；外部实例要先征求同意再结束，然后由本应用拉起
 * —— 顺带把新的访问令牌捕获回来，内嵌界面才可用。
 */
export async function restartFlow(api: DshConsoleApi, getDsh: GetDsh): Promise<void> {
  const dsh = getDsh()
  if (!dsh?.owned && dsh?.externalPid) {
    const ok = await api.confirm({
      type: 'warning',
      title: '重启外部实例',
      message: `PID ${dsh.externalPid} 是外部启动的，重启需要先结束它。`,
      detail: '结束后本应用会立刻用自己的方式重新拉起 dsh，并捕获新的访问令牌，内嵌界面随即可用。'
    })
    if (!ok) return
    await api.stop({ killExternal: true, force: true })
    const started = await api.start()
    if (!started.ok) alert(`启动失败：${started.error}`)
    return
  }
  const result = await api.restart()
  if (!result.ok) alert(`重启失败：${result.error}`)
}

/**
 * 「在浏览器打开」。没有带令牌的地址时（外部实例）先说清后果再问一次：
 * 裸地址只在浏览器已存有登录 cookie 时可用。
 */
export async function openUiExternally(api: DshConsoleApi, getDsh: GetDsh): Promise<void> {
  const dsh = getDsh()
  const url = dsh?.uiUrl
  if (!url) {
    const ok = await api.confirm({
      type: 'info',
      title: '没有带令牌的地址',
      message: '这个 dsh 不是本应用启动的，我拿不到访问令牌。',
      detail:
        '裸地址在没登录过的浏览器里会返回 401。如果你之前已经在浏览器里打开过 dsh 打印的那条地址，浏览器已存有登录 cookie，直接打开裸地址通常也能进。要继续打开裸地址吗？'
    })
    if (!ok) return
    if (dsh) await api.openExternal(`${dsh.origin}/`)
    return
  }
  await api.openExternal(url)
}
