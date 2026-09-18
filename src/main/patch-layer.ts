/**
 * 改「你自己的补丁层」：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`。
 *
 * 这是控制台唯一该写的配置文件 —— 它是**你的**覆盖层（各 bundle 的 patch 之后才轮到它），
 * 官方随包但默认不启用的插件靠它 insert 进来，不想要就 disabled 掉。dsh 自己不会替你改它，
 * 所以插件页得能替你做四个动作：插入 / 禁用 / 启用 / 移除自己的插入。
 *
 * 四条硬约定（写的是用户文件，错一次就是把人配置改坏）：
 *
 *   1. **按行改，不引 YAML 库**。这个仓库运行期只依赖 node-pty 与 electron-updater；而且
 *      patch 文件里 `!!js` 表达式、注释、空行都合法，真拿解析器 round-trip 一遍，用户的
 *      注释与格式就没了 —— 那比"改不动"更糟。
 *   2. **只改匹配到的那一段**。找不到那条 id 就什么都不写，并把原因说出来（界面直接显示），
 *      绝不猜着写、也不"顺手"重排整个文件。
 *   3. **先备份再原子写**：`cordis.patch.yml.bak-<时间戳>`，然后 tmp + rename 覆盖。
 *   4. **动作按最小惊讶**：enable 只去掉 `disabled` 那一行；只有那条条目本来就只是为了禁用
 *      而存在（除了 id 与 disabled 没别的 key）时，才整条删掉。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 补丁层文件名（dsh 认这个名字） */
export const PATCH_FILE = 'cordis.patch.yml';

/** 一次改动：文本 + 改了没有 + 一句人话 */
export interface PatchEditOutcome {
  text: string;
  changed: boolean;
  /** 界面直接显示这句话：做了什么都写在这里 */
  detail: string;
}

export type PatchEditAction = 'disable' | 'enable' | 'insert' | 'remove-insert';

export interface PatchEditRequest {
  action: PatchEditAction;
  /** 条目 id（insert 时也用它，避免同一个插件插两遍） */
  id: string;
  /** insert 时要加载的模块名，例如 `@deepseek-ai/dsh-time-context` */
  name?: string;
}

export interface PatchEditResult {
  ok: boolean;
  error?: string;
  /** 是否真的写了盘；false = 没必要改（原因看 detail） */
  changed?: boolean;
  detail?: string;
  file?: string;
  /** 备份文件；本来没有这个文件所以不用备份时是 null */
  backup?: string | null;
  /** 改完之后的文件内容（界面摊开给用户看，"改了"与"没改"一眼可分） */
  content?: string;
}

/** 条目起始行：`- insert:`、`    - id: x`（同一行带 key 也算） */
const ITEM_RE = /^(\s*)-\s/;
/** 条目自己的 id：`- id: x` 与 `    id: x` 两种写法都认 */
const ID_RE = /^(\s*)(?:-\s*)?id:\s*['"]?([^'"\s]+)['"]?\s*$/;
const DISABLED_TRUE_RE = /^\s*disabled:\s*true\s*$/;
const DISABLED_FALSE_RE = /^\s*disabled:\s*false\s*$/;
const COMMENT_RE = /^\s*#/;
/** id 允许的字符：跟 dump 里的 id 一致，也避免往 YAML 里写进奇怪的东西 */
const ID_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/** 包名允许的字符（比 npm 的规范更严一点，够用且安全） */
const NAME_PATTERN = /^[A-Za-z0-9@/._-]+$/;

interface Item {
  /** 起始行 */
  start: number;
  /** 最后一个有内容的行（注释与空行不算，删条目时留着它们） */
  contentEnd: number;
  /** 到这一行之前属于这个条目（不含） */
  end: number;
  /** 起始行的缩进 */
  indent: number;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\r\n/g, '\n').split('\n');
}

/** 统一收尾：末尾恰好一个换行（空文件就是空串） */
function joinLines(lines: string[]): string {
  const kept = [...lines];
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

/** 拆出所有条目（嵌套的也算），并标出各自的范围 */
function parseItems(lines: string[]): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = ITEM_RE.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = ITEM_RE.exec(lines[j]);
      if (next && next[1].length <= indent) {
        end = j;
        break;
      }
    }
    let contentEnd = i;
    for (let j = i; j < end; j += 1) {
      const line = lines[j];
      if (line.trim() !== '' && !COMMENT_RE.test(line)) contentEnd = j;
    }
    items.push({ start: i, contentEnd, end, indent });
  }
  return items;
}

/**
 * 条目**自己**的 id。判断标准是 key 的缩进：`- insert:` 的 children 比它深 4，
 * 所以从父条目里扫到的孩子 id 不算父亲的（否则删一条会删掉整块 insert）。
 */
function ownId(lines: string[], item: Item): string | null {
  for (let i = item.start; i < item.end; i += 1) {
    const match = ID_RE.exec(lines[i]);
    if (!match) continue;
    const dash = /^\s*-\s/.test(lines[i]) ? 2 : 0;
    if (match[1].length + dash !== item.indent + 2) continue;
    return match[2];
  }
  return null;
}

function findItem(lines: string[], id: string): Item | null {
  return parseItems(lines).find((item) => ownId(lines, item) === id) ?? null;
}

/** 条目内部两处引用它的行 */
function itemLines(lines: string[], item: Item): string[] {
  return lines.slice(item.start, item.end);
}

/** 这个条目的 key 缩进：`- id: x` → 2，`    - id: x` → 6 */
function keyIndent(item: Item): string {
  return ' '.repeat(item.indent + 2);
}

/** 条目里除 id / disabled 之外还有别的 key 吗（决定 enable 是删一行还是删整条） */
function hasOtherKeys(lines: string[], item: Item): boolean {
  return itemLines(lines, item).some((line) => {
    if (line.trim() === '' || COMMENT_RE.test(line)) return false;
    return !ID_RE.test(line) && !DISABLED_TRUE_RE.test(line) && !DISABLED_FALSE_RE.test(line);
  });
}

function done(text: string, changed: boolean, detail: string): PatchEditOutcome {
  return { text, changed, detail };
}

function appendBlock(lines: string[], block: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1].trim() === '') next.pop();
  if (next.length > 0) next.push('');
  next.push(...block);
  return next;
}

/** 插入：让你的层里多一条 `- insert:`（已经有同 id 的条目就不重复插） */
export function insertPlugin(text: string, id: string, name: string): PatchEditOutcome {
  const lines = splitLines(text);
  if (findItem(lines, id)) {
    return done(text, false, `你的层里已经有 id 为「${id}」的条目了，没有重复插入。`);
  }
  const next = appendBlock(lines, ['- insert:', `    - id: ${id}`, `      name: '${name}'`]);
  return done(joinLines(next), true, `在你的层里插入「${id}」（name: ${name}）`);
}

/** 禁用：条目不在你的层里，就补一条覆盖（`- id: x` + `disabled: true`） */
export function disableEntry(text: string, id: string): PatchEditOutcome {
  const lines = splitLines(text);
  const item = findItem(lines, id);
  if (item) {
    if (itemLines(lines, item).some((line) => DISABLED_TRUE_RE.test(line))) {
      return done(text, false, `你的层里「${id}」已经是 disabled 了。`);
    }
    const next = [...lines];
    const falseAt = next.findIndex(
      (line, index) => index >= item.start && index < item.end && DISABLED_FALSE_RE.test(line),
    );
    if (falseAt !== -1) next[falseAt] = `${keyIndent(item)}disabled: true`;
    else next.splice(item.contentEnd + 1, 0, `${keyIndent(item)}disabled: true`);
    return done(joinLines(next), true, `在你的层里把「${id}」标成 disabled: true`);
  }
  const next = appendBlock(lines, [`- id: ${id}`, '  disabled: true']);
  return done(joinLines(next), true, `在你的层里加了一条禁用「${id}」的条目`);
}

/** 启用：去掉 disabled；只有那条条目本来就只为禁用而存在时，才整条删掉 */
export function enableEntry(text: string, id: string): PatchEditOutcome {
  const lines = splitLines(text);
  const item = findItem(lines, id);
  if (!item) return done(text, false, `你的层里没有 id 为「${id}」的条目（它本来就没被禁过）。`);
  if (!itemLines(lines, item).some((line) => DISABLED_TRUE_RE.test(line))) {
    return done(text, false, `你的层里「${id}」不是禁用状态。`);
  }
  if (hasOtherKeys(lines, item)) {
    const next = lines.filter(
      (line, index) => !(index >= item.start && index < item.end && DISABLED_TRUE_RE.test(line)),
    );
    return done(joinLines(next), true, `去掉了「${id}」的 disabled: true（这条还在你的层里）`);
  }
  const next = [...lines.slice(0, item.start), ...lines.slice(item.contentEnd + 1)];
  return done(joinLines(next), true, `从你的层里删掉了那条只为禁用「${id}」而存在的条目`);
}

/** 移除自己的插入：删掉那条 insert；整个 insert 块只剩它一条时，连块一起删 */
export function removeInsert(text: string, id: string): PatchEditOutcome {
  const lines = splitLines(text);
  const item = findItem(lines, id);
  if (!item) return done(text, false, `你的层里没有 id 为「${id}」的条目。`);
  if (item.indent === 0) {
    return done(
      text,
      false,
      `「${id}」在你层里不是一条 insert（是覆盖或禁用条目），这个动作不动它。`,
    );
  }

  const items = parseItems(lines);
  const parent = items
    .filter((candidate) => candidate.indent < item.indent && candidate.start < item.start)
    .pop();
  const remaining = parent
    ? items.filter(
        (candidate) =>
          candidate.start !== item.start &&
          candidate.indent === item.indent &&
          candidate.start > parent.start &&
          candidate.start < parent.end,
      )
    : [];

  if (parent && remaining.length === 0) {
    const next = [...lines.slice(0, parent.start), ...lines.slice(parent.end)];
    return done(
      joinLines(next),
      true,
      `从你的层里删掉了「${id}」那条插入（整个 insert 块只剩它一条，块一起删）`,
    );
  }
  const next = [...lines.slice(0, item.start), ...lines.slice(item.contentEnd + 1)];
  return done(joinLines(next), true, `从你的层里删掉了「${id}」那条插入`);
}

/**
 * 落盘：备份 → 原子写。`profileDir` 由调用方给（主进程那边是 `$DSH_HOME/profiles/web`）。
 */
export function applyPatchEdit(profileDir: string, request: PatchEditRequest): PatchEditResult {
  const id = String(request.id ?? '').trim();
  if (!ID_PATTERN.test(id)) {
    return { ok: false, error: `条目 id 只能用字母、数字与 _ $ . -（收到的是「${id}」）。` };
  }
  const name = String(request.name ?? '').trim();
  if (request.action === 'insert' && !NAME_PATTERN.test(name)) {
    return { ok: false, error: '要插入的包名看起来不像包名，先不写你的配置文件。' };
  }

  const file = path.join(profileDir, PATCH_FILE);
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    /* 还没有这个文件：从空开始，正常情况 */
  }

  const outcome =
    request.action === 'insert'
      ? insertPlugin(current, id, name)
      : request.action === 'disable'
        ? disableEntry(current, id)
        : request.action === 'enable'
          ? enableEntry(current, id)
          : removeInsert(current, id);

  if (!outcome.changed) {
    return {
      ok: true,
      changed: false,
      detail: outcome.detail,
      file,
      backup: null,
      content: current,
    };
  }

  let backup: string | null = null;
  try {
    if (fs.existsSync(file)) {
      backup = `${file}.bak-${timestamp()}`;
      fs.copyFileSync(file, backup);
    }
    fs.mkdirSync(profileDir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, outcome.text, 'utf8');
    fs.renameSync(tmp, file);
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
    detail: outcome.detail,
    file,
    backup,
    content: outcome.text,
  };
}

/** `20260918-123456`（跟已有的备份文件名一致） */
function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
