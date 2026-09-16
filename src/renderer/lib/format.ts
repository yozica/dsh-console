/**
 * 把数字说成人话。外壳、控制台页、启动锁都要用，所以放在这里共用。
 */

/** 毫秒 → 「1 小时 2 分 3 秒」/「2 分 3 秒」/「3 秒」 */
export function formatUptime(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '—'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h} 小时 ${m} 分 ${s} 秒`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}

/** 把毫秒数说成人话：3000 → 「3 秒」（以前直接把 ms 当秒显示，成了「3000 秒」） */
export function formatDurationMs(ms: unknown): string {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '0 秒'
  if (value < 1000) return `${Math.round(value)} 毫秒`
  const seconds = value / 1000
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`
}
