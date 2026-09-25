/**
 * 纯判定 `judgeEnvironment` 与"哪里不对"的整理（不碰磁盘、不起子进程、不看时钟）
 *
 * t51 从 `env-doctor.ts` 拆出来的；那个文件现在只做 barrel + 两个有状态的类（`EnvDoctor` /
 * `EnvFixRunner`），别的模块与两个反例脚本的 import 路径都不用改。
 */
import type {
  EnvCheck,
  EnvCheckId,
  EnvCheckStatus,
  EnvDoctorReport,
  EnvFixAction,
  EnvFixPlan,
} from '../shared/ipc';
import { RELEASES_URL } from '../shared/ipc';
import { envFixPlan, envValueOf, pnpmInstallSpec } from './env-fix-plan';
import {
  NODE_RANGE,
  NODE_RANGE_BUILD,
  judgeNodeVersion,
  parseNodeVersion,
  requirementPhrase,
  satisfiesBuildRange,
} from './env-node-range';
import type { NodeVersionVerdict } from './env-node-range';
import type { EnvProbeRaw, VersionProbe } from './env-probe-types';
import { arrayOf } from './env-wizard';

/** 不满足时的兜底出路：保证"每一行非 ok 都有 fixHint"这条不变量在结构上成立 */
const FALLBACK_HINTS: Record<EnvCheckId, string> = {
  node: '到 https://nodejs.org/en/download 装一个 Node，或用版本管理器（`nvm install 24 && nvm use 24`）。',
  'node-version': '把 Node 升到 22.12+ 或 20.19+（本机实测能跑 dsh 的是 24 那一档）。',
  npm: '重装官方 Node（npm 随它一起装）；只用 pnpm 的话也可以 `corepack enable pnpm`。',
  pnpm: '`npm i -g pnpm`；没有 npm 时用 `corepack enable pnpm`。',
  dsh: '`npm i -g @deepseek-ai/dsh`，或在「设置 → 启动方式 → dsh 命令」里写一条能跑的启动命令。',
  'dsh-run':
    '在「设置 → 启动方式 → dsh 命令」里写一条能跑的启动命令（通常是换一个能跑 dsh 的 Node 版本）。',
  'bundled-runtime': '升级 DSH Console。',
  shell: '到「设置 → 本地 Shell」清空这一项（恢复自动选择）或改成正确的路径。',
};

/**
 * node / node-version 的出路（VM-13 / F-05）：**先给应用内那条路**。
 *
 * 门禁第一步就有「安装 Node.js」（直装官方稳定版 / 通过 nvm 安装两种），装好还会由我们切过去 ——
 * 所以文案里绝不能说「先在终端里选一个版本」。自己动手只作为备选写在后半句（要命令行原文的人拿得到，
 * 但我们不把开终端当成给他安排的活）。
 */
function nodeInstallHint(platform: string): string {
  const inApp =
    '点上面的「安装 Node.js」：直接安装官方稳定版、或通过 nvm 安装，都由我们装好并切过去。';
  return platform === 'win32'
    ? `${inApp}想自己来也可以：\`nvm install 24 && nvm use 24\`（nvm-windows），或到 nodejs.org 装 22.19+ 或 24 的 LTS。`
    : `${inApp}想自己来也可以：\`nvm install 24 && nvm use 24\`（nvm/fnm），或到 nodejs.org 装 22.19+ 或 24 的 LTS。`;
}

function installNodeHint(platform: string): string {
  return platform === 'win32'
    ? `点上面的「安装 Node.js」由我们装一个（直装官方稳定版 / 通过 nvm 安装都行）。想自己来也可以：到 https://nodejs.org/en/download 下载安装包，或用 nvm-windows 的 \`nvm install 24 && nvm use 24\`。`
    : `点上面的「安装 Node.js」由我们装一个（直装官方稳定版 / 通过 nvm 安装都行）。想自己来也可以：用版本管理器 \`nvm install 24 && nvm use 24\`，或到 https://nodejs.org/en/download 下载 22.19+ 或 24 的 LTS。`;
}

function upgradeNodeHint(platform: string): string {
  return nodeInstallHint(platform);
}

/**
 * 「Node 版本」不满足时那句话（纯函数；三种情形各说各的）。
 *
 * - 卡在**本机那份 dsh** 的下限：点名是谁要的（用户能核对）
 * - 卡在**兜底那句常量**（而本机下限是够的）：这条 Node 线不在 dsh 支持的范围内 —— 奇数版 23
 *   是唯一一例：依赖链的 `>=22.19.0` 数学上包含它，而它早于 dsh 入口要的那个 Node API
 * - 没有本机证据：兜底那句的老文案
 *
 * 三种都补上"这种 Node 上 dsh 会静默空跑"—— 这是这一行为什么值得看一眼的唯一理由（§7.4）。
 */
function nodeMismatchText(version: string, verdict: NodeVersionVerdict | null): string {
  const tail =
    '这种 Node 上 dsh 会静默空跑（退出码 0、零输出）；能不能跑仍由下面「实测 dsh」那一项定';
  if (verdict?.failedBy === 'local' && verdict.local) {
    return `${version} 不满足${requirementPhrase(verdict.local)} —— ${tail}`;
  }
  if (verdict?.failedBy === 'upstream' && verdict.local) {
    return `${version} 不满足要求区间（要求 ${NODE_RANGE}）—— 本机这份 dsh 的依赖链下限 ${verdict.local.range} 虽然够，但这一条 Node 线不在它支持的范围内；${tail}`;
  }
  return `${version} 不在要求区间内（要求 ${NODE_RANGE}）—— 这是 dsh 与它依赖链的要求；${tail}`;
}

/**
 * 「这一轮没测」的出路（`skipped` 的项都写它）。
 *
 * VM-13 / F-05 的教训：这里原来写的是「在终端里手工跑一次 `xxx -v` 确认」—— 可这一轮只是**我们自己**
 * 的快速探测没起子进程（完整检测 1.5 秒后就来），根本没有东西坏掉。把用户打发去终端是同一类毛病：
 * **界面文案不许把应用自己就能做的事推给用户**（与 VM-04 的"不许把内部记号暴露给用户"并列）。
 */
const NOT_MEASURED_HINT =
  '不用做什么：这一轮完整检测马上就会给出这一项的结论（启动瞬间的快速探测只读文件系统、不起子进程）。';

/**
 * 「这个运行环境不允许起子进程」时的出路：**先让用户点重新检测**，再补一句只有他能做的确认。
 *
 * 这一类**是**真该由用户做的：我们的进程起不了子进程（受限/沙箱环境），他自己有权限的终端能 ——
 * 所以这里保留"手工确认"，与上面那种"把应用能做的事推给用户"是两回事。
 */
const BLOCKED_HINT_PREFIX = '先点一下「重新检测」再试一次；还测不出来的话，';

/**
 * 我们找到的这份 Node 是不是**版本管理器管的**（nvm-windows 的 shim / 符号链接目录、fnm、volta、nodenv）。
 *
 * 为什么要单独认它：客机上的真实状态是「版本管理器装好了、但一个 Node 版本都没装」（VM-01 / VM-13），
 * 这时 `node.exe` 只是个跑不出结果的 shim —— 文案必须说中这一种状态（该点应用里的「安装」由我们装一个
 * 并切过去），而不是笼统地说"这份 Node 用不了"，更不能让用户自己回终端里 `nvm use`。
 *
 * 判据（纯函数，只读入参）：路径里出现版本管理器的目录名，或者它落在版本管理器写在环境里的目录下
 *（Windows 的 nvm 会设 `NVM_HOME` / `NVM_SYMLINK`，fnm / volta 也有各自的变量）。
 */
export function looksVersionManagerNode(
  file: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = String(file ?? '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/');
  if (!raw) return false;
  const full = raw.startsWith('/') ? raw : `/${raw}`;
  // 目录名判据：`/nvm/` 这样带分隔符匹配，`D:\nvm-tools\node.exe` 那种不算
  const markers = ['/nvm/', '/nvm4w/', '/.nvm/', '/fnm/', '/.fnm/', '/volta/', '/.volta/'];
  if (markers.some((marker) => full.includes(marker))) return true;
  for (const name of ['NVM_HOME', 'NVM_SYMLINK', 'NVM_DIR', 'FNM_DIR', 'VOLTA_HOME']) {
    const value = envValueOf(env, name);
    if (!value) continue;
    const root = String(value).trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
    if (root && full.startsWith(`${root.startsWith('/') ? root : `/${root}`}/`)) return true;
  }
  return false;
}

/**
 * 「这一轮没测」那句统一措辞（`skipped === true` 的项都写它）。
 *
 * 为什么必须区分"没测"与"没装"：启动瞬间的快速探测（见 `collectBootProbe`）只查文件系统、
 * 不起子进程，所以 `node -v` / `npm -v` / `dsh --version` 这些项根本没有结论。
 * 把它当成 `missing` 就会把一台好好的机器判成"环境不全"（需求 §4.3 的 warn 不当成缺失）。
 */
const SKIPPED_DETAIL =
  '这一轮没测：启动瞬间的快速探测只读文件系统、不起子进程，所以没有这一项的实测结果（不代表没装）';

/**
 * 这次失败是"**这个运行环境**不允许起子进程"（我们测不出来），还是"**那个程序本身**跑不起来"（不可用）？
 *
 * 两者在界面上必须是两种结论，这是 VM 实测（VM-03）那条判据的地基：
 *   - `EPERM` / `EACCES`：沙箱或权限限制，用户机器上那份程序可能好好的 → `warn`（不挡人）；
 *   - 其余（跑起来了但零输出、或退出码非 0）：**有输出才算可用** → `missing`（真的用不了）。
 */
export function isEnvironmentBlocked(error: string | null): boolean {
  return Boolean(error && /EPERM|EACCES|不允许|沙箱/i.test(error));
}

/**
 * 八项判定 → 报告。**纯函数**：只读入参（自检里有一条正则守着它不碰 IO）。
 *
 * 几条定死的规则：
 *   - 版本不在区间里给 `warn` 而不是 `missing`：那句区间是**构建期**要求，
 *     dsh 到底能不能跑由 `dsh-run` 那一项实测决定（AGENTS 7.4），
 *     否则界面上会出现"版本红灯 + 实测绿灯"这种自相矛盾的两行；
 *   - `dsh`（在哪）与 `dsh-run`（跑不跑得动）分开判：dsh 在跑不动的 Node 上是静默退出，
 *     这两件事合在一起用户就不知道该修哪一个；
 *   - 不满足必有出路：`status !== 'ok'` 的每一项 `fixHint` 一定非空。
 */
export function judgeEnvironment(raw: EnvProbeRaw): EnvDoctorReport {
  const checks: EnvCheck[] = [];
  const push = (
    id: EnvCheckId,
    status: EnvCheckStatus,
    detail: string,
    fixHint: string | null = null,
    fixAction: EnvFixAction | null = null,
  ): void => {
    checks.push({ id, status, detail, fixHint, fixAction });
  };

  const npmPath = raw.npm.path;
  const dshHint =
    '在「设置 → 启动方式 → dsh 命令」里写一条能跑的启动命令，或一键 `npm i -g @deepseek-ai/dsh`。';

  // 1. 外部 Node = **真正会被用来跑 dsh 的那一份**（用户裁决，见 §7.25）。
  //    另有一份（通用搜索找到的、跟它不是同一个）时把话说出来 —— 用户拿终端里的
  //    `node -v` 对账对不上，就是因为它。
  if (raw.node.path) {
    const other = raw.otherNode;
    const tail = other
      ? `；另有一个外部 Node：${other.path}${other.version ? `（${other.version}）` : ''}${
          other.shim
            ? '，那是个转发器，我们没去调它（调它会自己去下运行时；它的版本随启动环境而变，所以别拿它跟终端里的 `node -v` 对账）'
            : ''
        }`
      : '';
    push(
      'node',
      'ok',
      `找到了外部 Node：${raw.node.path}${raw.node.version ? `（${raw.node.version}）` : ''}` +
        (raw.nodeServesDsh ? ' —— dsh 就用这一份跑' : '') +
        tail,
    );
  } else {
    push(
      'node',
      'missing',
      '没找到外部 Node（常见安装位置里都没有）',
      installNodeHint(raw.platform),
    );
  }

  // 2. Node 版本：判据 = 本机这一份 dsh 说的（离线读它的安装树）+ 兜底那句常量，两句都要满足
  const nodeVersion = raw.node.version ? parseNodeVersion(raw.node.version) : null;
  const verdict = nodeVersion ? judgeNodeVersion(nodeVersion, raw.localDsh) : null;
  if (raw.node.skipped) {
    // 快速探测没跑 `node --version`：给 warn（测不出来），不是 missing（没装）
    push('node-version', 'warn', SKIPPED_DETAIL, NOT_MEASURED_HINT);
  } else if (!raw.node.path) {
    push(
      'node-version',
      'missing',
      '外部 Node 都没找到，版本无从判断',
      installNodeHint(raw.platform),
    );
  } else if (!nodeVersion) {
    // 找到了 Node 的文件、但它跑不出结果 —— **有输出才算可用**（与 `canRunDsh` 同一条判据）。
    // 只有"这个环境不允许起子进程"才留黄灯（那是我们测不出来，不是用户没装）。
    if (raw.node.timedOut) {
      // **在忙 ≠ 缺东西**：转发器可能在准备自己的运行时（真机事故，见 §7.25）。
      push(
        'node-version',
        'warn',
        '没能实测版本：它超过 8 秒没有回应（第一次运行时它可能在准备自己的运行时）—— 不代表没装 Node',
        '过一会儿点上面的「重新检测」再看一次。',
      );
    } else if (isEnvironmentBlocked(raw.node.error)) {
      push(
        'node-version',
        'warn',
        '没能实测版本：这个运行环境不允许起子进程 —— 不代表没装 Node',
        `${BLOCKED_HINT_PREFIX}只有在你自己有权限的终端里手工跑一次 \`node --version\` 才能确认。`,
      );
    } else if (raw.nodeFromVersionManager) {
      // VM-13 / F-05：客机状态正是"版本管理器在、零版本"，而这一行就显示在两条一键安装路的并列位置 ——
      // 绝不能说"你先去终端里选一个版本"。
      push(
        'node-version',
        'missing',
        `版本管理器已经装好了：这份 Node（${raw.node.path}）就在它管的目录里，但它还没有装任何 Node 版本（或者没有选中一个），所以这个 node.exe 现在跑起来没有任何输出`,
        nodeInstallHint(raw.platform),
      );
    } else {
      push(
        'node-version',
        'missing',
        `找到了 Node（${raw.node.path}），但它跑起来没有任何输出（退出码 ${raw.node.exitCode ?? 0}）—— 这份 Node 现在用不了`,
        nodeInstallHint(raw.platform),
      );
    }
  } else if (verdict?.status === 'ok') {
    // 有本机证据时点名"是谁说的"（用户裁决：不是所有人装的是同一份 dsh，所以结论要能核对）；
    // 没有时保持原样 —— 兜底那句常量的文案不动，变化面越小越好。
    push(
      'node-version',
      'ok',
      verdict.local
        ? `${raw.node.version} 满足${requirementPhrase(verdict.local)}`
        : `${raw.node.version} 落在要求区间内（要求 ${NODE_RANGE}）`,
    );
  } else {
    push(
      'node-version',
      'warn',
      nodeMismatchText(raw.node.version ?? '', verdict),
      upgradeNodeHint(raw.platform),
    );
  }

  // 3. npm（下面两个一键修复都要它）
  if (raw.npm.skipped) {
    push('npm', 'warn', SKIPPED_DETAIL, NOT_MEASURED_HINT);
  } else if (!npmPath) {
    push(
      'npm',
      'missing',
      '没找到 npm —— 两个一键修复（装 pnpm / 装 dsh）都要用它，先把它修好',
      '重装官方 Node（npm 随它一起装）；只用 pnpm 的话也可以 `corepack enable pnpm`。',
    );
  } else if (raw.npm.version) {
    push('npm', 'ok', `npm 可用：${npmPath}（${raw.npm.version}）`);
  } else if (raw.npm.timedOut) {
    push(
      'npm',
      'warn',
      '没能实测 npm：它超过 8 秒没有回应（第一次运行时它可能在准备自己的运行时）—— 不代表没装 npm',
      '过一会儿点上面的「重新检测」再看一次。',
    );
  } else if (isEnvironmentBlocked(raw.npm.error)) {
    push(
      'npm',
      'warn',
      '没能实测 npm：这个运行环境不允许起子进程 —— 不代表没装 npm',
      `${BLOCKED_HINT_PREFIX}只有在你自己有权限的终端里手工跑一次 \`npm -v\` 才能确认。`,
    );
  } else {
    push(
      'npm',
      'missing',
      `找到了 npm（${npmPath}），但它跑起来没有任何输出 —— 这份 npm 现在用不了，两个一键修复（装 pnpm / 装 dsh）也就都用不了`,
      `重装官方 Node（npm 随它一起装）就能修好；装完它会出现在上面那一行的位置，不用你手动改什么。`,
    );
  }

  // 4. pnpm：插件页的装/卸/升级全靠它（dsh plugin 内部是裸 spawnSync('pnpm')）
  if (raw.pnpm.skipped) {
    push('pnpm', 'warn', SKIPPED_DETAIL, NOT_MEASURED_HINT);
  } else if (!raw.pnpm.path) {
    push(
      'pnpm',
      'missing',
      '没找到 pnpm —— 插件页的装 / 卸 / 升级都用不了',
      npmPath
        ? // 缺 VC++ 运行库时这句要说清"装的是哪一档"，别让用户以为回到了最新版
          `一键装一个（${npmPath} i -g ${pnpmInstallSpec(raw.vcRuntime !== false)}）；不行再试 \`corepack enable pnpm\`。`
        : '没有 npm，只能用 `corepack enable pnpm`（或先重装官方 Node）。',
      npmPath ? 'install-pnpm' : null,
    );
  } else if (raw.pnpm.version) {
    push('pnpm', 'ok', `pnpm 可用：${raw.pnpm.path}（${raw.pnpm.version}）`);
  } else if (raw.pnpm.timedOut) {
    push(
      'pnpm',
      'warn',
      '没能实测 pnpm：它超过 8 秒没有回应（第一次运行时它可能在准备自己的运行时）—— 不代表没装 pnpm',
      '过一会儿点上面的「重新检测」再看一次。',
    );
  } else if (isEnvironmentBlocked(raw.pnpm.error)) {
    push(
      'pnpm',
      'warn',
      '没能实测 pnpm：这个运行环境不允许起子进程 —— 不代表没装 pnpm',
      `${BLOCKED_HINT_PREFIX}只有在你自己有权限的终端里手工跑一次 \`pnpm -v\` 才能确认。`,
    );
  } else {
    push(
      'pnpm',
      'missing',
      `找到了 pnpm（${raw.pnpm.path}），但它跑起来没有任何输出 —— 这份 pnpm 现在用不了`,
      `点下面的按钮重装一个（由我们执行，装完自动复检）；不行再试 \`corepack enable pnpm\`。`,
      npmPath ? 'install-pnpm' : null,
    );
  }

  // 5. dsh 本体：能不能定位（与第 6 项"跑不跑得动"分开）
  const dshAction: EnvFixAction | null = npmPath ? 'install-dsh' : null;
  if (raw.dsh.skipped) {
    push('dsh', 'warn', SKIPPED_DETAIL, NOT_MEASURED_HINT);
  } else if (raw.dsh.kind === 'npx') {
    push(
      'dsh',
      'warn',
      'dsh 现在要靠临时下载来运行：每次启动都要联网解析、必要时现装一份，慢且可能失败',
      '用 `npm i -g @deepseek-ai/dsh` 全局装一份，以后启动就不必联网解析了。',
      dshAction,
    );
  } else if (raw.dsh.kind) {
    push('dsh', 'ok', `找到了可用的 dsh：${raw.dsh.display ?? ''}`);
  } else {
    // **不要**把上游那句原始报错贴进界面：它写的是"PATH 里没有 dsh.cmd / 也没有 npx"这类
    // 内部术语（冻结 §3.8 #22 明令禁止出现在界面上）。技术原文留在探测事实里
    // （`EnvProbeRaw.dsh.resolveError`），界面上只说人话。
    push(
      'dsh',
      'missing',
      '这台电脑上还没有可用的 dsh：既没有现成装好的，也没法用 npm 现取一份来跑',
      dshHint,
      dshAction,
    );
  }

  // 6. 实测能不能跑：**有输出才算能跑**（退出码 0 + 零输出 = 静默退出）
  if (raw.dsh.skipped) {
    push('dsh-run', 'warn', SKIPPED_DETAIL, NOT_MEASURED_HINT);
  } else if (!raw.dsh.kind) {
    push('dsh-run', 'warn', 'dsh 本体还没定位到，没法实测能不能跑', dshHint);
  } else if (raw.dsh.runs) {
    push(
      'dsh-run',
      'ok',
      raw.dsh.version
        ? `实测能跑：${raw.dsh.display ?? raw.dsh.kind} → ${raw.dsh.version}`
        : `实测能跑：${raw.dsh.display ?? raw.dsh.kind}（这条解释器组合已实测确认）`,
    );
  } else if (raw.dsh.error && /EPERM|EACCES|不允许|沙箱/i.test(raw.dsh.error)) {
    push(
      'dsh-run',
      'warn',
      '没能实测：这个运行环境不允许起子进程（不代表 dsh 不能用）',
      `${BLOCKED_HINT_PREFIX}只有在你自己有权限的终端里手工跑一次 \`dsh --version\` 才能确认。`,
    );
  } else if (raw.dsh.timedOut) {
    push(
      'dsh-run',
      'warn',
      '没能实测：它超过 8 秒没有回应（第一次运行时它可能在准备自己的运行时）—— 不代表 dsh 不能用',
      '过一会儿点上面的「重新检测」再看一次；一直这样就在「设置 → 启动方式 → dsh 命令」里换一条能跑的启动命令。',
    );
  } else if (raw.dsh.exitCode === null || raw.dsh.exitCode === 0) {
    push(
      'dsh-run',
      'missing',
      `dsh 跑起来但没有任何输出（退出码 ${raw.dsh.exitCode ?? 0}）—— dsh 在跑不动的 Node 上就是这样静默退出的：退出码 0、零输出`,
      dshHint,
    );
  } else {
    push(
      'dsh-run',
      'missing',
      `实测失败：退出码 ${raw.dsh.exitCode} —— 这一份 dsh 现在跑不起来（dsh 的原始输出在下方输出区里）`,
      dshHint,
    );
  }

  // 7. 应用自带运行时：与快照的 env.versions 同源，用同一句区间判
  const bundledVersion = parseNodeVersion(raw.bundled.node);
  const bundledDetail = (extra: string): string =>
    `Electron ${raw.bundled.electron || '?'}，内置 Node ${raw.bundled.node || '?'}${extra}`;
  if (!raw.packaged) {
    push(
      'bundled-runtime',
      'ok',
      `${bundledDetail('（开发态）')} —— 开发态这份运行时来自 electron 依赖，应用跑在你的系统 Node 上`,
    );
  } else if (bundledVersion && satisfiesBuildRange(bundledVersion)) {
    push('bundled-runtime', 'ok', bundledDetail(`，落在要求区间内（要求 ${NODE_RANGE_BUILD}）`));
  } else {
    push(
      'bundled-runtime',
      'missing',
      bundledDetail(
        `，不在要求区间内（要求 ${NODE_RANGE_BUILD}）—— 注意这不是你机器上的 Node，它由打包时用的 Electron 决定`,
      ),
      `升级 DSH Console：${RELEASES_URL}`,
    );
  }

  // 8. 本地 Shell
  if (!raw.shell.file) {
    push(
      'shell',
      'missing',
      '没能解析出本地 Shell（设置里没填，也找不到系统默认的）',
      '在「设置 → 本地 Shell」里填一个可执行文件的路径。',
    );
  } else if (raw.shell.exists) {
    push('shell', 'ok', `本地 Shell：${raw.shell.file}`);
  } else {
    push(
      'shell',
      'missing',
      `设置里指定的本地 Shell 不存在了：${raw.shell.file}`,
      '到「设置 → 本地 Shell」清空这一项（恢复自动选择）或改成正确的路径。',
    );
  }

  // 收口：保证"每一行都有 detail、每一行非 ok 都有出路"这两条不变量
  for (const item of checks) {
    if (!item.detail) item.detail = '（这一项没有拿到可判断的信息）';
    if (item.status !== 'ok' && !item.fixHint) item.fixHint = FALLBACK_HINTS[item.id];
  }

  const counts = { ok: 0, warn: 0, missing: 0 };
  for (const item of checks) counts[item.status] += 1;
  const firstProblemId =
    (
      checks.find((item) => item.status === 'missing') ??
      checks.find((item) => item.status === 'warn')
    )?.id ?? null;

  const plans: EnvFixPlan[] = [];
  // 缺 VC++ 运行库时一键装的是纯 JS 那条线（VM-09）；没探测过（`undefined`）按"有"处理
  const vcRuntime = raw.vcRuntime !== false;
  for (const action of ['install-pnpm', 'install-dsh'] as const) {
    const plan = envFixPlan(action, npmPath, vcRuntime);
    if (plan) plans.push(plan);
  }

  return {
    checkedAt: raw.checkedAt,
    checks,
    counts,
    firstProblemId,
    nodeRange: NODE_RANGE,
    plans,
    // 归属：采集侧给的**事实**，这里只搬运（判定仍然是纯函数：`detectNodeOwner` 在采集侧算好）
    nodeOwner: raw.nodeOwner ?? 'unknown',
    nodeOwnerEvidence: arrayOf<string>(raw.nodeOwnerEvidence),
    error: raw.error,
  };
}

/**
 * 「被界面撤下去的原始错误」→ 日志行（**纯函数**，自检直接喂夹具）。
 *
 * 界面上只说人话，原始错误因此必须有另一个落点 —— 这就是 `EnvDoctorHooks.log` 存在的理由，
 * 而这个函数决定"该记哪些"。判据是成对的：**日志里找得到原文，界面文案里找不到**。
 *
 * 只在"这一项因为跑出错而没通过"（`status !== 'ok'`）时记，不给一台正常的机器刷日志；
 * `skipped` 的项这一轮**根本没起子进程**（`collectBootProbe` 那条快速路径），没有任何原文可记。
 */
export function probeTroubleLines(raw: EnvProbeRaw, report: EnvDoctorReport): string[] {
  const lines: string[] = [];
  const checks = arrayOf<EnvCheck>(report.checks);
  const statusOf = (id: EnvCheckId): EnvCheckStatus =>
    checks.find((item) => item.id === id)?.status ?? 'ok';
  const notPassed = (...ids: EnvCheckId[]): boolean => ids.some((id) => statusOf(id) !== 'ok');
  /** stderr 是原文的一部分（"为什么跑不起来"往往只在这里），有就接在后面 */
  const withStderr = (line: string, stderr: string | null | undefined): string =>
    stderr ? `${line}；stderr：${stderr}` : line;

  /** 三个版本探测项：`node` / `node-version` 是同一份事实判出来的两行，一起看 */
  const versionFact = (label: string, probe: VersionProbe, ids: EnvCheckId[]): void => {
    if (probe.skipped || !notPassed(...ids)) return;
    if (probe.error) {
      lines.push(withStderr(`${label} 起不来：${probe.error}`, probe.stderr));
    } else if (probe.path && !probe.version) {
      lines.push(
        withStderr(
          `${label} 跑起来但没有任何输出：退出码 ${probe.exitCode ?? 0}，路径 ${probe.path}`,
          probe.stderr,
        ),
      );
    }
  };
  versionFact('node --version', raw.node, ['node', 'node-version']);
  versionFact('npm -v', raw.npm, ['npm']);
  versionFact('pnpm -v', raw.pnpm, ['pnpm']);

  if (!raw.dsh.skipped) {
    if (raw.dsh.resolveError && notPassed('dsh', 'dsh-run')) {
      lines.push(`dsh 没能定位：${raw.dsh.resolveError}`);
    }
    if (raw.dsh.kind && !raw.dsh.runs && notPassed('dsh-run')) {
      const reason = raw.dsh.error ? `起不来：${raw.dsh.error}` : `退出码 ${raw.dsh.exitCode ?? 0}`;
      lines.push(
        withStderr(
          `dsh 实测没通过（${reason}）：启动命令 ${raw.dsh.display ?? raw.dsh.kind}`,
          raw.dsh.stderr,
        ),
      );
    }
  }

  // 采集本身有意外（读设置失败等）：报告里已经有 error，日志里带上原因
  if (raw.error) lines.push(`这一轮探测本身有意外：${raw.error}`);
  return [...new Set(lines)];
}
