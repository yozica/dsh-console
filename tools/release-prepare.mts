/**
 * 发布准备：把 `.changeset/` 里的片段汇总成 `CHANGELOG.md` 里的一个**新版本条目**。
 *
 * 为什么不用 `changeset version` 一步到位？
 *   changesets 写条目时标题是写死的 —— `@changesets/apply-release-plan` 的
 *   `get-changelog-entry.ts` 里就是 `` `## ${release.newVersion}` ``，而且还会套一层
 *   `### Major/Minor/Patch Changes` 分组；自定义 changelog 模块只能控制**条目正文**。
 *   本仓库的契约是 `## [x.y.z] - YYYY-MM-DD`：`tools/changelog-extract.mts` 按它取
 *   Release 正文，自检里也有断言。所以这里只借 changesets 的两样东西 ——
 *   **片段约定**（`.changeset/*.md`）与 **status 闸门**（`changeset status --since=main`），
 *   汇总这一步自己做（`.changeset/config.json` 里因此写着 `changelog: false`）。
 *
 * 用法：
 *   npx tsx tools/release-prepare.mts [--dry-run] [--date YYYY-MM-DD]
 *
 * 它按顺序做四件事：算出新版本号 → 写 `CHANGELOG.md` 条目 → 改 `package.json` 的版本 →
 * 删掉已汇总的片段（含 `changeset add --empty` 产生的空片段，它们只是闸门的通行证）。
 * `--dry-run` 只打印将要发生的事，不碰任何文件。
 *
 * 版本规则与 changesets 一致（它内部就是 `semver.inc`）：所有片段里取**最高**一级
 * （major > minor > patch），从当前版本往前走一步 —— 0.2.2 + patch → 0.2.3、
 * + minor → 0.3.0、+ major → 1.0.0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BumpType = 'major' | 'minor' | 'patch';

/** 汇总顺序：级别高的在前；同级别按文件名（想固定顺序就把片段命名成 01-xxx.md、02-xxx.md） */
const BUMP_RANK: Record<BumpType, number> = { major: 0, minor: 1, patch: 2 };

export interface Fragment {
  /** 片段文件名（不含目录） */
  file: string;
  type: BumpType;
  /** 片段正文（已去掉 front matter 并 trim） */
  body: string;
}

/** package.json 里本文件真正用到的字段 */
interface PackageJson {
  name: string;
  version: string;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 本地日期 → `YYYY-MM-DD`（CHANGELOG 里的日期一直按本地时区写，不用 toISOString） */
export function formatDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 解析一个片段文件。
 *
 * 形状就是 changesets 的片段：`---` 包起来的 front matter（本包名 → 级别）+ 正文。
 * 不涉及本包的片段（`changeset add --empty` 生成的那种，front matter 里没有本包）返回 null；
 * 有本包但级别写错、或者压根没有 front matter（比如同目录的 README.md）都会明确报错，
 * 免得"以为写了"其实被静默忽略。
 */
export function parseFragment(
  text: string,
  pkgName: string,
): { type: BumpType; body: string } | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('片段缺少 front matter 的结束行 `---`');
  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  const entry = lines
    .slice(1, end)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => new RegExp(`^['"]?${escapeRe(pkgName)}['"]?\\s*:`).test(line));
  if (!entry) return null;
  const raw = entry
    .slice(entry.indexOf(':') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!(raw in BUMP_RANK)) {
    throw new Error(`片段的版本级别只能是 major / minor / patch，读到的却是「${raw}」`);
  }
  return { type: raw as BumpType, body };
}

/** 从当前版本往前走一步（与 semver.inc 对这三种类型的结果一致） */
export function incrementVersion(current: string, type: BumpType): string {
  const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(current.trim());
  if (!matched) throw new Error(`package.json 里的版本号不是 x.y.z 形式：${current}`);
  const major = Number(matched[1]);
  const minor = Number(matched[2]);
  const patch = Number(matched[3]);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** 多个片段时取最高一级（major > minor > patch） */
export function pickBump(types: BumpType[]): BumpType {
  return types.reduce((highest, type) => (BUMP_RANK[type] < BUMP_RANK[highest] ? type : highest));
}

/** 拼出这一个版本的 CHANGELOG 条目（正文原样保留，片段里可以自带 `### 小节`） */
export function buildEntry(version: string, date: string, fragments: Fragment[]): string {
  const bodies = fragments.map((fragment) => fragment.body.trim()).filter(Boolean);
  return `## [${version}] - ${date}\n\n${bodies.join('\n\n')}`;
}

/** 插到 `## [Unreleased]` 之后、上一个已发布版本之前（没有 Unreleased 段就插在最前面） */
export function insertEntry(changelog: string, entry: string): string {
  const lines = changelog.split('\n');
  const unreleased = lines.findIndex((line) => /^## \[Unreleased\]\s*$/.test(line));
  const from = unreleased >= 0 ? unreleased + 1 : 0;
  let at = lines.findIndex((line, index) => index >= from && /^## \[/.test(line));
  if (at < 0) at = lines.length;
  const head = lines.slice(0, at);
  const tail = lines.slice(at);
  while (head.length > 0 && head[head.length - 1].trim() === '') head.pop();
  return [...head, '', ...entry.split('\n'), '', ...tail].join('\n');
}

/** 只改 `"version"` 那一行：package.json 其余部分逐字节保持原样 */
export function replaceVersion(pkgText: string, version: string): string {
  const pattern = /^(\s*"version"\s*:\s*")[^"]*(")/m;
  if (!pattern.test(pkgText)) throw new Error('package.json 里找不到 "version" 字段');
  return pkgText.replace(pattern, `$1${version}$2`);
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkgPath = path.join(root, 'package.json');
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const changesetDir = path.join(root, '.changeset');

  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgText) as PackageJson;

  const files = fs
    .readdirSync(changesetDir)
    .filter((file) => file.endsWith('.md') && file.toLowerCase() !== 'readme.md')
    .sort();
  const fragments: Fragment[] = [];
  const emptyFragments: string[] = [];
  for (const file of files) {
    const parsed = parseFragment(fs.readFileSync(path.join(changesetDir, file), 'utf8'), pkg.name);
    if (!parsed) {
      emptyFragments.push(file);
      continue;
    }
    if (!parsed.body) {
      throw new Error(
        `片段 ${file} 只有 front matter、没有正文。Release 正文就是这些正文，空条目会让发版没有说明；` +
          `如果这次改动不需要出现在 CHANGELOG 里，就用 \`npx changeset add --empty\`。`,
      );
    }
    fragments.push({ file, type: parsed.type, body: parsed.body });
  }
  fragments.sort(
    (left, right) =>
      BUMP_RANK[left.type] - BUMP_RANK[right.type] || left.file.localeCompare(right.file),
  );

  if (fragments.length === 0) {
    if (emptyFragments.length === 0) {
      throw new Error(
        '`.changeset/` 里没有片段：先跑 `npx changeset add`（或手写一个 .changeset/xxx.md）',
      );
    }
    console.log(`只有空片段（不产生版本）：${emptyFragments.join('、')}`);
    if (!dryRun) {
      for (const file of emptyFragments) fs.rmSync(path.join(changesetDir, file));
      console.log('已清理这些空片段 —— 它们只是为了让「每个 PR 都要带片段」的闸门能过。');
    }
    return;
  }

  const types = fragments.map((fragment) => fragment.type);
  const bump = pickBump(types);
  const version = incrementVersion(pkg.version, bump);
  const date = argValue(args, '--date') ?? formatDate(new Date());
  const heading = `## [${version}] - ${date}`;

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  if (changelog.includes(`## [${version}]`)) {
    throw new Error(
      `CHANGELOG.md 里已经有 ${version} 这一节了：先确认是不是漏了改版本号，或者片段不该现在汇总`,
    );
  }

  const entry = buildEntry(version, date, fragments);
  const updated = insertEntry(changelog, entry);
  const consumed = [...fragments.map((fragment) => fragment.file), ...emptyFragments];

  console.log(`当前版本：${pkg.version} → ${version}（${bump}，来自 ${fragments.length} 个片段）`);
  console.log(`片段：${fragments.map((fragment) => fragment.file).join('、')}`);
  console.log(`条目标题：${heading}`);
  const headings = changelog.split('\n').filter((line) => /^## \[/.test(line));
  const nextHeading = headings[headings.findIndex((line) => /^## \[Unreleased\]/.test(line)) + 1];
  console.log(
    nextHeading
      ? `插入位置：\`## [Unreleased]\` 之后、\`${nextHeading}\` 之前（这一节 ${entry.split('\n').length} 行）`
      : `插入位置：CHANGELOG.md 末尾（这一节 ${entry.split('\n').length} 行）`,
  );
  console.log(`会删掉的片段（${consumed.length} 个）：${consumed.join('、')}`);

  if (dryRun) {
    console.log('\n---- dry-run：这是将要写进 CHANGELOG.md 的内容 ----\n');
    console.log(entry);
    console.log('\n---- dry-run 结束，未改动任何文件 ----');
    return;
  }

  fs.writeFileSync(changelogPath, updated);
  fs.writeFileSync(pkgPath, replaceVersion(pkgText, version));
  for (const file of consumed) fs.rmSync(path.join(changesetDir, file));

  console.log('\n下一步：');
  console.log('  1. 看一眼 CHANGELOG.md（提交前钩子会顺手把它格式化）');
  console.log('  2. git add -A && git commit -m "chore: 发布 ' + version + '"');
  console.log(`  3. git tag v${version} && git push origin main --tags   # 推标签即触发 CI 出包`);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`发布准备失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
