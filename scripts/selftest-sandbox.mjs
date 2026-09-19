/**
 * 自检门禁（沙箱版）：把「编译 + 自检 + 清理」三步做成一个可重复、**可中断后重跑**的命令。
 *
 * 为什么需要它：`npm test` 是 `tsx test/selftest.ts`，而 tsx 要经 esbuild 的**带管道子进程**
 * 起一次编译 —— 受限沙箱禁止任何带管道 stdio 的子进程（spawn EPERM），所以 `npm test`
 * 在这种环境里根本起不来（这不是被测代码的问题）。可用的等价路径是：
 *
 *   1. `node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit false --listEmittedFiles`
 *      （tsc 直出 CJS，`test/selftest.js` 就能被 node 直接执行）
 *   2. `node test/selftest.js`
 *   3. 删掉第 1 步产出的 .js / .js.map / .mjs / .mjs.map（它们散落在 `src/`、`test/`、`tools/`、`scripts/` 旁边）
 *
 * ## 幂等：产物清单以 tsc 自己报的 `TSFILE:` 行为准
 *
 * 只算「运行前 / 运行后的文件差集」会漏掉一个很现实的场景：**上一次运行被中断**
 * （Ctrl+C、超时、被进程管理器杀掉）时产物已经留在盘上，差集于是为空 —— 那不是
 * 「tsc 没跑起来」，而是「这一轮要清理的是上一轮留下的产物」；旧版本在这里判失败且不清理，
 * 之后**每一次重跑都失败**（t8 修的就是这个）。
 *
 * 所以这里改成：
 *   1. tsc 的 stdout / stderr 重定向到一个真实文件（沙箱禁的是**管道**，fd 重定向不是管道），
 *      从里面解析 `TSFILE:` 行，拿到**权威产物清单**；
 *   2. 清单里「本轮运行前就已存在」的那些，诊断成「上一次留下的产物」，**一并清理、不判失败**；
 *   3. 清单文件（`<repo>/.verify/selftest-sandbox/emitted.json`，该目录被 .gitignore / .prettierignore /
 *      eslint 一起忽略）记着上一轮的清单：连「改了源码、这一轮不再产出某个旧产物」也能清掉；
 *   4. 清理**只删清单里的路径** —— 没有按文件名 / 扩展名 / 目录的批量删除。`scripts/` 目录里
 *      tsc 产物（`build.mjs`）与手写文件（`selftest-sandbox.mjs`、`env-doctor-cases.mjs`）混放，
 *      按模式删会毁掉工具本身，所以那两个手写文件还额外进了保护名单（清单里出现就拒绝删除并报错）。
 *
 * ## 反例脚本的约定：`scripts/*-cases.mjs` 会被**自动收录**
 *
 * 额外检查来自两处：**显式传进来的参数**（照旧，先跑）与**自动收录**的 `scripts/*-cases.mjs`。
 * 反例脚本按这个名字放进 `scripts/` 就行 —— 不需要谁记得往命令里加一个参数。两处合成一个
 * 列表、按出现顺序去重，然后走**同一条**判定路径：任一退出码非 0 → 门禁整体失败。
 *
 * 这是防腐烂的本意：反例脚本一旦腐烂（t9 改了启动 spec 形状时它就红过一次），门禁会立刻红，
 * 而不是静静地躺在那里没人跑。约定为空（`scripts/` 里一个 `*-cases.mjs` 都没有）**不是错误**。
 *
 * 用法：
 *   node scripts/selftest-sandbox.mjs                    # 额外检查 = 自动收录 scripts/*-cases.mjs
 *   node scripts/selftest-sandbox.mjs <脚本> [<脚本>…]    # 显式指定的照样跑（与自动收录的合并去重）
 *
 * 正常开发机不需要它：直接 `npm test`。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const TSC = path.join('node_modules', 'typescript', 'bin', 'tsc');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', '.verify', '.build-home']);
/** tsc 的原始输出与「上一轮产物清单」（整个目录都被 git / eslint / prettier 忽略） */
const WORK_DIR = path.join(repoRoot, '.verify', 'selftest-sandbox');
const TSC_LOG = path.join(WORK_DIR, 'tsc.log');
const MANIFEST = path.join(WORK_DIR, 'emitted.json');
/** 手写工具文件：它们与 tsc 产物同处 scripts/，绝不能被清理逻辑碰到 */
const PROTECTED = ['scripts/selftest-sandbox.mjs', 'scripts/env-doctor-cases.mjs'];

/** 仓库里的全部文件（相对路径、POSIX 分隔）。只用来做「前后差集」，不依赖 git */
function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function snapshot() {
  return new Set(walk(repoRoot));
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 上一轮的产物清单（读不出来 / 解析不了就当没有） */
function readManifest() {
  try {
    const parsed = JSON.parse(readText(MANIFEST));
    return Array.isArray(parsed.files) ? parsed.files.filter((f) => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function writeManifest(files) {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(
      MANIFEST,
      `${JSON.stringify({ repoRoot, at: new Date().toISOString(), files }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(
      `（清单写不进去，不影响本轮结果：${error instanceof Error ? error.message : error}）`,
    );
  }
}

/** 带 stdio: 'inherit' 地跑一个 node 脚本（管道在这个沙箱里是用不了的） */
function runNode(label, args) {
  console.log(`\n$ node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
  const code = typeof result.status === 'number' ? result.status : 1;
  console.log(`[${label}] 退出码 ${code}`);
  return code;
}

/**
 * 收集额外检查（见文件头的约定）：**显式参数**（照旧，先跑）+ **自动收录**的
 * `scripts/*-cases.mjs`（按文件名排序，顺序稳定）。两处合成一个列表并去重 ——
 * 后面只有**一条**判定路径（退出码非 0 → failed），没有第二套逻辑。
 */
function collectExtraChecks() {
  const explicit = process.argv.slice(2).map((item) => item.split(path.sep).join('/'));
  const casesDir = path.join(repoRoot, 'scripts');
  const auto = fs.existsSync(casesDir)
    ? fs
        .readdirSync(casesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /-cases\.mjs$/.test(entry.name))
        .map((entry) => `scripts/${entry.name}`)
        .sort()
    : [];
  const ordered = [];
  const source = new Map();
  for (const [list, tag] of [
    [explicit, '显式'],
    [auto, '自动收录'],
  ]) {
    for (const file of list) {
      if (source.has(file)) continue; // 同一个脚本不跑第二次
      source.set(file, tag);
      ordered.push(file);
    }
  }
  return { ordered, source, explicit, auto };
}

/** 跑 tsc，把它的输出（含 `TSFILE:` 行）落到文件里，再解析出权威产物清单 */
function runTsc() {
  const args = [TSC, '-p', 'tsconfig.node.json', '--noEmit', 'false', '--listEmittedFiles'];
  console.log(`\n$ node ${args.join(' ')}`);
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const fd = fs.openSync(TSC_LOG, 'w');
  // 沙箱禁的是管道：给 tsc 一个**文件** fd 是允许的，这样它的 TSFILE 行才拿得到
  const run = () => {
    try {
      return spawnSync(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
  };
  const result = run();
  const code = typeof result.status === 'number' ? result.status : 1;
  console.log(`[tsc 编译] 退出码 ${code}`);

  const log = readText(TSC_LOG);
  const products = [];
  const otherLines = [];
  let outsideRepo = false;
  for (const line of log.split(/\r?\n/)) {
    const match = /^TSFILE: (.+)$/.exec(line.trim());
    if (match) {
      const relative = path.relative(repoRoot, path.resolve(match[1]));
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        console.error(`产物在仓库之外，拒绝处理：${match[1]}`);
        outsideRepo = true;
        continue;
      }
      products.push(relative.split(path.sep).join('/'));
    } else if (line.trim()) {
      otherLines.push(line.trim());
    }
  }
  // tsc 的诊断（错误 / 警告）不该被吞掉：原样打出来给人看
  if (otherLines.length > 0) {
    console.log('tsc 输出（非 TSFILE 行）：');
    for (const line of otherLines.slice(-40)) console.log(`  ${line}`);
  }
  return { code: outsideRepo ? 1 : code, products: [...new Set(products)].sort() };
}

const before = snapshot();
const previousFiles = readManifest();
let failed = false;

// 1. 编译
const { code: tscCode, products } = runTsc();
if (tscCode !== 0) failed = true;

/** 清单里「本轮运行前就已经在盘上」的：上一次被中断留下的产物 */
const stale = products.filter((file) => before.has(file));
/** 上一轮清单里有、这一轮不再产出的旧产物（改了源码的情况）；仍然只删清单里的路径 */
const staleFromManifest = previousFiles.filter(
  (file) => before.has(file) && !products.includes(file),
);
const cleanupList = [...new Set([...products, ...staleFromManifest])].sort();

console.log(
  `\ntsc 权威产物清单：${products.length} 个文件（来自 --listEmittedFiles 的 TSFILE 行）`,
);
for (const file of products) console.log(`  ${file}`);
if (products.length === 0) {
  if (tscCode === 0) {
    console.error('tsc 报了成功但一个 TSFILE 行都没有 —— 产物清单拿不到，无法判断要清理什么');
    failed = true;
  } else {
    console.error('tsc 没跑成功，也没有产物清单（原因见上面的 tsc 输出）');
  }
}
if (stale.length > 0) {
  console.log(
    `\n发现 ${stale.length} 个「本轮运行前就已经存在」的产物 —— 上一次运行很可能被中断` +
      `（Ctrl+C / 超时 / 进程被杀），这一次会一并清理：`,
  );
  for (const file of stale) console.log(`  ${file}`);
}
if (staleFromManifest.length > 0) {
  console.log(
    `\n上一轮的清单里还有 ${staleFromManifest.length} 个旧产物（这一轮不再产出），一并清理：`,
  );
  for (const file of staleFromManifest) console.log(`  ${file}`);
}

// 2. 自检（+ 额外检查：显式参数 + 自动收录的 scripts/*-cases.mjs，见文件头）
const selftestJs = path.join(repoRoot, 'test', 'selftest.js');
if (tscCode === 0 && !fs.existsSync(selftestJs)) {
  console.error('编译成功但 test/selftest.js 不在 —— 没法跑自检');
  failed = true;
}
if (products.length > 0 && fs.existsSync(selftestJs) && tscCode === 0) {
  if (runNode('自检', ['test/selftest.js']) !== 0) failed = true;
}

const extras = collectExtraChecks();
console.log(
  `\n额外检查 ${extras.ordered.length} 个（显式 ${extras.explicit.length} 个 + ` +
    `自动收录 scripts/*-cases.mjs ${extras.auto.length} 个 → 去重后 ${extras.ordered.length} 个）：`,
);
if (extras.ordered.length === 0) {
  console.log('  （没有显式参数，scripts/ 里也没有 *-cases.mjs —— 约定为空不是错误）');
} else {
  for (const file of extras.ordered) console.log(`  ${file}（${extras.source.get(file)}）`);
}
// 只有这一条判定路径：退出码非 0 就让门禁失败
for (const extra of extras.ordered) {
  if (runNode(`额外检查 ${extra}`, [extra]) !== 0) failed = true;
}
/** 手写工具 + 自动收录的反例脚本都不许被清理逻辑碰（它们与 tsc 产物同处 scripts/） */
const protectedFiles = new Set([...PROTECTED, ...extras.auto]);

// 3. 清理：只删清单里的路径，没有按名字 / 扩展名的批量删除
let removed = 0;
let absent = 0;
for (const file of cleanupList) {
  if (protectedFiles.has(file)) {
    console.error(`拒绝删除手写工具文件（它出现在产物清单里说明清单有问题）：${file}`);
    failed = true;
    continue;
  }
  const full = path.join(repoRoot, file);
  if (!fs.existsSync(full)) {
    absent += 1;
    continue;
  }
  try {
    fs.rmSync(full);
    removed += 1;
  } catch (error) {
    console.error(`删不掉 ${file}：${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}
console.log(
  `\n清理：清单 ${cleanupList.length} 个路径 → 删掉 ${removed} 个` +
    `（另有 ${absent} 个本来就不在盘上）`,
);

const leftover = [...snapshot()].filter((file) => !before.has(file)).sort();
const leftoverNote = leftover.length > 0 ? ` → ${leftover.join(', ')}` : '';
console.log(`清理后仍多出来的文件：${leftover.length} 个${leftoverNote}`);
if (leftover.length > 0) failed = true;

// 4. 记下这一轮的清单，供下一次（哪怕被中断）比对与善后
writeManifest([...new Set([...previousFiles, ...products])].sort());

// 5. 如实把工作树现状打出来（给验证报告用；不解析 git 的输出，所以不受"不能捕获管道"影响）
console.log('\n$ git status --porcelain');
spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, stdio: 'inherit' });

console.log(
  failed
    ? '\n自检门禁：失败'
    : `\n自检门禁：通过（编译 + 自检 + 清理都干净；额外检查 ${extras.ordered.length} 个）`,
);
process.exitCode = failed ? 1 : 0;
