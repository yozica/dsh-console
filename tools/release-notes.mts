#!/usr/bin/env node
/**
 * 生成 Release 的**标题与正文**（CI 的 publish job 用它，不再手写模板）。
 *
 *   npx tsx tools/release-notes.mts v0.3.0                 # 打印正文
 *   npx tsx tools/release-notes.mts v0.3.0 --title         # 只打印标题
 *   npx tsx tools/release-notes.mts v0.3.0 --assets ass.txt --out .release
 *
 * 三块内容，各有单一来源：
 *   1. **标题** = `v<版本>: <主题>`，主题来自 CHANGELOG 标题行末尾的 `: 主题`
 *      （`## [0.3.0] - 2026-09-17: TypeScript 迁移与工具链整理`）。没写主题时退化成 `v0.3.0`。
 *   2. **正文主体** = CHANGELOG 里这一版的条目（去掉标题行，因为 H1 已经写了版本与主题）。
 *   3. **安装清单** = `--assets` 传进来的**真实产物文件名**（`ls` 的输出）—— 不手写文件名，
 *      免得改了 `productName` 或 electron-builder 版本之后正文与实际对不上。
 *
 * 传了 `--assets` 时还会**校验四类核心产物是否齐**（Windows 安装包 / 便携版、macOS 的 arm64 与
 * x64 dmg）。缺任何一类都以非零码退出：宁可这一次不发，也不要发出一个"说明里让用户去下、页面上
 * 却没有"的 Release（v0.2.0 就是这么坏的）。
 *
 * 导出的是纯函数，`test/selftest.ts` 直接调它们来测，不必 spawn 进程。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractChangelog } from './changelog-extract.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 标题行里的主题分隔符：`v0.3.0: 主题` 这种写法用 `: `；也认 `—— 主题`（早期条目就是这么写的） */
const TOPIC_RE = /(?:\s(?:——|--)\s*|\s*:\s+)(\S.*)$/;

export interface ReleaseNotes {
  title: string;
  body: string;
}

/**
 * 从 CHANGELOG 的标题行里取主题。
 * `## [0.3.0] - 2026-09-17: TypeScript 迁移` → `TypeScript 迁移`；没写就返回 null。
 */
export function extractTopic(headingLine: string): string | null {
  const matched = TOPIC_RE.exec(String(headingLine || ''));
  return matched ? matched[1].trim() : null;
}

/** Release 标题：有主题就 `v0.3.0: 主题`，没有就只写版本号 */
export function releaseTitle(version: string, topic: string | null): string {
  const clean = String(version).trim().replace(/^v/i, '');
  return topic ? `v${clean}: ${topic}` : `v${clean}`;
}

export interface ClassifiedAssets {
  /** 给人下载的产物，按展示顺序 */
  downloads: { label: string; file: string }[];
  /** 只给更新器看的东西（latest.yml / *.blockmap） */
  metadata: string[];
  /** 四类核心产物里缺了谁（非空表示这次不该发） */
  missing: string[];
}

const REQUIRED_LABELS = [
  'Windows 安装包',
  'Windows 便携版',
  'macOS arm64（dmg）',
  'macOS x64（dmg）',
];

/** 按文件名把产物归类；只看名字，不看大小 —— 名字就是 electron-builder 的产物名 */
export function classifyAssets(files: string[]): ClassifiedAssets {
  const names = files.map((file) => path.basename(file.trim())).filter(Boolean);
  const downloads: { label: string; file: string }[] = [];
  const missing: string[] = [];

  /** 一类产物取第一个匹配的；`required` 的类别缺失会进 missing（= 这次不该发） */
  const take = (label: string, test: (name: string) => boolean, required = true): void => {
    const file = names.find(test);
    if (file) downloads.push({ label, file });
    else if (required) missing.push(label);
  };

  take('Windows 安装包', (n) => /setup/i.test(n) && n.endsWith('.exe'));
  take('Windows 便携版', (n) => n.endsWith('.exe') && !/setup/i.test(n));
  take('macOS arm64（dmg）', (n) => n.endsWith('-arm64.dmg'));
  take('macOS x64（dmg）', (n) => n.endsWith('.dmg') && !n.endsWith('-arm64.dmg'));
  // zip 与 blockmap 可能被手动清理掉，所以不算"必须存在"
  take('macOS arm64（zip，免安装）', (n) => n.endsWith('-arm64.zip'), false);
  take('macOS x64（zip，免安装）', (n) => n.endsWith('.zip') && !n.endsWith('-arm64.zip'), false);

  const listed = new Set(downloads.map((item) => item.file));
  return {
    downloads,
    metadata: names.filter((name) => !listed.has(name)),
    missing: REQUIRED_LABELS.filter((label) => missing.includes(label)),
  };
}

/** 拼正文：H1（版本 + 主题）→ CHANGELOG 条目 → 安装清单 */
export function composeReleaseNotes(params: {
  version: string;
  topic: string | null;
  /** CHANGELOG 条目全文（含标题行） */
  entry: string;
  assets: string[] | null;
}): string {
  const version = String(params.version).trim().replace(/^v/i, '');
  const entryLines = params.entry.split('\n');
  entryLines.shift(); // 去掉 `## [x.y.z] - 日期 —— 主题` 那行：H1 已经写了
  const body = entryLines.join('\n').trim();

  const parts = [`# DSH Console v${version}${params.topic ? `: ${params.topic}` : ''}`, body];

  if (params.assets) {
    const { downloads, metadata, missing } = classifyAssets(params.assets);
    if (missing.length > 0) {
      throw new Error(`产物不全，缺：${missing.join('、')} —— 不发产物不全的 Release（宁可不发）`);
    }
    const rows = downloads.map((item) => `| ${item.label} | \`${item.file}\` |`).join('\n');
    const metadataLine =
      metadata.length > 0
        ? `\n另有 ${metadata.map((name) => `\`${name}\``).join(' / ')}：更新器用的元数据与差分索引` +
          '（应用当前没接自动更新，下载上面的安装包即可）。\n'
        : '';
    parts.push(
      [
        '---',
        '',
        '## 安装',
        '',
        '| 平台 | 文件 |',
        '| --- | --- |',
        rows,
        metadataLine,
        'macOS 包是 **ad-hoc 签名**（没有 Apple 开发者证书），首次打开会被 Gatekeeper 拦下：' +
          '**右键 →「打开」**，或到「系统设置 → 隐私与安全性」点「仍要打开」；' +
          '也可以直接去掉下载隔离属性：`xattr -dr com.apple.quarantine "/Applications/DSH Console.app"`。',
      ].join('\n'),
    );
  }

  return `${parts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

/** 从 CHANGELOG 里取出这一版的条目；没有就抛错（与 changelog-extract 一样：宁可不发） */
export function buildReleaseNotes(options: {
  markdown: string;
  version: string;
  assets: string[] | null;
}): ReleaseNotes {
  const version = String(options.version).trim().replace(/^v/i, '');
  const entry = extractChangelog(options.markdown, version);
  if (!entry) {
    throw new Error(
      `CHANGELOG.md 里没有 ${version} 的条目 —— 发版前先用 npm run release:prepare 汇总`,
    );
  }
  const topic = extractTopic(entry.split('\n')[0]);
  return {
    title: releaseTitle(version, topic),
    body: composeReleaseNotes({ version, topic, entry, assets: options.assets }),
  };
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  // 位置参数只有版本号一个；`--assets` / `--out` 的值不能当成位置参数
  const flagsWithValue = new Set(['--assets', '--out']);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (flagsWithValue.has(args[i])) i += 1;
    else if (!args[i].startsWith('--')) positional.push(args[i]);
  }
  const version = positional[0];
  if (!version) {
    console.error(
      '用法: npx tsx tools/release-notes.mts <version> [--title] [--assets <文件>] [--out <目录>]',
    );
    process.exit(2);
  }

  const assetsFile = argValue(args, '--assets');
  const assets = assetsFile
    ? readFileSync(assetsFile, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : null;

  let notes: ReleaseNotes;
  try {
    notes = buildReleaseNotes({
      markdown: readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'),
      version,
      assets,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const outDir = argValue(args, '--out');
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'notes.md'), notes.body);
    writeFileSync(path.join(outDir, 'title.txt'), `${notes.title}\n`);
    console.error(`已写出 ${outDir}/notes.md 与 ${outDir}/title.txt`);
    console.error(`标题：${notes.title}`);
  } else if (args.includes('--title')) {
    process.stdout.write(`${notes.title}\n`);
  } else {
    process.stdout.write(notes.body);
  }
}
