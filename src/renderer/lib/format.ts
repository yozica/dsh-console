/**
 * 把数字说成人话。外壳、控制台页、启动锁都要用，所以放在这里共用。
 */

/** 毫秒 → 「1 小时 2 分 3 秒」/「2 分 3 秒」/「3 秒」 */
export function formatUptime(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分 ${s} 秒`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

/** 把毫秒数说成人话：3000 → 「3 秒」（以前直接把 ms 当秒显示，成了「3000 秒」） */
export function formatDurationMs(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '0 秒';
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  const seconds = value / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
}

/**
 * 相对时间：「刚刚 / 3 分钟前 / 2 小时前 / 1 天前」。
 * 用于「上次检查」这类"离现在多久"的说明 —— 判定函数不看时钟，时刻由调用方给。
 */
export function formatAgo(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 字节数说成人话：1536 → 「1.5 KB」/「2.00 GB」（门禁与详情层的下载进度共用） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}
