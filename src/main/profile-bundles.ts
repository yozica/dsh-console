/**
 * 临时停用 / 恢复一个 bundle —— 改 profile 的 `package.json` 里 `dsh.profile.bundles`。
 *
 * 这是**救援动作**：插件把 dsh 弄得起不来时，最快让人回到可用状态的办法就是把它从
 * bundle 列表里摘掉（dsh 启动时才读这份列表，所以摘完要重启）。跟补丁层那套的约定一致：
 *
 *   - 只动这一处，其余键（`dependencies`、`dsh.profile.patchReload`、name…）原样保留；
 *   - 写之前备份（`safe-file.ts`）、原子写；
 *   - **记得原位置**：bundle 的顺序就是层的顺序（后面的盖前面的），恢复时必须插回原来的
 *     位置，不能简单地追加到末尾 —— 否则「恢复」会悄悄改变层序。
 *
 * 解析用 JSON.parse：这份文件是 dsh 自己写的标准 JSON（不像 patch 层那样允许注释与
 * `!!js`），所以这里不需要按行改。代价是格式化会被重排（缩进仍是 2 空格），这是可接受的：
 * 备份里有原样。
 */

import fs from 'node:fs';
import path from 'node:path';

import { backupThenWrite } from './safe-file';

export interface BundleEditOutcome {
  /** 改完之后的完整文件内容（JSON 文本） */
  text: string;
  changed: boolean;
  /** 界面直接显示这句话 */
  detail: string;
  /** 被摘掉的那一项在 bundles 里的原位置（恢复时要用）；没改动时为 -1 */
  index: number;
}

export interface BundleEditResult {
  ok: boolean;
  error?: string;
  changed?: boolean;
  detail?: string;
  file?: string;
  backup?: string | null;
  /** 原位置（suspend 时给出来，恢复这个 bundle 时要带上） */
  index?: number;
}

interface ProfileManifestShape {
  name?: unknown;
  dsh?: { profile?: { bundles?: unknown; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
}

/** 读出 bundles 数组（不是数组就返回空数组，调用方据此报"这份 manifest 不对"） */
function readBundles(manifest: ProfileManifestShape): string[] {
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return [];
  return bundles.filter((item): item is string => typeof item === 'string');
}

function parseManifest(text: string): ProfileManifestShape | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? (value as ProfileManifestShape) : null;
  } catch {
    return null;
  }
}

/** 写回时保持 dsh 自己的写法：2 空格缩进 + 末尾换行 */
function stringifyManifest(manifest: ProfileManifestShape): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** 把它从 bundles 里摘掉，并记住原来的位置 */
export function suspendBundle(text: string, name: string): BundleEditOutcome {
  const manifest = parseManifest(text);
  if (!manifest) {
    return {
      text,
      changed: false,
      detail: '读不懂 profile 的 package.json（不是合法 JSON），先不动它。',
      index: -1,
    };
  }
  const bundles = readBundles(manifest);
  const index = bundles.indexOf(name);
  if (index === -1) {
    return { text, changed: false, detail: `bundle 列表里没有「${name}」。`, index: -1 };
  }
  const next = bundles.filter((item) => item !== name);
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } };
  return {
    text: stringifyManifest(manifest),
    changed: true,
    detail: `从 bundle 列表里摘掉了「${name}」（原来在第 ${index + 1} 位）`,
    index,
  };
}

/**
 * 从改动前的备份里找回它**原来**在第几位。
 *
 * 为什么需要：界面上的「恢复」只在"刚停用"那一次手里有 index（内存里那条记录），关掉页面 /
 * 重开应用之后就没有了 —— 而"恢复"插错位置会悄悄改掉层序。好在每次改动都会留一份
 * `package.json.bak-<时间戳>`，最近的那份里就写着它当时在第几位。取**最近的**一份含这个名字的
 * 备份（备份是按 mtime 排的），找不到就返回 null（调用方据此追加到末尾、并说实话）。
 */
export function recoverBundleIndex(
  profileDir: string,
  name: string,
): { index: number; from: string } | null {
  const prefix = 'package.json.bak-';
  let names: string[];
  try {
    names = fs.readdirSync(profileDir).filter((item) => item.startsWith(prefix));
  } catch {
    return null;
  }
  const files = names
    .map((item) => {
      const file = path.join(profileDir, item);
      try {
        return { item, file, at: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { item: string; file: string; at: number } => item !== null)
    .sort((a, b) => b.at - a.at);

  for (const candidate of files) {
    let text: string;
    try {
      text = fs.readFileSync(candidate.file, 'utf8');
    } catch {
      continue;
    }
    const manifest = parseManifest(text);
    if (!manifest) continue;
    const index = readBundles(manifest).indexOf(name);
    if (index !== -1) return { index, from: candidate.item };
  }
  return null;
}

/** 插回原来的位置（index 超出范围就追加到末尾） */
export function restoreBundle(text: string, name: string, index: number): BundleEditOutcome {
  const manifest = parseManifest(text);
  if (!manifest) {
    return {
      text,
      changed: false,
      detail: '读不懂 profile 的 package.json（不是合法 JSON），先不动它。',
      index: -1,
    };
  }
  const bundles = readBundles(manifest);
  if (bundles.includes(name)) {
    return { text, changed: false, detail: `bundle 列表里已经有「${name}」了。`, index: -1 };
  }
  const at =
    Number.isInteger(index) && index >= 0 && index <= bundles.length ? index : bundles.length;
  const next = [...bundles.slice(0, at), name, ...bundles.slice(at)];
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } };
  return {
    text: stringifyManifest(manifest),
    changed: true,
    detail: `把「${name}」放回 bundle 列表的第 ${at + 1} 位`,
    index: at,
  };
}

/** 落盘：profileDir 由调用方给（主进程那边是 `$DSH_HOME/profiles/web`） */
export function applyBundleEdit(
  profileDir: string,
  action: 'suspend' | 'restore',
  name: string,
  index = -1,
): BundleEditResult {
  const trimmed = String(name ?? '').trim();
  if (!/^[A-Za-z0-9@/._-]+$/.test(trimmed)) {
    return {
      ok: false,
      error: `bundle 名字看起来不对（收到的是「${trimmed}」），先不动你的文件。`,
    };
  }
  const file = path.join(profileDir, 'package.json');
  let current: string;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: `读不了 ${file}：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 「恢复」时没带位置（界面重开过，内存里那条"刚停用"的记录没了）→ 从改动前的备份里找。
  // 找不到就只能追加到末尾，并在 detail 里说清这是"末尾"、而不是它原来的位置。
  let recovery = '';
  let at = index;
  if (action === 'restore' && (!Number.isInteger(at) || at < 0)) {
    const found = recoverBundleIndex(profileDir, trimmed);
    if (found) {
      at = found.index;
      recovery = `（位置照 ${found.from} 里记着的原样）`;
    } else {
      recovery = '（没有它原来在第几位的记录，只能放在末尾）';
    }
  }

  const outcome =
    action === 'suspend' ? suspendBundle(current, trimmed) : restoreBundle(current, trimmed, at);
  if (!outcome.changed) {
    return {
      ok: true,
      changed: false,
      detail: outcome.detail,
      file,
      backup: null,
      index: outcome.index,
    };
  }

  let backup: string | null = null;
  try {
    backup = backupThenWrite(file, outcome.text);
  } catch (error) {
    return {
      ok: false,
      error: `写不了 ${file}：${error instanceof Error ? error.message : String(error)}`,
      file,
      backup,
    };
  }
  return {
    ok: true,
    changed: true,
    detail: `${outcome.detail}${recovery}`,
    file,
    backup,
    index: outcome.index,
  };
}
