/**
 * 写用户文件的两个公共动作：**先备份，再原子写**。
 *
 * 为什么单独一个模块：现在有两处会写用户的东西 —— 插件页的补丁层（`cordis.patch.yml`）
 * 与救援动作的 bundle 列表（profile 的 `package.json`）。这两处都必须做到同一件事：
 *
 *   1. 动手之前把原文件复制成 `<file>.bak-<yyyymmdd-hhmmss>`（可回退，且备份本身就是
 *      「我刚才改了什么」的证据）；
 *   2. 写的时候先写同目录临时文件再 rename 覆盖 —— 中途崩掉时原来的文件还在。
 *
 * 不做的事：不改内容、不解析、不判断该不该写。内容由调用方负责（见 patch-layer.ts）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 备份文件名后缀：`20260918-134302`（跟历史上手工备份的命名一致） */
export function backupStamp(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 备份 + 原子写。返回备份文件路径（原文件不存在时为 null —— 那种情况没有东西可备份）。
 * 写失败会抛出（调用方负责转成人话）。
 */
export function backupThenWrite(file: string, content: string): string | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${backupStamp()}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  return backup;
}

/** 从备份还原（救援动作回滚用）：没有备份说明改动前不存在，那就删掉 */
export function restoreFromBackup(file: string, backup: string | null): boolean {
  try {
    if (backup) fs.copyFileSync(backup, file);
    else fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
