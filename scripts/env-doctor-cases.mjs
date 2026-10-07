/**
 * 环境自检的**独立反例用例**（验证用，不属于产品代码）。
 *
 * 设计文档 `docs/env-doctor.md` 第 2 节把「判定」定成硬约束：`judgeEnvironment(raw)` 只读入参，
 * 不碰磁盘 / 子进程 / `process.*` / 时钟 —— 所以这一页最容易出错的部分必须能**离线**验证。
 * 这个脚本就是那份离线验证：**只喂手工构造的对象字面量**，不装 pnpm、不起任何进程；
 * 期望值直接来自设计文档第 1 / 2 / 3 节写下的规则（不是从 `test/selftest.ts` 抄的夹具，
 * 两套对不上才算真发现问题）。
 *
 * 用法：
 *   node scripts/env-doctor-cases.mjs                               # 独立跑（推荐；树里没有编译产物时自己编译一份到 .verify/cases-build）
 *   node scripts/selftest-sandbox.mjs                               # 门禁跑法：**不带参数也会带上它**（见下）
 *   node scripts/selftest-sandbox.mjs scripts/env-doctor-cases.mjs   # 也可以显式点名：它排在自动收录之前跑，重复的只跑一次
 *
 * 门禁是怎么跑它的（t17 之后的真实行为）：`scripts/selftest-sandbox.mjs` 会**自动收录 `scripts/*-cases.mjs`**
 * （按文件名排序，与显式参数合并去重）—— 所以**不带参数也已经包含这个脚本**，不需要谁记得在命令里多加一个
 * 路径。任一额外检查退出码非 0，门禁整体就失败；这正是防腐烂的本意（t17 之前它不自动收录，红过一次也没人发现）。
 * 想只跑其中几个反例可以传显式参数（它们先跑），但**自动收录的那些仍会跑到** —— 要真正缩小范围得先把不想跑的
 * 挪出 `scripts/`。这个脚本本身也能独立跑（缺编译产物时自己编一份到 gitignore 的 `.verify/cases-build`）。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const TSC = path.join('node_modules', 'typescript', 'bin', 'tsc');
/** 独立运行时用的私有编译目录（`.verify/` 被 git / .prettierignore / eslint 一起忽略） */
const PRIVATE_BUILD = path.join(repoRoot, '.verify', 'cases-build');

/** `src/**` 与两份 tsconfig 里最新的改动时刻：判断编译产物是否过期 */
function newestSourceMs() {
  let newest = 0;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(ts|mts)$/.test(entry.name)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  visit(path.join(repoRoot, 'src'));
  for (const name of ['tsconfig.node.json', 'tsconfig.base.json']) {
    const full = path.join(repoRoot, name);
    if (fs.existsSync(full)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * 找到能 `require` 的编译产物：优先用树里那一份（门禁 / 手工 tsc 留下的、且不比源码旧），
 * 否则在 `.verify/cases-build` 里现编一份 —— 这样 `node scripts/env-doctor-cases.mjs` 单跑也能过，
 * 既不会往 `src/` 里丢产物，也不会因为「忘了先编译」而静默腐烂。
 */
function resolveBuildDir() {
  const inTree = path.join(repoRoot, 'src', 'main', 'env-doctor.js');
  if (fs.existsSync(inTree) && fs.statSync(inTree).mtimeMs >= newestSourceMs()) return repoRoot;
  const built = path.join(PRIVATE_BUILD, 'src', 'main', 'env-doctor.js');
  const fresh = fs.existsSync(built) && fs.statSync(built).mtimeMs >= newestSourceMs();
  if (!fresh) {
    console.log('（没有可用的编译产物 → 现场编译一份到 .verify/cases-build，不碰 src/）');
    const result = spawnSync(
      process.execPath,
      [TSC, '-p', 'tsconfig.node.json', '--noEmit', 'false', '--outDir', PRIVATE_BUILD],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    if (result.status !== 0) {
      console.error(`编译失败（退出码 ${result.status ?? 1}），没法验证`);
      process.exit(2);
    }
  }
  return PRIVATE_BUILD;
}

const buildDir = resolveBuildDir();
const loadBackend = (relative) => require(path.join(buildDir, relative));

let envDoctor;
let processUtils;
try {
  envDoctor = loadBackend('src/main/env-doctor.js');
  processUtils = loadBackend('src/main/process-utils.js');
} catch (error) {
  console.error('加载编译产物失败：', error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const { judgeEnvironment, satisfiesNodeRange, parseNodeVersion } = envDoctor;
const {
  satisfiesSimpleRange,
  minNodeOfRange,
  highestNodeRequirement,
  judgeNodeVersion,
  localNodeRange,
  requirementPhrase,
} = envDoctor;
const { npmLaunchSpec, envFixPlan, summarizeEnvFixFailure, NODE_RANGE } = envDoctor;
const { fixTimeoutMessage, FIX_TIMEOUT_MS } = envDoctor;
/**
 * 通用启动包装与「可执行性」判据**现在的家是 `process-utils`**（`launchSpec` / `isRunnablePath`）；
 * `env-doctor` 那侧只留 `npmLaunchSpec` 这个转发（薄封装，与前者产出一致，M 用例钉着这条）。
 * 这里两边都认（先 `env-doctor`、再 `process-utils`）：将来再挪家也不会崩，但**不许消失** ——
 * 下面那道检查会把「缺失 / 改名」变成一句人话 + exit 2，而不是几百行之后的一个
 * `TypeError: xxx is not a function`（这个脚本真这么崩过一次，t17 的门禁当场就红了）。
 */
const launchSpecFrom = typeof envDoctor.launchSpec === 'function' ? 'env-doctor' : 'process-utils';
const runnableFrom =
  typeof envDoctor.isRunnablePath === 'function' ? 'env-doctor' : 'process-utils';
const launchSpec = launchSpecFrom === 'env-doctor' ? envDoctor.launchSpec : processUtils.launchSpec;
const isRunnablePath =
  runnableFrom === 'env-doctor' ? envDoctor.isRunnablePath : processUtils.isRunnablePath;
const { whichSync } = processUtils;

const missingExports = [
  ['judgeEnvironment', judgeEnvironment],
  ['satisfiesNodeRange', satisfiesNodeRange],
  ['parseNodeVersion', parseNodeVersion],
  ['satisfiesSimpleRange', satisfiesSimpleRange],
  ['minNodeOfRange', minNodeOfRange],
  ['highestNodeRequirement', highestNodeRequirement],
  ['judgeNodeVersion', judgeNodeVersion],
  ['localNodeRange', localNodeRange],
  ['requirementPhrase', requirementPhrase],
  ['npmLaunchSpec', npmLaunchSpec],
  ['envFixPlan', envFixPlan],
  ['summarizeEnvFixFailure', summarizeEnvFixFailure],
  ['fixTimeoutMessage', fixTimeoutMessage],
  ['launchSpec', launchSpec],
  ['isRunnablePath', isRunnablePath],
  ['whichSync', whichSync],
]
  .filter(([, value]) => typeof value !== 'function')
  .map(([name]) => name);
if (missingExports.length > 0) {
  console.error(
    `缺这些导出：${missingExports.join('、')} —— 被重构挪走或改名了，验证脚本要跟着同步` +
      '（这正是「验证侧资产会静默腐烂」的那一类；门禁现在会自动跑它，所以不会再被漏掉）',
  );
  process.exit(2);
}

const results = [];
const observations = [];

function check(name, pass, actual, expected) {
  results.push({ name, pass: Boolean(pass), actual: String(actual), expected: String(expected) });
}

function observe(text) {
  observations.push(text);
}

// ---------------------------------------------------------------- 夹具（全是对象字面量）
const versionProbe = (over = {}) => ({
  path: '/usr/local/bin/node',
  version: 'v24.19.0',
  exitCode: 0,
  error: null,
  ...over,
});
const dshProbe = (over = {}) => ({
  kind: 'node-bin',
  display: '/usr/local/bin/node /usr/local/lib/node_modules/@deepseek-ai/dsh/bin.js',
  runs: true,
  version: '0.5.3',
  exitCode: 0,
  error: null,
  resolveError: null,
  ...over,
});
const raw = (over = {}) => ({
  checkedAt: 1730000000000,
  platform: 'darwin',
  packaged: true,
  bundled: { electron: '44.3.0', node: '24.19.0', chrome: '140.0.0' },
  node: versionProbe(),
  npm: versionProbe({ path: '/usr/local/bin/npm', version: '10.9.0' }),
  pnpm: versionProbe({ path: '/usr/local/bin/pnpm', version: '9.15.0' }),
  dsh: dshProbe(),
  shell: { file: '/bin/zsh', exists: true },
  error: null,
  ...over,
});
const checkOf = (report, id) => report.checks.find((item) => item.id === id);
const NO_BIN = { path: null, version: null, exitCode: null, error: null };

// ---------------------------------------------------------------- A. pnpm 有路径却不可用
//
// 语义（船长裁定，依据 VM-03「shim 还在、却根本不可用」）：`warn` 的含义是**能用、但需要注意**
// （例如走的是 `npx -y`、或者版本不在构建期区间里）；一个**跑不出任何输出**的 pnpm 根本不能用，
// 补救动作与「没装」**完全相同**（一键重装一个），所以它归 `missing`、门禁该挡它。
// 反过来，**「测不出来」不是「不可用」**：`EPERM` / `EACCES` / 沙箱受限仍然是 `warn`、仍然不挡人
// —— 那条原则没变（见下面 A 对照组），变的是「**实测到坏掉**」这一种。
const caseA = judgeEnvironment(
  raw({ pnpm: versionProbe({ path: '/opt/pnpm/pnpm', version: null, exitCode: 0, error: null }) }),
);
const pnpmA = checkOf(caseA, 'pnpm');
check(
  'A 反例：pnpm 有路径却跑不出输出 → missing（不是 warn），但出路与「没装」一模一样（fixHint + fixAction + 计划都在）',
  pnpmA.status === 'missing' &&
    pnpmA.detail.includes('找到了 pnpm') &&
    pnpmA.detail.includes('跑起来没有任何输出') &&
    !pnpmA.detail.includes('没找到') &&
    Boolean(pnpmA.fixHint) &&
    pnpmA.fixAction === 'install-pnpm' &&
    caseA.plans.some((plan) => plan.action === 'install-pnpm') &&
    caseA.counts.missing === 1,
  `status=${pnpmA.status} counts=${JSON.stringify(caseA.counts)} detail=${pnpmA.detail} fixHint=${pnpmA.fixHint} fixAction=${pnpmA.fixAction}`,
  'missing + detail 说「找到了…跑起来没有任何输出」+ fixHint/fixAction/一键计划都在 + 1 项 missing',
);
// 对照组：**环境受限**的 pnpm 不是「坏了」，仍然是 warn、不挡人（这条原则没变的那一半）
const caseABlocked = judgeEnvironment(
  raw({
    pnpm: versionProbe({
      path: '/opt/pnpm/pnpm',
      version: null,
      exitCode: null,
      error: 'spawnSync /opt/pnpm/pnpm EPERM',
    }),
  }),
);
const pnpmBlocked = checkOf(caseABlocked, 'pnpm');
check(
  'A 对照组：起不了子进程（EPERM）的 pnpm 仍然是 warn（测不出来 ≠ 不可用），0 项 missing',
  pnpmBlocked.status === 'warn' &&
    caseABlocked.counts.missing === 0 &&
    Boolean(pnpmBlocked.fixHint),
  `status=${pnpmBlocked.status} counts=${JSON.stringify(caseABlocked.counts)} detail=${pnpmBlocked.detail}`,
  'warn + 非空 fixHint + 0 项 missing',
);

// ---------------------------------------------------------------- B. node 版本不满足
const caseB = judgeEnvironment(raw({ node: versionProbe({ version: 'v20.9.0' }) }));
const nodeVersionB = checkOf(caseB, 'node-version');
check(
  'B 反例：node v20.9.0 不满足区间 → warn（不是 missing），并点名是 dsh 与它依赖链的要求',
  nodeVersionB.status === 'warn' &&
    nodeVersionB.detail.includes('v20.9.0') &&
    nodeVersionB.detail.includes('dsh 与它依赖链的要求') &&
    caseB.counts.missing === 0 &&
    caseB.firstProblemId === 'node-version',
  `status=${nodeVersionB.status} counts=${JSON.stringify(caseB.counts)} firstProblemId=${caseB.firstProblemId} detail=${nodeVersionB.detail}`,
  'warn + detail 点名 20.9.0 与"dsh 与它依赖链的要求"',
);

// ---------------------------------------------------------------- C. 区间边界
// dsh 那句 `^22.19.0 || >=24.0.0`：20.19 与 22.12 都**不算**（原来抄成 vite 的构建期那句了）
const bounds = [
  ['v20.18.0', false],
  ['v20.19.0', false],
  ['v22.11.9', false],
  ['v22.12.0', false],
  ['v22.18.9', false],
  ['v22.19.0', true],
  ['v23.0.0', false],
  ['v24.0.0', true],
];
const boundActual = bounds
  .map(([text, expected]) => {
    const parsed = parseNodeVersion(text);
    const got = parsed ? satisfiesNodeRange(parsed) : null;
    return `${text}=${got}/${expected}`;
  })
  .join(' ');
check(
  'C 区间边界：22.19 那一档与 23 被排除',
  bounds.every(([text, expected]) => {
    const parsed = parseNodeVersion(text);
    return parsed !== null && satisfiesNodeRange(parsed) === expected;
  }) && parseNodeVersion('不是版本号') === null,
  boundActual,
  '与 dsh 的要求一句一致（22.19+ / 24+ 算，23 与 ≤22.18 不算）；非版本串 → null',
);

// ---------------------------------------------------------------- D. dsh 静默退出
const caseD = judgeEnvironment(
  raw({ dsh: dshProbe({ kind: 'node-bin', runs: false, version: null, exitCode: 0 }) }),
);
check(
  'D 反例：dsh 退出码 0 + 零输出 → dsh 本体仍 ok，但 dsh-run 是 missing 并点名"静默退出"',
  checkOf(caseD, 'dsh').status === 'ok' &&
    checkOf(caseD, 'dsh-run').status === 'missing' &&
    checkOf(caseD, 'dsh-run').detail.includes('静默退出'),
  `dsh=${checkOf(caseD, 'dsh').status} dsh-run=${checkOf(caseD, 'dsh-run').status} detail=${checkOf(caseD, 'dsh-run').detail}`,
  'dsh=ok / dsh-run=missing（两件事分开判）',
);

// ---------------------------------------------------------------- E. npm 也没有时不给按钮
const caseE = judgeEnvironment(raw({ npm: versionProbe(NO_BIN), pnpm: versionProbe(NO_BIN) }));
check(
  'E 反例：npm 与 pnpm 都没有 → pnpm 行不给一键按钮（fixAction=null），plans 为空',
  checkOf(caseE, 'npm').status === 'missing' &&
    checkOf(caseE, 'pnpm').status === 'missing' &&
    checkOf(caseE, 'pnpm').fixAction === null &&
    caseE.plans.length === 0,
  `npm=${checkOf(caseE, 'npm').status} pnpm.fixAction=${checkOf(caseE, 'pnpm').fixAction} plans=${caseE.plans.length} pnpm.fixHint=${checkOf(caseE, 'pnpm').fixHint}`,
  'pnpm.fixAction=null + plans=[]',
);

// ---------------------------------------------------------------- F. EPERM 不当成"没装"，也不许出现在文案里
//
// 状态判据**没变**：node 那项仍是 `ok`（路径是真的存在）、`node-version` 仍是 `warn`
// （我们测不出来 ≠ 用户没装 —— 见 docs/env-doctor.md 7.4 那条道理）。
// 变的是**文案**：面向用户的 `detail` 不得出现 `EPERM` 这类**内部记号**——这和 VM-04
// （用户点名 PATH / dsh.cmd / npx 那些词）是同一条规则；原始错误保留在**探测事实**里
// （`EnvProbeRaw.node.error`；dsh 那条对应 `EnvProbeRaw.dsh.resolveError`）供诊断，不上界面。
const caseF = judgeEnvironment(
  raw({
    node: versionProbe({
      path: '/usr/bin/node',
      version: null,
      exitCode: null,
      error: 'spawnSync /usr/bin/node EPERM',
    }),
  }),
);
const nodeVersionF = checkOf(caseF, 'node-version');
check(
  'F 反例：起不了子进程 → node 仍 ok、node-version 是 warn（不得当成没装），文案只说人话、不出现 EPERM',
  checkOf(caseF, 'node').status === 'ok' &&
    nodeVersionF.status === 'warn' &&
    nodeVersionF.detail.includes('这个运行环境不允许起子进程') &&
    nodeVersionF.detail.includes('不代表没装 Node') &&
    !nodeVersionF.detail.includes('EPERM') &&
    caseF.counts.missing === 0,
  `node=${checkOf(caseF, 'node').status} node-version=${nodeVersionF.status} counts=${JSON.stringify(caseF.counts)} detail=${nodeVersionF.detail}`,
  'node=ok / node-version=warn / detail 是人话且不含 EPERM / 0 项 missing',
);

// ---------------------------------------------------------------- G. pnpm 缺失 → 一键安装计划
//
// `--allow-scripts=pnpm` 是 **VM-06 的修复本体**，不是为了让这条断言变绿才加的：npm 会拦下依赖里的
// install scripts，而 pnpm 的安装脚本正是它自己要在输出里给出官方放行方式的那一类；这条开关只挂在
// **装 pnpm 这一条 argv** 上，一次性、**不写用户的全局 npm 配置**（`note` 里对用户也是这么说的）。
// 所以这里**逐字**钉住整条 argv —— 放宽成「包含 `i -g pnpm` 即可」就等于让「装 pnpm 时到底带没带
// 放行开关」这件事失去断言保护。
const caseG = judgeEnvironment(raw({ pnpm: versionProbe(NO_BIN) }));
const planG = caseG.plans.find((item) => item.action === 'install-pnpm');
check(
  'G pnpm 缺失 → fixAction=install-pnpm，计划用完整 npm 路径且不经 shell（argv 逐字含一次性放行开关）；target 留给主进程（判定不碰子进程）',
  checkOf(caseG, 'pnpm').fixAction === 'install-pnpm' &&
    caseG.plans.length === 2 &&
    Boolean(planG) &&
    planG.display === '/usr/local/bin/npm i -g pnpm --allow-scripts=pnpm' &&
    planG.file === '/usr/local/bin/npm' &&
    planG.args.join(' ') === 'i -g pnpm --allow-scripts=pnpm' &&
    planG.target === null &&
    Boolean(planG.note) &&
    // 对用户也要说清它是"一次性"的（不是改了人家的全局配置）
    planG.note.includes('一次性'),
  `fixAction=${checkOf(caseG, 'pnpm').fixAction} display=${planG ? planG.display : '（没有计划）'} args=${planG ? JSON.stringify(planG.args) : '—'} target=${planG ? planG.target : '—'} note=${planG ? planG.note : '—'}`,
  'display=/usr/local/bin/npm i -g pnpm --allow-scripts=pnpm，args=[i,-g,pnpm,--allow-scripts=pnpm]，target=null（判定纯函数不跑 npm prefix）',
);

// ---------------------------------------------------------------- H. 内嵌运行时
const caseH = judgeEnvironment(
  raw({ packaged: true, bundled: { electron: '30.0.0', node: '20.9.0', chrome: '124.0.0' } }),
);
const caseHDev = judgeEnvironment(
  raw({ packaged: false, bundled: { electron: '30.0.0', node: '20.9.0', chrome: '124.0.0' } }),
);
check(
  'H 内嵌 Node 20.9.0：打包态 missing（并点名"这不是你机器上的 Node"），开发态一律 ok',
  checkOf(caseH, 'bundled-runtime').status === 'missing' &&
    checkOf(caseH, 'bundled-runtime').detail.includes('不是你机器上的 Node') &&
    checkOf(caseH, 'bundled-runtime').fixHint.includes('升级 DSH Console') &&
    checkOf(caseHDev, 'bundled-runtime').status === 'ok' &&
    checkOf(caseHDev, 'bundled-runtime').detail.includes('开发态'),
  `打包态=${checkOf(caseH, 'bundled-runtime').status} 开发态=${checkOf(caseHDev, 'bundled-runtime').status} detail=${checkOf(caseH, 'bundled-runtime').detail}`,
  'packaged→missing / 开发态→ok',
);

// ---------------------------------------------------------------- I. 本地 Shell 路径失效
const caseI = judgeEnvironment(raw({ shell: { file: '/bin/tcsh', exists: false } }));
check(
  'I 设置里写死的 Shell 不存在了 → missing + 指回设置页',
  checkOf(caseI, 'shell').status === 'missing' && checkOf(caseI, 'shell').fixHint.includes('设置'),
  `status=${checkOf(caseI, 'shell').status} detail=${checkOf(caseI, 'shell').detail} fixHint=${checkOf(caseI, 'shell').fixHint}`,
  'missing + fixHint 指向设置页',
);

// ---------------------------------------------------------------- J. counts / firstProblemId
const caseJOk = judgeEnvironment(raw());
const caseJWarn = judgeEnvironment(raw({ node: versionProbe({ version: 'v20.9.0' }) }));
const caseJMissing = judgeEnvironment(
  raw({ node: versionProbe(NO_BIN), shell: { file: null, exists: false } }),
);
check(
  'J 汇总：counts 三种状态相加正好 8；全 ok→firstProblemId=null，只有 warn→第一个 warn，有 missing→第一个 missing',
  caseJOk.counts.ok === 8 &&
    caseJOk.firstProblemId === null &&
    caseJWarn.firstProblemId === 'node-version' &&
    caseJMissing.firstProblemId === 'node' &&
    caseJMissing.counts.ok + caseJMissing.counts.warn + caseJMissing.counts.missing === 8,
  `全ok=${JSON.stringify(caseJOk.counts)}/${caseJOk.firstProblemId} 只warn=${JSON.stringify(caseJWarn.counts)}/${caseJWarn.firstProblemId} 有missing=${JSON.stringify(caseJMissing.counts)}/${caseJMissing.firstProblemId}`,
  'missing 优先于 warn，同级按 checks 顺序',
);

// ---------------------------------------------------------------- K. "不满足必有出路"不变量
const caseK = judgeEnvironment(
  raw({
    node: versionProbe(NO_BIN),
    npm: versionProbe(NO_BIN),
    pnpm: versionProbe(NO_BIN),
    dsh: dshProbe({ kind: null, display: null, runs: false, resolveError: '四种方式都没找到' }),
    shell: { file: null, exists: false },
  }),
);
check(
  'K 极端夹具（八行几乎全不满足）：每行 detail 非空、每行非 ok 都有 fixHint',
  caseK.checks.length === 8 &&
    caseK.checks.every(
      (item) =>
        item.detail.length > 0 && (item.status === 'ok' || Boolean(item.fixHint && item.fixHint)),
    ),
  caseK.checks.map((item) => `${item.id}:${item.status}${item.fixHint ? '+hint' : ''}`).join(' '),
  '8 行、每行都有 detail、非 ok 都有 fixHint',
);

// ---------------------------------------------------------------- L. 失败归纳
// 最后一条用仓库里的**真机夹具**（pnpm 装不到 peer 依赖那次的原样 stderr）：
// 归纳应该指名道姓说缺的是依赖，而不是笼统说"包不存在"。
const pnpmMissingDep = fs.readFileSync(
  path.join(repoRoot, 'test', 'fixtures', 'pnpm-missing-dep.stderr.txt'),
  'utf8',
);
const failureCases = [
  ['权限 EACCES', 'npm ERR! code EACCES, mkdir /usr/local/lib/node_modules', '权限'],
  ['网络 ETIMEDOUT', 'npm ERR! code ETIMEDOUT', '网络'],
  [
    '404 带主机名',
    'npm ERR! 404 Not Found - GET https://registry.example.com/pnpm',
    'registry.example.com',
  ],
  ['淘宝旧镜像', 'npm ERR! registry.npm.taobao.org/dsh-console: not found', '停服'],
  ['正常输出（认不出来）', 'added 1 package in 2s', null],
  ['真机夹具：缺的是依赖', pnpmMissingDep, '@deepseek-ai/dsh-type-meta'],
];
/** 把一次调用包进 try：归纳函数抛错时也要如实显示，而不是让整个脚本崩掉 */
function attempt(call) {
  try {
    return call();
  } catch (error) {
    return `抛错：${error instanceof Error ? error.message : String(error)}`;
  }
}

const failureActual = failureCases.map(([label, input, expected]) => ({
  label,
  expected,
  got: attempt(() => summarizeEnvFixFailure(input)),
}));
check(
  'L 失败归纳：权限 / 网络 / 404（带主机名）/ 淘宝旧镜像 / 真机依赖缺失各一句，认不出来返回 null',
  failureActual.every((item) =>
    item.expected === null ? item.got === null : String(item.got ?? '').includes(item.expected),
  ),
  failureActual.map((item) => `${item.label}→${item.got}`).join(' | '),
  '三类各一句 + 无关输出 null + 真机夹具指名依赖',
);

// ---------------------------------------------------------------- M. 启动 spec（process-utils 的 launchSpec 统一出口）
//
// 形状是「`/d /s /c` + **一整条已经加好外层引号的命令行** + `windowsVerbatimArguments: true`」，
// 不是逐 token 传：`/s` 会把最外层那对引号剥掉，剥完才是真命令行（cmd 的既定行为）。
// 逐 token 传 + 让 Node 自己加引号会在路径带空格 / 末尾带引号时被切坏，也是 t9 修掉的那类坑。
const winSpec = npmLaunchSpec('C:\\Program Files\\nodejs\\npm.cmd', ['i', '-g', 'pnpm'], 'win32');
const winExeSpec = npmLaunchSpec('C:\\Program Files\\nodejs\\npm.exe', ['-v'], 'win32');
const macSpec = npmLaunchSpec('/usr/local/bin/npm', ['i', '-g', 'pnpm'], 'darwin');
const winArgv = winSpec.args;
const winPacked = winArgv[3] ?? '';
const winCommand = winPacked.replace(/^"([\s\S]*)"$/, '$1');
// 已经是 cmd.exe 的调用（`resolveDshLauncher` 的 shim / npx 那条路）：原样接在后面，不再二次引号
const cmdSpec = launchSpec(
  'C:\\Windows\\system32\\cmd.exe',
  ['/d', '/s', '/c', '"C:\\x\\dsh.cmd" web'],
  'win32',
);
const EXPECTED_NPM_COMMAND = '"C:\\Program Files\\nodejs\\npm.cmd" i -g pnpm';
/** npm 那条路必须**只是**通用包装的转发（同一条坑不该有两个实现） */
const npmDelegatesToLaunchSpec =
  JSON.stringify(
    npmLaunchSpec('C:\\Program Files\\nodejs\\npm.cmd', ['i', '-g', 'pnpm'], 'win32'),
  ) ===
  JSON.stringify(launchSpec('C:\\Program Files\\nodejs\\npm.cmd', ['i', '-g', 'pnpm'], 'win32'));
check(
  'M launchSpec：Windows 上 .cmd 经 cmd.exe（/d /s /c + 一整条已加外层引号的命令行 + windowsVerbatimArguments）',
  npmDelegatesToLaunchSpec &&
    winSpec.file === processUtils.COMSPEC &&
    winArgv.length === 4 &&
    winArgv[0] === '/d' &&
    winArgv[1] === '/s' &&
    winArgv[2] === '/c' &&
    winPacked.startsWith('"') &&
    winPacked.endsWith('"') &&
    winCommand === EXPECTED_NPM_COMMAND &&
    winSpec.windowsVerbatimArguments === true &&
    winExeSpec.file === 'C:\\Program Files\\nodejs\\npm.exe' &&
    winExeSpec.args.join(' ') === '-v' &&
    winExeSpec.windowsVerbatimArguments === false &&
    macSpec.file === '/usr/local/bin/npm' &&
    macSpec.args.join(' ') === 'i -g pnpm' &&
    macSpec.windowsVerbatimArguments === false &&
    cmdSpec.file === 'C:\\Windows\\system32\\cmd.exe' &&
    cmdSpec.args[3] === '""C:\\x\\dsh.cmd" web"' &&
    cmdSpec.windowsVerbatimArguments === true,
  `win32=.cmd → file=${winSpec.file} args=${JSON.stringify(winArgv)} verbatim=${winSpec.windowsVerbatimArguments}；剥掉外层引号后=${winCommand}；.exe → verbatim=${winExeSpec.windowsVerbatimArguments}；darwin → verbatim=${macSpec.windowsVerbatimArguments}`,
  'args=[/d,/s,/c,"<已引好的一整条>"] + windowsVerbatimArguments=true；.exe / POSIX 直连',
);

// ---------------------------------------------------------------- N. 纯函数：确定、不改入参
const deterministicInput = raw({
  pnpm: versionProbe(NO_BIN),
  dsh: dshProbe({ kind: 'npx', display: 'npx -y @deepseek-ai/dsh' }),
});
const deterministicBefore = JSON.stringify(deterministicInput);
const firstRun = judgeEnvironment(deterministicInput);
const secondRun = judgeEnvironment(deterministicInput);
check(
  'N 纯函数：同一入参两次判定结果完全一致，且不改写入参（checkedAt 原样透传，不看时钟）',
  JSON.stringify(firstRun) === JSON.stringify(secondRun) &&
    JSON.stringify(deterministicInput) === deterministicBefore &&
    firstRun.checkedAt === deterministicInput.checkedAt,
  `两次一致=${JSON.stringify(firstRun) === JSON.stringify(secondRun)} 入参未被改=${JSON.stringify(deterministicInput) === deterministicBefore} checkedAt=${firstRun.checkedAt}`,
  '结果一致、入参不变、checkedAt 由入参给',
);

// ---------------------------------------------------------------- O. envFixPlan 的边界
check(
  'O envFixPlan：npm 路径为空 / 只有空白 → null（起不了子进程就不该给按钮）',
  envFixPlan('install-pnpm', null) === null &&
    envFixPlan('install-dsh', '') === null &&
    envFixPlan('install-dsh', '   ') === null &&
    envFixPlan('install-dsh', '/usr/bin/npm').args.join(' ') === 'i -g @deepseek-ai/dsh',
  `null→${envFixPlan('install-pnpm', null)} empty→${envFixPlan('install-dsh', '')} blank→${envFixPlan('install-dsh', '   ')}`,
  'null / "" / 空白都返回 null',
);

// ---------------------------------------------------------------- O2. 版本比对（纯函数，不联网）
//
// t79：环境自检页给 dsh / pnpm 两行加了**带版本比对**的更新入口。判定那一半必须是纯函数 ——
// 这一节喂的全是字面量，**不发任何网络请求**（`fetchPackageMetadata` 只承诺"失败返回 null"，
// 联网那一支没有可离线验证的语义）。夹具用的是真机形状的 registry 数据：
//   - `@deepseek-ai/dsh` 一个稳定版都没有，latest = 0.2.0-rc.2，而列表里最新的是 0.2.1-alpha.1
//   - `pnpm` 的 latest = 12.8.1，而 12.9.0 已经发布（挂在 next-12 标签下）
// 这两条正是"目标必须等于那条命令真的会装到的版本"的由来（见 docs/env-doctor.md 的「版本比对」）。
let npmRegistry;
try {
  npmRegistry = loadBackend('src/main/npm-registry.js');
} catch (error) {
  console.error('加载 npm-registry 失败：', error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const registryMissing = [
  'normalizeRegistryBase',
  'comparePackageVersions',
  'pickTargetVersion',
  'pickPackageUpdate',
  'fetchPackageMetadata',
  'packageNameOfSpec',
  'versionFromText',
  'isPrereleaseVersion',
].filter((name) => typeof npmRegistry[name] !== 'function');
if (registryMissing.length > 0) {
  console.error(
    `npm-registry 缺这些导出：${registryMissing.join('、')} —— 被重构挪走或改名了，验证脚本要跟着同步`,
  );
  process.exit(2);
}
const {
  normalizeRegistryBase,
  comparePackageVersions,
  pickTargetVersion,
  pickPackageUpdate,
  packageNameOfSpec,
  versionFromText,
  isPrereleaseVersion,
} = npmRegistry;

check(
  'O2 comparePackageVersions：按 semver 比（含预发布段），数字段按数值、预发布段逐标识符',
  comparePackageVersions('0.2.0-rc.1', '0.2.0-rc.2') < 0 &&
    comparePackageVersions('0.2.0-rc.2', '0.2.0') < 0 &&
    comparePackageVersions('0.2.0', '0.2.1') < 0 &&
    // 0.2.1-alpha.1 比 0.2.0-rc.2 新（主版本号先决）—— 这条是 dsh 那个坑的一半
    comparePackageVersions('0.2.0-rc.2', '0.2.1-alpha.1') < 0 &&
    comparePackageVersions('1.0.0', '1.0.0') === 0 &&
    comparePackageVersions('10.9.0', '9.15.0') > 0 &&
    comparePackageVersions('1.2.3', '1.2.3') === 0,
  '约定：负数 = 前者更旧',
  '0.2.0-rc.1 < 0.2.0-rc.2 < 0.2.0 < 0.2.1（且 0.2.0-rc.2 < 0.2.1-alpha.1）',
);
check(
  'O2 comparePackageVersions：预发布段的两条细节（数字标识符 < 字母；前缀全同时更长者更大）',
  comparePackageVersions('1.0.0-1', '1.0.0-alpha') < 0 &&
    comparePackageVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0 &&
    comparePackageVersions('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0 &&
    // 数字标识符按数值比，不是按字符串（'10' < '9' 会是错的）
    comparePackageVersions('1.0.0-rc.9', '1.0.0-rc.10') < 0,
  `1<alpha：${comparePackageVersions('1.0.0-1', '1.0.0-alpha')}；alpha<alpha.1：${comparePackageVersions('1.0.0-alpha', '1.0.0-alpha.1')}；rc.9<rc.10：${comparePackageVersions('1.0.0-rc.9', '1.0.0-rc.10')}`,
  '三条都 < 0',
);
check(
  'O2 comparePackageVersions：构建元数据不参与比较；`v` 前缀认；垃圾输入给确定序且不抛',
  comparePackageVersions('1.2.3+build.1', '1.2.3+build.2') === 0 &&
    comparePackageVersions('v24.19.0', '24.19.0') === 0 &&
    comparePackageVersions('不是版本号', '1.0.0') < 0 &&
    comparePackageVersions('1.0.0', '不是版本号') > 0 &&
    comparePackageVersions('乱码', '乱码') === 0 &&
    Number.isFinite(comparePackageVersions('', '')),
  `v 前缀=${comparePackageVersions('v24.19.0', '24.19.0')} 元数据=${comparePackageVersions('1.2.3+a', '1.2.3+b')}`,
  '元数据不影响；v 前缀等价；垃圾项不抛',
);
check(
  'O2 pickTargetVersion：includePrerelease 两支（关 = 只看稳定版；开 = 含预发布）',
  pickTargetVersion(['1.0.0', '1.1.0', '2.0.0-rc.1'], { includePrerelease: false }) === '1.1.0' &&
    pickTargetVersion(['1.0.0', '1.1.0', '2.0.0-rc.1'], { includePrerelease: true }) ===
      '2.0.0-rc.1' &&
    // 同一批里 2.0.0 稳定版比 2.0.0-rc.1 大（semver：稳定版 > 预发布版）
    pickTargetVersion(['2.0.0-rc.1', '2.0.0'], { includePrerelease: true }) === '2.0.0',
  `关=${pickTargetVersion(['1.0.0', '1.1.0', '2.0.0-rc.1'], { includePrerelease: false })} 开=${pickTargetVersion(['1.0.0', '1.1.0', '2.0.0-rc.1'], { includePrerelease: true })}`,
  'false→1.1.0，true→2.0.0-rc.1',
);
check(
  'O2 pickTargetVersion：allowMajor 只在该主版本里挑（`pnpm@10` 那条线靠它），垃圾项跳过、无候选给 null',
  pickTargetVersion(['10.1.0', '10.34.6', '12.8.1'], {
    includePrerelease: false,
    allowMajor: '10',
  }) === '10.34.6' &&
    // allowMajor 与 includePrerelease 可以叠加
    pickTargetVersion(['10.34.6', '10.35.0-rc.1'], {
      includePrerelease: false,
      allowMajor: '10',
    }) === '10.34.6' &&
    pickTargetVersion(['10.34.6', '10.35.0-rc.1'], {
      includePrerelease: true,
      allowMajor: '10',
    }) === '10.35.0-rc.1' &&
    pickTargetVersion(['不是版本号', 'latest'], { includePrerelease: true }) === null &&
    pickTargetVersion([], { includePrerelease: true }) === null &&
    pickTargetVersion(['9.9.9'], { includePrerelease: false, allowMajor: '10' }) === null,
  `10.x=${pickTargetVersion(['10.1.0', '10.34.6', '12.8.1'], { includePrerelease: false, allowMajor: '10' })} 垃圾=${pickTargetVersion(['不是版本号', 'latest'], { includePrerelease: true })}`,
  '10.34.6；跳过垃圾；无候选 null',
);
check(
  'O2 normalizeRegistryBase：空 / 尾斜杠 / 带路径 / 非 http(s) 垃圾，四种都归一成能拼 URL 的基地址',
  normalizeRegistryBase('') === 'https://registry.npmjs.org' &&
    normalizeRegistryBase(null) === 'https://registry.npmjs.org' &&
    normalizeRegistryBase('   ') === 'https://registry.npmjs.org' &&
    normalizeRegistryBase('https://registry.npmmirror.com/') === 'https://registry.npmmirror.com' &&
    normalizeRegistryBase('https://registry.npmmirror.com///') ===
      'https://registry.npmmirror.com' &&
    // 私有源挂在路径下面：路径前缀必须留着，只去尾斜杠
    normalizeRegistryBase('https://host/artifactory/api/npm/npm-repo/') ===
      'https://host/artifactory/api/npm/npm-repo' &&
    // 非 http(s) / 认不出来的 —— 与 pluginRegistryEnv 同一条判据：当没填，走官方源
    normalizeRegistryBase('ftp://host/npm') === 'https://registry.npmjs.org' &&
    normalizeRegistryBase('registry.npmjs.org') === 'https://registry.npmjs.org' &&
    normalizeRegistryBase('javascript:alert(1)') === 'https://registry.npmjs.org',
  `空=${normalizeRegistryBase('')} 尾斜杠=${normalizeRegistryBase('https://a.com/')} 路径=${normalizeRegistryBase('https://host/a/b/')} 垃圾=${normalizeRegistryBase('registry.npmjs.org')}`,
  '空/垃圾 → 官方源；尾斜杠去掉；路径保留',
);
check(
  'O2 pickPackageUpdate：不带版本的 spec 取 latest 标签（不能取"列表里最新的"，否则永远不收敛）',
  (() => {
    // `@deepseek-ai/dsh` 的真机形状：没有稳定版，latest = 0.2.0-rc.2，最新发布却是 0.2.1-alpha.1
    const dsh = pickPackageUpdate({
      current: '0.1.5-rc.1',
      metadata: {
        versions: ['0.1.5-rc.1', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1'],
        distTags: { latest: '0.2.0-rc.2', alpha: '0.2.1-alpha.1', next: '0.2.0-rc.2' },
      },
    });
    // `pnpm` 的真机形状：latest = 12.8.1，而 12.9.0 已经发布（在别的标签下）
    const pnpm = pickPackageUpdate({
      current: '12.4.2',
      metadata: { versions: ['12.8.1', '12.9.0'], distTags: { latest: '12.8.1' } },
    });
    // 本机已经在 alpha 上：装 latest 反而是降级 —— 不许说"已是最新版"
    const ahead = pickPackageUpdate({
      current: '0.2.1-alpha.1',
      metadata: {
        versions: ['0.2.0-rc.2', '0.2.1-alpha.1'],
        distTags: { latest: '0.2.0-rc.2' },
      },
    });
    // 已经就是 latest：newer 为假，界面走读数态
    const same = pickPackageUpdate({
      current: '12.8.1',
      metadata: { versions: ['12.8.1'], distTags: { latest: '12.8.1' } },
    });
    return (
      dsh.target === '0.2.0-rc.2' &&
      dsh.current === '0.1.5-rc.1' &&
      dsh.newer === true &&
      dsh.ahead === false &&
      dsh.error === null &&
      pnpm.target === '12.8.1' &&
      pnpm.newer === true &&
      ahead.ahead === true &&
      ahead.newer === false &&
      same.newer === false &&
      same.ahead === false
    );
  })(),
  'dsh→0.2.0-rc.2（latest）而不是 0.2.1-alpha.1；pnpm→12.8.1 而不是 12.9.0',
  '目标 = 那条命令真的会装到的版本；ahead 单独表达"比源上还新"',
);
check(
  'O2 pickPackageUpdate：带区间的 spec（`pnpm@10`）按主版本挑最高已发布版；查不到就降级成"没目标 + 一句原因"',
  (() => {
    const pure = pickPackageUpdate({
      current: '10.15.0',
      metadata: { versions: ['10.15.0', '10.34.6', '12.8.1'], distTags: { latest: '12.8.1' } },
      allowMajor: '10',
    });
    const offline = pickPackageUpdate({ current: '1.0.0', metadata: null });
    const noTag = pickPackageUpdate({
      current: '1.0.0',
      metadata: { versions: ['1.1.0'], distTags: {} },
    });
    const noCurrent = pickPackageUpdate({
      current: null,
      metadata: { versions: ['1.0.0'], distTags: { latest: '1.0.0' } },
    });
    return (
      pure.target === '10.34.6' &&
      pure.newer === true &&
      // 查询失败：目标为空 + 原因（界面据此退回不带版本号的入口，不显示错误当结论）
      offline.target === null &&
      offline.newer === false &&
      Boolean(offline.error) &&
      // 源上没有 latest 标签：同样是"没有目标"，但不必说"连不上"
      noTag.target === null &&
      noTag.error === null &&
      // 本机版本没测出来：目标还是说清楚，但不给"有没有新版"的结论
      noCurrent.target === '1.0.0' &&
      noCurrent.current === null &&
      noCurrent.newer === false
    );
  })(),
  `10.x→${pickPackageUpdate({ current: '10.15.0', metadata: { versions: ['10.15.0', '10.34.6'], distTags: { latest: '10.34.6' } }, allowMajor: '10' }).target}；离线→${JSON.stringify(pickPackageUpdate({ current: '1.0.0', metadata: null }))}`,
  '10.34.6；离线 target=null 且有 error',
);
check(
  'O2 版本原文的抠取：`dsh --version` 的输出里可能混着 Node 告警，`v` 前缀 / 预发布都要认',
  versionFromText('0.1.5-rc.1') === '0.1.5-rc.1' &&
    versionFromText('v24.19.0\n') === '24.19.0' &&
    versionFromText("(node:13838) Warning: The 'NO_COLOR' env is ignored\n0.2.0-rc.2\n") ===
      '0.2.0-rc.2' &&
    versionFromText('10.34.6') === '10.34.6' &&
    versionFromText('没有版本号') === null &&
    isPrereleaseVersion('0.1.5-rc.1') === true &&
    isPrereleaseVersion('10.15.0') === false &&
    isPrereleaseVersion(null) === false &&
    // spec → 包名（带 scope 的也要对）
    packageNameOfSpec('pnpm@10') === 'pnpm' &&
    packageNameOfSpec('pnpm') === 'pnpm' &&
    packageNameOfSpec('@deepseek-ai/dsh') === '@deepseek-ai/dsh' &&
    packageNameOfSpec('@scope/name@1.2.3') === '@scope/name',
  `告警混排=${versionFromText('(node:1) Warning: x\n0.2.0-rc.2')} 包名=${packageNameOfSpec('@scope/name@1.2.3')}`,
  '抠得出版本号；带 scope 的包名去掉区间后缀',
);

// ---------------------------------------------------------------- O3. 「更新 dsh」的 npm 绑定（纯函数，不碰磁盘）
//
// 方案 A（真机 bug）：dsh 可能装在某个 Node 版本的全局树下（nvm / fnm / 官方安装包各有一份），
// 拿**别的** npm 去 `i -g` 会装进另一棵树 —— 那份 dsh 一个字没变、界面却仍提示有新版本，
// 于是永远不收敛。所以"要升级的那份 dsh 属于哪个 Node"必须先认出来。这一节钉那两步纯函数：
// `dshNodeForLauncher`（判启动形状）与 `npmForNode`（推同目录的 npm）。
// **存在性/可执行性不在这里**（那是 IO 层的 `isUsableNpm`），所以这一节只喂字面量、不碰磁盘。
let dshNpmModule;
try {
  dshNpmModule = loadBackend('src/main/dsh-npm.js');
} catch (error) {
  console.error('加载 dsh-npm 失败：', error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const dshNpmMissing = ['npmForNode', 'dshNodeForLauncher', 'isDshBinJs'].filter(
  (name) => typeof dshNpmModule[name] !== 'function',
);
if (dshNpmMissing.length > 0) {
  console.error(`dsh-npm 缺少导出：${dshNpmMissing.join(' / ')}`);
  process.exit(2);
}
const { npmForNode, dshNodeForLauncher, isDshBinJs } = dshNpmModule;

check(
  'O3 npmForNode：POSIX 取同目录的 npm，win32 取同目录的 npm.cmd（nvm 布局里 node.exe 旁边就是它）',
  npmForNode('/Users/x/.nvm/versions/node/v24.14.1/bin/node', 'darwin') ===
    '/Users/x/.nvm/versions/node/v24.14.1/bin/npm' &&
    npmForNode('/usr/local/bin/node', 'linux') === '/usr/local/bin/npm' &&
    npmForNode('C:\\Users\\x\\nvm\\v24.14.1\\node.exe', 'win32') ===
      'C:\\Users\\x\\nvm\\v24.14.1\\npm.cmd' &&
    // 带空格的路径（macOS 上很常见）不许被截断
    npmForNode('/Applications/My Node/bin/node', 'darwin') === '/Applications/My Node/bin/npm',
  `posix=${npmForNode('/x/bin/node', 'darwin')} win=${npmForNode('C:\\n\\node.exe', 'win32')}`,
  '同目录 + 平台后缀（win32 那一支必须能在这台 macOS 上被测到）',
);
check(
  'O3 npmForNode：空输入给 null（**不猜**，也不返回那个会指向当前目录的 "."）',
  npmForNode('', 'darwin') === null &&
    npmForNode('   ', 'darwin') === null &&
    npmForNode(null, 'darwin') === null &&
    npmForNode(undefined, 'win32') === null,
  `空=${npmForNode('', 'darwin')} 空白=${npmForNode('   ', 'darwin')}`,
  '空 / 只空白 / null / undefined 一律 null',
);
check(
  'O3 npmForNode：没有 npm 的目录照样算出兄弟路径 —— 过滤在 IO 层，不在这条纯函数里',
  // 这正是"那份 Node 旁边没有 npm"的输入形状：纯函数只负责算路径，
  // 由 `isUsableNpm`（存在 + 可执行）决定要不要判成 unbound
  npmForNode('/nonexistent/dir/without/npm/node', 'darwin') === '/nonexistent/dir/without/npm/npm',
  `不存在的目录=${npmForNode('/nonexistent/dir/without/npm/node', 'darwin')}`,
  '算出兄弟路径；存在性与可执行性由调用方查',
);
check(
  'O3 dshNodeForLauncher：只认「node + @deepseek-ai/dsh/lib/bin.js」这一形状，推不出来给 null',
  dshNodeForLauncher({
    file: '/n/v24/bin/node',
    prefixArgs: ['/n/v24/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'],
    viaCmd: false,
    kind: 'node-bin',
  }) === '/n/v24/bin/node' &&
    // 用户在设置里手写的「node + bin.js」自定义命令是**同一形状** —— 按形状判，不按 kind 判
    dshNodeForLauncher({
      file: '/opt/node',
      prefixArgs: ['/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'],
      viaCmd: false,
      kind: 'custom',
    }) === '/opt/node' &&
    // Windows 的 cmd 包装（viaCmd）= 拿不到 node 路径
    dshNodeForLauncher({
      file: 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', '"C:\\nvm\\dsh.cmd"'],
      viaCmd: true,
      kind: 'shim',
    }) === null &&
    // shim / npx：没有 node 路径可推
    dshNodeForLauncher({ file: '/n/v24/bin/dsh', prefixArgs: [], viaCmd: false, kind: 'shim' }) ===
      null &&
    dshNodeForLauncher({
      file: '/usr/local/bin/npx',
      prefixArgs: ['-y', '@deepseek-ai/dsh'],
      viaCmd: false,
      kind: 'npx',
    }) === null &&
    // 别人家的 bin.js 不算（防"随便一个 bin.js 都当 dsh"）
    dshNodeForLauncher({
      file: '/opt/node',
      prefixArgs: ['/opt/other/lib/bin.js'],
      viaCmd: false,
      kind: 'custom',
    }) === null &&
    // Windows 路径也要认（反斜杠）
    isDshBinJs('C:\\nvm\\v24\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js') === true &&
    isDshBinJs('/x/lib/bin.js') === false,
  `shim=${dshNodeForLauncher({
    file: '/n/dsh',
    prefixArgs: [],
    viaCmd: false,
    kind: 'shim',
  })} npx=${dshNodeForLauncher({
    file: '/npx',
    prefixArgs: ['-y', '@deepseek-ai/dsh'],
    viaCmd: false,
    kind: 'npx',
  })}`,
  'node-bin / 自定义 node+bin.js 给 node 路径；shim / npx / cmd 包装 / 别人家的 bin.js 给 null',
);

// ---------------------------------------------------------------- O4. 修复子进程的 env 清洗（纯函数，不碰磁盘）
//
// 根因（真机实测）：Console 把父进程的环境原样传给修复子进程，而 Electron 常常是从一个已经
// 带了整套 `npm_config_*` 的终端/工具里起来的。npm 的优先级是"环境变量 > 由自身位置推出的
// 默认值"，于是 `i -g` 的全局目录由那些继承来的变量决定，而不是由**这份** npm 的位置决定 ——
// 表现就是"拿 v24 的 npm 却装进 v22 那棵树"，界面于是永远提示有新版本。
//
// `cleanNpmEnv` 只做一件事：把 `npm_config_*` / `NPM_CONFIG_*` 全部丢掉，别的原样留着。
// 这一节全部喂字面量、不碰磁盘；真正"装到哪棵树"的证据在 `.verify/npm-env-clean.mjs`（只读）。
const cleanNpmEnv = processUtils?.cleanNpmEnv;
check(
  'O4 契约：cleanNpmEnv 在家里（process-utils 的公开面），不是散在调用点',
  typeof cleanNpmEnv === 'function',
  `typeof processUtils.cleanNpmEnv = ${typeof cleanNpmEnv}`,
  'function',
);
if (typeof cleanNpmEnv === 'function') {
  const leaked = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/someone',
    npm_config_global_prefix: '/nvm/versions/node/v22.17.1',
    npm_config_prefix: '/nvm/versions/node/v22.17.1',
    npm_config_registry: 'https://registry.npmmirror.com',
    npm_config_cache: '/Users/someone/.npm',
    npm_config_node_gyp: '/x/node-gyp.js',
    NPM_CONFIG_PREFIX: '/nvm/versions/node/v22.17.1',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: '127.0.0.1,localhost',
    LANG: 'zh_CN.UTF-8',
  };
  const cleaned = cleanNpmEnv(leaked);
  const leftNpmKeys = Object.keys(cleaned).filter((key) =>
    key.toLowerCase().startsWith('npm_config_'),
  );
  check(
    'O4 cleanNpmEnv：丢掉全部 npm_config_* / NPM_CONFIG_*（大小写不敏感），PATH / HOME / 代理 / locale 原样留着',
    leftNpmKeys.length === 0 &&
      cleaned.PATH === '/usr/bin:/bin' &&
      cleaned.HOME === '/Users/someone' &&
      cleaned.HTTP_PROXY === 'http://127.0.0.1:7890' &&
      cleaned.NO_PROXY === '127.0.0.1,localhost' &&
      cleaned.LANG === 'zh_CN.UTF-8' &&
      // 值也一起丢：不能只把值置空 —— 空串在 npm 眼里仍是"设过"
      !Object.prototype.hasOwnProperty.call(cleaned, 'npm_config_prefix') &&
      !Object.prototype.hasOwnProperty.call(cleaned, 'NPM_CONFIG_PREFIX') &&
      !Object.prototype.hasOwnProperty.call(cleaned, 'npm_config_registry'),
    `剩下的 npm 键=[${leftNpmKeys.join(',')}] 保留键数=${Object.keys(cleaned).length}/${Object.keys(leaked).length}`,
    '剩下的 npm 键=[] 且 5 个非 npm 键一个不少（含大小写变体，键与值一起丢）',
  );
  check(
    'O4 cleanNpmEnv：前缀匹配而不是固定清单（没见过的 npm_config_* 也要清），且不改动入参本身',
    // 真机上漏进来的键远不止文档里列的那几个；列清单必然漏，漏一个就等于没修
    cleanNpmEnv({ npm_config_whatever_new: '1', npm_config_: '2', npm_config: '3' }).npm_config ===
      '3' &&
      Object.keys(cleanNpmEnv({ npm_config_foo: 'x', npm_config_foo2: 'y' })).length === 0 &&
      // 入参不许被改（调用点那份 env 还要继续用）
      Object.keys(leaked).length === 11 &&
      leaked.npm_config_prefix === '/nvm/versions/node/v22.17.1',
    `未知键剩下=${JSON.stringify(cleanNpmEnv({ npm_config_whatever_new: '1' }))} 无下划线的 npm_config 保留=${cleanNpmEnv({ npm_config: '3' }).npm_config}`,
    '前缀匹配清掉未知键；`npm_config`（没有下划线）不误伤；入参 11 个键原样',
  );
  check(
    'O4 cleanNpmEnv：空对象 / undefined 不炸，返回空对象（不返回 undefined）',
    Object.keys(cleanNpmEnv({})).length === 0 &&
      Object.keys(cleanNpmEnv(undefined)).length === 0 &&
      typeof cleanNpmEnv(undefined) === 'object' &&
      cleanNpmEnv(undefined) !== undefined,
    `{} → ${JSON.stringify(cleanNpmEnv({}))}；undefined → ${JSON.stringify(cleanNpmEnv(undefined))}`,
    '两种都给一个新的空对象',
  );
}

// ---------------------------------------------------------------- P. 契约静态检查
// t55 起 shared/ipc.ts 是 barrel，契约按主题住在 ipc-*.ts 里：读整份（顺序与拆分前一致）
const ipcSource = [
  'ipc',
  'ipc-shell',
  'ipc-update',
  'ipc-runtime',
  'ipc-archive',
  'ipc-plugin',
  'ipc-env',
  'ipc-node',
  'ipc-api',
]
  .map((stem) => fs.readFileSync(path.join(repoRoot, 'src', 'shared', `${stem}.ts`), 'utf8'))
  .join('\n');
const flatIpc = ipcSource.replace(/\s+/g, ' ');
// 「零运行时 import」：叶子之间只允许 import type（值 import 会把 fs/path 卷进渲染层包里）
const importLines = ipcSource
  .split(/\r?\n/)
  .filter((line) => /^\s*import\b/.test(line) && !/^\s*import\s+type\b/.test(line));
const idUnion = /export type EnvCheckId =([\s\S]*?);/.exec(ipcSource)?.[1] ?? '';
const idList = [...idUnion.matchAll(/'([^']+)'/g)].map((match) => match[1]);
const apiMembers = ['envCheck', 'envFix', 'envFixCancel', 'onEnvFixState', 'onEnvFixOutput'];
check(
  'P 契约：契约仍是 0 个运行时 import（纯类型 + 常量，叶子之间只有 import type）；8 个 id 顺序与文档一致；2 个动作；5 个 API 都在',
  importLines.length === 0 &&
    idList.join(',') === 'node,node-version,npm,pnpm,dsh,dsh-run,bundled-runtime,shell' &&
    /export type EnvCheckStatus = 'ok' \| 'warn' \| 'missing';/.test(flatIpc) &&
    [...flatIpc.matchAll(/export type EnvFixAction = ([^;]+);/g)][0]?.[1] ===
      "'install-pnpm' | 'install-dsh'" &&
    apiMembers.every((name) => new RegExp(`${name}:`).test(flatIpc)) &&
    !/onEnvReport/.test(flatIpc),
  `imports=${importLines.length} ids=${idList.join(',')} api=${apiMembers.filter((name) => new RegExp(`${name}:`).test(flatIpc)).join(',')} onEnvReport=${/onEnvReport/.test(flatIpc)}`,
  '0 个运行时 import、8 ids 按文档顺序、5 个 API、没有 onEnvReport',
);

// ---------------------------------------------------------------- Q. 渲染层只递 action
const rendererEnvLib = fs.readFileSync(
  path.join(repoRoot, 'src', 'renderer', 'state', 'env-doctor.ts'),
  'utf8',
);
const rendererFiles = [];
const collectRenderer = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectRenderer(full);
    else if (/\.(ts|vue)$/.test(entry.name) && entry.name !== 'env-doctor.ts') {
      rendererFiles.push(full);
    }
  }
};
collectRenderer(path.join(repoRoot, 'src', 'renderer'));
const callSites = rendererFiles.filter((file) =>
  fs.readFileSync(file, 'utf8').includes('api.envFix('),
);
check(
  'Q 渲染层只递 action：api.envFix 全仓库只有一处调用点，且参数是 { action }',
  /api\.envFix\(\{\s*action\s*\}\)/.test(rendererEnvLib) && callSites.length === 0,
  `state/env-doctor.ts 里传 { action }=${/api\.envFix\(\{\s*action\s*\}\)/.test(rendererEnvLib)}；其它渲染层文件里的调用点 ${callSites.length} 个`,
  '唯一调用点 = state/env-doctor.ts 的 runEnvFix',
);

// ---------------------------------------------------------------- R. 可执行性：裸名 shim 不算可执行目标
//
// 反例来自真机：Node 安装目录里 `npm`（`#!/usr/bin/env bash`）、`pnpm`（`#!/bin/sh`）与
// `npm.cmd` / `pnpm.cmd` 是**并存**的，CreateProcess / spawn 起不了那个 sh 脚本。
// 「裸名优先」的候选顺序会稳定地挑中它 —— 症状是 npm 探测不到输出、一键修复直接 ENOENT。
// 所以这里既钉纯函数（`isRunnablePath`），也**真造一个目录实测解析顺序**。
const SHIM_SOURCE = '#!/usr/bin/env bash\necho 10.9.0\n';

/**
 * 真造两个目录实测 `whichSync` 的挑法：一个里「`#!` 裸名 shim + 同名 .cmd」并存，另一个只有 shim。
 * 无论成功失败都会恢复 `PATH` 并删掉夹具目录（夹具在 gitignore 的 `.verify/` 下）。
 */
function probeWhichPicks() {
  const originalPath = process.env.PATH;
  const fixtureRoot = path.join(repoRoot, '.verify', 'cases-fixture');
  const mixedDir = path.join(fixtureRoot, 'mixed');
  const shimDir = path.join(fixtureRoot, 'shim-only');
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.mkdirSync(mixedDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(mixedDir, 'npm'), SHIM_SOURCE);
    fs.writeFileSync(path.join(mixedDir, 'npm.cmd'), '@echo off\r\necho 10.9.0\r\n');
    fs.writeFileSync(path.join(shimDir, 'npm'), SHIM_SOURCE);
    for (const file of [
      path.join(mixedDir, 'npm'),
      path.join(mixedDir, 'npm.cmd'),
      path.join(shimDir, 'npm'),
    ]) {
      try {
        fs.chmodSync(file, 0o755); // POSIX 的 whichSync 会看可执行位
      } catch {
        // Windows 上无所谓
      }
    }
    // 夹具里那个裸名文件确实是个 `#!` shim（否则这条反例就名不副实）
    const shimStartsWithHashbang = fs
      .readFileSync(path.join(shimDir, 'npm'), 'utf8')
      .startsWith('#!');
    // ① 同名并存：必须挑带扩展名的那个，不能挑 sh shim
    process.env.PATH = `${mixedDir}${path.delimiter}${originalPath ?? ''}`;
    const mixed = whichSync('npm');
    // ② 只有 sh shim：Windows 上应当一个都不认（不能"退而求其次"把 shim 当可执行文件）
    process.env.PATH = shimDir;
    const only = whichSync('npm');
    return { mixed, only, shimStartsWithHashbang, mixedDir, shimDir, error: null };
  } catch (error) {
    return {
      mixed: null,
      only: null,
      shimStartsWithHashbang: false,
      mixedDir: null,
      shimDir: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
const whichProbe = probeWhichPicks();
const { mixed: whichMixed, only: whichShimOnly } = whichProbe;
const isWindowsHost = process.platform === 'win32';
const mixedBasename = whichMixed ? path.basename(whichMixed).toLowerCase() : '';
check(
  'R 可执行性：首行 `#!` 的裸名 shim 不得被判成可执行目标（Windows 按 PATHEXT 挑 .cmd / .exe，POSIX 才裸名优先）',
  isRunnablePath('D:\\Node\\nodejs\\npm', 'win32') === false &&
    isRunnablePath('D:\\Node\\nodejs\\npm.cmd', 'win32') === true &&
    isRunnablePath('D:\\Node\\nodejs\\npm.exe', 'win32') === true &&
    isRunnablePath('D:\\Node\\nodejs\\npm', 'darwin') === true &&
    whichProbe.error === null &&
    whichProbe.shimStartsWithHashbang === true &&
    (isWindowsHost
      ? whichMixed !== null &&
        mixedBasename !== 'npm' &&
        isRunnablePath(whichMixed, 'win32') &&
        whichShimOnly === null
      : whichMixed === path.join(whichProbe.mixedDir, 'npm') &&
        whichShimOnly === path.join(whichProbe.shimDir, 'npm')),
  `isRunnablePath(裸名,win32)=${isRunnablePath('D:\\Node\\nodejs\\npm', 'win32')}；(裸名,darwin)=${isRunnablePath('D:\\Node\\nodejs\\npm', 'darwin')}；混合目录 whichSync('npm')=${whichMixed}；只有 shim 时=${whichShimOnly}；夹具错误=${whichProbe.error ?? '无'}`,
  isWindowsHost
    ? '混合目录挑带扩展名的那个（绝不挑 npm 裸名）；只有 shim 时返回 null'
    : 'POSIX 上裸名优先（不看扩展名）',
);

// ---------------------------------------------------------------- S. 超时是独立终态（文案与文档 3.2 #7 一致）
//
// 反例来自真机：超时到点是**我们主动 kill** 的，退出码会是 null / 非 0；如果它落进
// 「退出码 N，认不出具体原因」那条兜底，界面就把原因说错了（用户看到的是 npm 的失败）。
const envSourceCode = fs
  .readFileSync(path.join(repoRoot, 'src', 'main', 'env-doctor.ts'), 'utf8')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const timeoutMessage = fixTimeoutMessage();
const timeoutIndex = envSourceCode.indexOf('if (this.timedOut) {');
const exitCodeIndex = envSourceCode.indexOf('if (outcome.code !== 0) {');
check(
  'S 超时：是独立终态（判在「退出码 != 0」之前），文案与文档 3.2 #7 一致，不再落进「退出码未知，认不出具体原因」',
  FIX_TIMEOUT_MS === 5 * 60 * 1000 &&
    /^超过 5 分钟没跑完，已自动中断/.test(timeoutMessage) &&
    !/认不出具体原因/.test(timeoutMessage) &&
    !/退出码/.test(timeoutMessage) &&
    /^超过 2 分钟没跑完，已自动中断/.test(fixTimeoutMessage(90_000)) &&
    /const message = fixTimeoutMessage\(\)/.test(envSourceCode) &&
    timeoutIndex > 0 &&
    exitCodeIndex > timeoutIndex &&
    /退出码 \$\{outcome\.code \?\? '未知'\}，认不出具体原因/.test(envSourceCode),
  `fixTimeoutMessage()=${timeoutMessage}；fixTimeoutMessage(90_000)=${fixTimeoutMessage(90_000)}；源码里 timedOut 分支位置=${timeoutIndex}，退出码分支位置=${exitCodeIndex}（前者必须在前）`,
  '超时走自己的那一句；「退出码未知」只留给 npm 自己的失败',
);

// ---------------------------------------------------------------- T. 本机这份 dsh 对 Node 的要求
//
// 用户裁决：**不是所有人装的是同一份 dsh**，所以「Node 版本」这一行的判据不能只有我们抄来的
// 那句常量。它现在是"**本机那份 dsh 说的 + 兜底那句常量，两句都要满足**"（`judgeNodeVersion`）。
// 本机实测（dsh 0.1.5-rc.1 / 524 个包）：3 个包要 `>=22.19.0`（其中就有 undici 8），与上游
// 仓库根那句 `^22.19.0 || >=24.0.0` 的下限一致。
const localDshFixture = (over = {}) => ({
  version: '0.1.5-rc.1',
  root: '/usr/local/lib/node_modules/@deepseek-ai/dsh',
  declared: null,
  required: { range: '>=22.19.0', name: 'undici', version: '8.10.2', count: 3 },
  scanned: 524,
  ...over,
});

// T1 本机证据当判据，并点名"是谁要的、几个包也在要"
const nodeVersionT1 = checkOf(
  judgeEnvironment(raw({ localDsh: localDshFixture() })),
  'node-version',
);
check(
  'T1 判据来自本机那份 dsh 的依赖链，并点名依赖与"还有几个包也在要"',
  nodeVersionT1.status === 'ok' &&
    nodeVersionT1.detail.includes('>=22.19.0') &&
    nodeVersionT1.detail.includes('undici 8.10.2') &&
    nodeVersionT1.detail.includes('等 3 个包'),
  `status=${nodeVersionT1.status} detail=${nodeVersionT1.detail}`,
  'ok（v24.19.0 满足 >=22.19.0）+ detail 里出现 >=22.19.0 / undici 8.10.2 / 等 3 个包',
);

// T2 低于本机那份 dsh 的下限：warn，而且要说清"这种 Node 上会发生什么"
const nodeVersionT2 = checkOf(
  judgeEnvironment(
    raw({ node: versionProbe({ version: 'v22.17.1' }), localDsh: localDshFixture() }),
  ),
  'node-version',
);
check(
  'T2 低于本机那份 dsh 的下限 → warn，并说清"这种 Node 上 dsh 会静默空跑"',
  nodeVersionT2.status === 'warn' &&
    nodeVersionT2.detail.includes('v22.17.1') &&
    nodeVersionT2.detail.includes('>=22.19.0') &&
    nodeVersionT2.detail.includes('静默空跑'),
  `status=${nodeVersionT2.status} detail=${nodeVersionT2.detail}`,
  'warn + 点名本机下限 + 说清静默空跑',
);

// T3 **两句都要满足**：依赖链的 `>=22.19.0` 数学上包含奇数版 23，但 23 这条线不在 dsh 支持的
// 范围里（它早于 dsh 入口要的那个 Node API；上游那句 `^22.19.0 || >=24.0.0` 正是靠 `^22.19.0`
// 的上界把 23 挡在外面的）。少了这条，本机证据会把 23 判成"可以"—— 比原来更松。
const nodeVersionT3 = checkOf(
  judgeEnvironment(
    raw({ node: versionProbe({ version: 'v23.0.0' }), localDsh: localDshFixture() }),
  ),
  'node-version',
);
check(
  'T3 依赖链够、但这条 Node 线不在 dsh 支持的范围内（23）→ 仍判 warn（两句都要满足）',
  nodeVersionT3.status === 'warn' &&
    nodeVersionT3.detail.includes('v23.0.0') &&
    nodeVersionT3.detail.includes('不在它支持的范围内'),
  `status=${nodeVersionT3.status} detail=${nodeVersionT3.detail}`,
  'warn（不许因为本机下限够就放行 23）',
);

// T4 本机那份要得**比兜底那句更狠**时按它判（将来 dsh 要 >=26 就是这个样子）
const nodeVersionT4 = checkOf(
  judgeEnvironment(
    raw({
      node: versionProbe({ version: 'v24.19.0' }),
      localDsh: localDshFixture({
        required: { range: '>=26.0.0', name: 'undici', version: '9.0.0', count: 1 },
      }),
    }),
  ),
  'node-version',
);
check(
  'T4 本机那份 dsh 要得更狠时抬高门槛（v24.19.0 + 本机要 >=26.0.0 → warn）',
  nodeVersionT4.status === 'warn' && nodeVersionT4.detail.includes('>=26.0.0'),
  `status=${nodeVersionT4.status} detail=${nodeVersionT4.detail}`,
  'warn（本机证据能抬门槛，兜底那句拦不住它）',
);

// T5 读不到本机那份（npx 那条路 / 读不到包目录）→ 退回兜底那句，文案与从前一致
const nodeVersionT5 = checkOf(
  judgeEnvironment(raw({ node: versionProbe({ version: 'v20.9.0' }) })),
  'node-version',
);
check(
  'T5 没有本机证据时退回兜底那句（detail 里出现那句常量），不做任何新判断',
  nodeVersionT5.status === 'warn' && nodeVersionT5.detail.includes(`要求 ${NODE_RANGE}`),
  `status=${nodeVersionT5.status} detail=${nodeVersionT5.detail}`,
  `warn + detail 里出现 ${NODE_RANGE}`,
);

// T6 纯函数：`satisfiesSimpleRange` 认识 npm `engines` 里真会出现的那些写法
const rangeFacts = [
  ['>=22.19.0', 'v22.19.0', true],
  ['>=22.19.0', 'v22.18.9', false],
  ['>= 22.19.0', 'v22.19.0', true],
  ['^22.19.0 || >=24.0.0', 'v22.19.0', true],
  ['^22.19.0 || >=24.0.0', 'v23.0.0', false],
  ['^22.19.0 || >=24.0.0', 'v24.0.0', true],
  ['^20.19.0 || >=22.12.0', 'v20.19.0', true],
  ['^20.19.0 || >=22.12.0', 'v21.0.0', false],
  ['~22.19.0', 'v22.19.9', true],
  ['~22.19.0', 'v22.20.0', false],
  ['22.x', 'v22.9.0', true],
  ['22.x', 'v23.0.0', false],
  ['>=22 <23', 'v22.9.0', true],
  ['>=22 <23', 'v23.0.0', false],
  ['22.19.0', 'v22.19.0', true],
  ['22.19.0', 'v22.19.1', false],
  ['*', 'v9.0.0', true],
];
const rangeActual = rangeFacts
  .map(
    ([range, text, expected]) =>
      `${range}@${text}=${satisfiesSimpleRange(parseNodeVersion(text), range)}/${expected}`,
  )
  .join(' ');
check(
  'T6 satisfiesSimpleRange 认得 `>=` / `^` / `~` / x-range / 与 / 或 / 空格 / 通配',
  rangeFacts.every(([range, text, expected]) => {
    const parsed = parseNodeVersion(text);
    return parsed !== null && satisfiesSimpleRange(parsed, range) === expected;
  }),
  rangeActual,
  '每一条都与期望一致',
);

// T7 认不出来 → null（"不猜"）而不是 false；但只要有一段说得清且满足，就是 true（**顺序无关**）
const unknownA = satisfiesSimpleRange(parseNodeVersion('v24.0.0'), '不是区间');
const unknownB = satisfiesSimpleRange(parseNodeVersion('v24.0.0'), '<20 || 乱写');
const sortedA = satisfiesSimpleRange(parseNodeVersion('v24.0.0'), '>=22.19.0 || 乱写');
const sortedB = satisfiesSimpleRange(parseNodeVersion('v24.0.0'), '乱写 || >=22.19.0');
check(
  'T7 认不出来 → null；但"有一段说得清且满足"就是 true（且与那段的先后无关）',
  unknownA === null && unknownB === null && sortedA === true && sortedB === true,
  `'不是区间'=${unknownA} '<20 || 乱写'=${unknownB} '>=22.19.0 || 乱写'=${sortedA} '乱写 || >=22.19.0'=${sortedB}`,
  'null / null / true / true',
);

// T8 取"最低可接受版本"：并集取最小、caret 取下界、通配与乱写 → null
const minFacts = {
  union: minNodeOfRange('^18.19.0 || >=20.6.0'),
  spaced: minNodeOfRange('>= 22.19.0'),
  any: minNodeOfRange('*'),
  junk: minNodeOfRange('乱写'),
};
check(
  'T8 minNodeOfRange 取最低可接受版本（并集取最小、带空格也算、通配与乱写给 null）',
  JSON.stringify(minFacts.union) === JSON.stringify({ major: 18, minor: 19, patch: 0 }) &&
    JSON.stringify(minFacts.spaced) === JSON.stringify({ major: 22, minor: 19, patch: 0 }) &&
    minFacts.any === null &&
    minFacts.junk === null,
  JSON.stringify(minFacts),
  '{"major":18,"minor":19,"patch":0} / {"major":22,"minor":19,"patch":0} / null / null',
);

// T9 挑"要得最狠"的那条，并数清同一条下限有几个包（只点名一个包会让人以为是它的怪癖）
const entriesT9 = [
  { range: '>=18', name: 'a', version: '1' },
  { range: '^18.19.0 || >=20.6.0', name: 'b', version: '2' },
  { range: '>=22.19.0', name: 'undici', version: '8.10.2' },
  { range: '>=22.19.0', name: 'pi-ai', version: '0.85.1' },
  { range: '乱写', name: 'c', version: '3' },
];
const bestT9 = highestNodeRequirement(entriesT9);
check(
  'T9 highestNodeRequirement 挑下限最高的那条，并数清同一条下限有几个包',
  bestT9 !== null && bestT9.range === '>=22.19.0' && bestT9.name === 'undici' && bestT9.count === 2,
  JSON.stringify(bestT9),
  '{"range":">=22.19.0","name":"undici","version":"8.10.2","count":2}',
);

// T10 本机那句从哪来：依赖链优先，其次它自己声明的 engines，都没有 → null
const localRangeCases = {
  deps: localNodeRange(localDshFixture()),
  declared: localNodeRange(localDshFixture({ required: null, declared: '^22.19.0 || >=24.0.0' })),
  none: localNodeRange(localDshFixture({ required: null, declared: null })),
  absent: localNodeRange(undefined),
};
check(
  'T10 localNodeRange 的优先序：依赖链 > 它自己声明的 engines > null（读不到就退回兜底那句）',
  localRangeCases.deps?.source === 'local' &&
    localRangeCases.declared?.source === 'declared' &&
    localRangeCases.declared?.range === '^22.19.0 || >=24.0.0' &&
    localRangeCases.none === null &&
    localRangeCases.absent === null,
  JSON.stringify(localRangeCases),
  'deps=local / declared=declared（用它声明的那句）/ none=null / absent=null',
);

// T11 文案：本机证据与"它自己声明的"两种说法都要点名来源
const phraseDeps = requirementPhrase(localNodeRange(localDshFixture()));
const phraseDeclared = requirementPhrase(localRangeCases.declared);
check(
  'T11 requirementPhrase 把"是谁说的"写在脸上（依赖链 / 自己声明两种说法）',
  phraseDeps === '本机这份 dsh 的要求 >=22.19.0（来自依赖 undici 8.10.2 等 3 个包）' &&
    phraseDeclared === '本机这份 dsh（0.1.5-rc.1）自己声明的要求 ^22.19.0 || >=24.0.0',
  `${phraseDeps} ／ ${phraseDeclared}`,
  '本机这份 dsh 的要求 >=22.19.0（来自依赖 undici 8.10.2 等 3 个包） ／ 本机这份 dsh（0.1.5-rc.1）自己声明的要求 ^22.19.0 || >=24.0.0',
);

// T12 judgeNodeVersion 是纯函数：任何输入都不抛，且状态只有 ok / warn 两档
const hostileVerdicts = [
  judgeNodeVersion(parseNodeVersion('v24.0.0'), null),
  judgeNodeVersion(parseNodeVersion('v24.0.0'), undefined),
  judgeNodeVersion(parseNodeVersion('v24.0.0'), {
    version: null,
    root: null,
    declared: '乱写',
    required: null,
    scanned: 0,
  }),
  judgeNodeVersion(parseNodeVersion('v24.0.0'), {
    version: null,
    root: null,
    declared: null,
    required: { range: '乱写', name: 'x', version: '1', count: 1 },
    scanned: 1,
  }),
];
check(
  'T12 judgeNodeVersion：畸形输入不抛、认不出来的区间退回兜底、状态只有 ok / warn',
  hostileVerdicts.every((verdict) => verdict.status === 'ok' || verdict.status === 'warn') &&
    hostileVerdicts[2].local === null &&
    hostileVerdicts[3].local === null,
  hostileVerdicts
    .map((verdict) => `${verdict.status}/${verdict.failedBy}/${verdict.local?.range ?? 'null'}`)
    .join(' '),
  'ok（都满足，因为 v24 满足兜底那句）且认不出来的区间不进判据',
);

// ---------------------------------------------------------------- 观察（不判 pass/fail）
const noNodeReport = judgeEnvironment(raw({ node: versionProbe(NO_BIN) }));
const noDshReport = judgeEnvironment(
  raw({ dsh: dshProbe({ kind: null, display: null, runs: false, resolveError: '找不到 dsh' }) }),
);
observe(
  `文档未定义：外部 Node 缺失时 node-version 被判成 ${checkOf(noNodeReport, 'node-version').status}（文档 1.2 只写了 ok / warn 两档）`,
);
observe(
  `文档未定义：dsh 本体没定位到时 dsh-run 被判成 ${checkOf(noDshReport, 'dsh-run').status}（文档 1.6 只写了 ok / missing / warn 的分支）`,
);
const envReportPushes = [];
const collectPushes = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectPushes(full);
    else if (/\.(ts|vue)$/.test(entry.name)) {
      const text = fs.readFileSync(full, 'utf8');
      if (/'env:report'|"env:report"/.test(text))
        envReportPushes.push(path.relative(repoRoot, full));
    }
  }
};
collectPushes(path.join(repoRoot, 'src'));
observe(
  `文档 4.2 / 3.3 提到主进程会推 env:report 事件；实际 src/ 里出现该事件名的文件：${envReportPushes.length ? envReportPushes.join(', ') : '0 个'}（契约里也没有 onEnvReport）`,
);
observe(
  `win32 上的 .exe 直连，不经 cmd.exe（${JSON.stringify(winExeSpec)}）：文档 3.2 只点名了 .cmd / .bat，可执行文件直接 spawn 是合理的`,
);
observe(
  `launchSpec 来自 ${launchSpecFrom}，isRunnablePath 来自 ${runnableFrom}` +
    '（t9 的后续重构把这两个通用件从 env-doctor 挪到了 process-utils；脚本两边都认）',
);
observe(
  `本次加载的编译产物来自：${path.relative(repoRoot, buildDir) || '仓库根（树里的 tsc 产物）'}` +
    `（树里没有就用 .verify/cases-build 的私有构建，见脚本头部）`,
);

// ---------------------------------------------------------------- 输出
let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name}`);
  console.log(`       实际：${item.actual}`);
  if (!item.pass) console.log(`       期望：${item.expected}`);
}
console.log('\n观察（不判 pass/fail，供收口阶段决定是否改文档）：');
for (const text of observations) console.log(`  - ${text}`);
console.log(
  `\n环境自检独立反例：${results.length - failed}/${results.length} 通过（NODE_RANGE=${NODE_RANGE}）`,
);
process.exitCode = failed > 0 ? 1 : 0;
