#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里取出指定版本的条目，供 CI 当作 Release 正文。
 *
 *   npx tsx tools/changelog-extract.mts v0.2.1      # v 前缀可有可无
 *
 * 找不到条目、或条目为空，一律以非零码退出 —— 发版时宁可直接失败，
 * 也不要发出一个没有说明的 Release（缘由见 CHANGELOG.md 顶部）。
 *
 * `extractChangelog` 是导出的纯函数，`test/selftest.ts` 直接调它来测，
 * 不必再 spawn 一个 node 进程（受限环境里 spawn 不一定可用）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 转义正则元字符：不转的话 0.2.1 里的点会变成"任意字符" */
function escapeRe(text: string): string {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 取某个版本的条目（含 `## [x.y.z] - 日期` 标题行）。
 * 只认 `## [0.2.1]`、`## [0.2.1] - 2026-09-15`、`## 0.2.1` 这几种写法。
 *
 * @param markdown CHANGELOG 全文
 * @param version  形如 `0.2.1` 或 `v0.2.1`
 * @returns        条目正文；没有这一版时返回 null
 */
export function extractChangelog(markdown: string, version: string): string | null {
  const wanted = String(version || '')
    .trim()
    .replace(/^v/i, '');
  if (!wanted) return null;

  const lines = String(markdown || '').split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRe(wanted)}\\]?(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;

  // 往下找到下一个二级标题为止；末尾的 `[Unreleased]` 与更早的版本都会被这条挡住
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').replace(/\s+$/, '');
}

// 直接当脚本跑时：取参数、打印、必要时以非零码退出
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version) {
    console.error('用法: npx tsx tools/changelog-extract.mts <version>   例如 v0.2.1');
    process.exit(2);
  }

  let markdown = '';
  try {
    markdown = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch (error) {
    console.error(`读不到 CHANGELOG.md：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const section = extractChangelog(markdown, version);
  if (!section) {
    console.error(`CHANGELOG.md 里没有 ${version} 的条目 —— 发版前先在 CHANGELOG.md 里写这一版`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
