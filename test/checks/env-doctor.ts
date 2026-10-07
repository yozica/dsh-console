'use strict';

/**
 * 自检第 16 组与 VM-09：运行环境自检（判定 + 探测 + 一键修复）与门禁的前置事实。
 *
 * 这一页的价值是「把机器的现状说清楚」，所以最怕两件事：判定里混进 IO（只能在真机上验）、
 * 以及"不满足却没给出路"。下面全部是纯函数夹具 + 静态文本检查：不装 pnpm、不起任何进程。
 * 夹具与两个源码文本由 `test/env-fixtures.ts` 统一提供 —— 后面的环境向导 / 安装引擎组
 * 也在用同一份，所以不能留在这里自己读。
 *
 * 整段从 `test/selftest.ts` 的 `main()` 里搬出来，行为一字未改 —— 搬完的证据是自检输出
 * 逐行一致（314 条同名、同值、同顺序）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as envDoctor from '../../src/main/env-doctor';
import * as npmRegistry from '../../src/main/npm-registry';
import * as pluginManager from '../../src/main/plugin-manager';
import * as processUtils from '../../src/main/process-utils';
import { DEFAULTS } from '../../src/main/settings';
import * as envDetail from '../../src/renderer/pages/env/env-detail.js';
import * as restartAsk from '../../src/renderer/pages/env/restart-ask.js';
import * as versionPick from '../../src/renderer/pages/env/version-pick.js';

import { createEnvFixtures } from '../env-fixtures';
import { check, skip, IS_WINDOWS } from '../harness';
import type { Repo } from '../repo';
import { blockOf, functionBodyOf, stripComments, stripStrings } from '../text';

export function runEnvDoctor(repo: Repo): void {
  const f = createEnvFixtures(repo);
  const repoRoot = repo.root;
  const cssBlock = repo.cssBlock;
  const srcDir = repo.srcDir;
  const sandbox = repo.sandbox;
  const flatIpc = repo.flatIpc;
  const ipcSource = repo.ipcSource;
  const {
    envSource,
    envCode,
    envJudgeBody,
    envMainCode,
    envPaneCode,
    envVersionProbe,
    envDshProbe,
    envProbe,
    envCheckOf,
    envAllOk,
    envIds,
    envNoNode,
    envNoNodeReport,
  } = f;

  // ---------------------------------------------------------- 16. 运行环境自检
  //    这一页的价值是「把机器的现状说清楚」，所以最怕两件事：判定里混进 IO（只能在真机上验）、
  //    以及"不满足却没给出路"。下面全部是纯函数夹具 + 静态文本检查：不装 pnpm、不起任何进程。
  const envJudgeCode = stripStrings(envJudgeBody);
  check(
    '环境自检：judgeEnvironment 是纯函数（代码里没有 fs / 子进程 / process.* / 时钟）',
    envJudgeCode.length > 200 &&
      !/\bfs\./.test(envJudgeCode) &&
      !/\bspawn|\bexecFile|\bexecSync|\bspawnSync/.test(envJudgeCode) &&
      !/process\.env|process\.platform|process\.versions/.test(envJudgeCode) &&
      !/Date\.now|\bnew Date\b/.test(envJudgeCode),
    `${envJudgeCode.length} 字符`,
  );

  check(
    '环境自检：八项都在、id 不重复、顺序固定',
    envAllOk.checks.length === 8 &&
      new Set(envAllOk.checks.map((item) => item.id)).size === 8 &&
      envAllOk.checks.every((item, index) => item.id === envIds[index]) &&
      envAllOk.counts.ok === 8 &&
      envAllOk.counts.warn === 0 &&
      envAllOk.counts.missing === 0 &&
      envAllOk.firstProblemId === null &&
      envAllOk.plans.length === 2 &&
      envAllOk.nodeRange === envDoctor.NODE_RANGE,
  );

  // 边界值（dsh 那句 `^22.19.0 || >=24.0.0`）：20.19 与 22.12 都不算 —— 这正是 2026-09-20
  // 发现的那个偏差（原来抄的是 vite 的构建期那句，会把跑不动 dsh 的 Node 判成"符合要求"）。
  const envBounds: [string, boolean][] = [
    ['v20.19.0', false],
    ['v22.11.9', false],
    ['v22.12.0', false],
    ['v22.18.9', false],
    ['v22.19.0', true],
    ['v23.0.0', false],
    ['v24.0.0', true],
    ['v24.19.0', true],
  ];
  // 构建期那句（vite 的 engines）另有边界，只给「应用自带运行时」用
  const envBuildBounds: [string, boolean][] = [
    ['v20.18.0', false],
    ['v20.19.0', true],
    ['v22.12.0', true],
    ['v21.0.0', false],
  ];
  check(
    '环境自检：两个区间各判各的（dsh 的 22.19 / 24 与构建期的 20.19 / 22.12 都对）',
    envBounds.every(([text, expected]) => {
      const version = envDoctor.parseNodeVersion(text);
      return version !== null && envDoctor.satisfiesNodeRange(version) === expected;
    }) &&
      envBuildBounds.every(([text, expected]) => {
        const version = envDoctor.parseNodeVersion(text);
        return version !== null && envDoctor.satisfiesBuildRange(version) === expected;
      }) &&
      envDoctor.parseNodeVersion('不是版本号') === null,
    `${envDoctor.NODE_RANGE} / 构建期 ${envDoctor.NODE_RANGE_BUILD}`,
  );
  check(
    '环境自检：dsh 那句区间与上游仓库根一致，且与构建期那句确实是两个值',
    // 上游：https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json
    // （engines.node）。发布出去的包 manifest 里没有它，所以只能钉这一句字面量。
    // 两句"不同"用 Set 判：两个常量都是字面量类型，直接写 `!==` 会被 TS 判成必然成立（TS2367）。
    envDoctor.NODE_RANGE === '^22.19.0 || >=24.0.0' &&
      envDoctor.NODE_RANGE_BUILD === '^20.19.0 || >=22.12.0' &&
      new Set<string>([envDoctor.NODE_RANGE, envDoctor.NODE_RANGE_BUILD]).size === 2,
    `${envDoctor.NODE_RANGE} / ${envDoctor.NODE_RANGE_BUILD}`,
  );
  const envViteEngines = (
    JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'node_modules', 'vite', 'package.json'), 'utf8'),
    ) as { engines: { node: string } }
  ).engines.node;
  check(
    '环境自检：构建期那句与 vite 的 engines 同一句（升级 vite 时它不会悄悄过期）',
    envViteEngines === envDoctor.NODE_RANGE_BUILD,
    `vite: ${envViteEngines}`,
  );

  // 本机那份 dsh 对 Node 的要求（用户裁决：不是所有人装的是同一份 dsh，别只信抄来的常量）
  const envLocalFixture: envDoctor.LocalDshRequirement = {
    version: '0.1.5-rc.1',
    root: '/x/node_modules/@deepseek-ai/dsh',
    declared: null,
    required: { range: '>=22.19.0', name: 'undici', version: '8.10.2', count: 3 },
    scanned: 524,
  };
  check(
    '环境自检：通用的区间判据是唯一的实现（两句老常量与它逐档一致；认不出来给 null）',
    (() => {
      const sweep: envDoctor.NodeVersion[] = [];
      for (let major = 18; major <= 26; major += 1) {
        for (const minor of [0, 11, 12, 18, 19, 20, 99]) {
          sweep.push({ major, minor, patch: 0 });
        }
      }
      return (
        sweep.every(
          (version) =>
            envDoctor.satisfiesNodeRange(version) ===
            (envDoctor.satisfiesSimpleRange(version, envDoctor.NODE_RANGE) === true),
        ) &&
        sweep.every(
          (version) =>
            envDoctor.satisfiesBuildRange(version) ===
            (envDoctor.satisfiesSimpleRange(version, envDoctor.NODE_RANGE_BUILD) === true),
        ) &&
        envDoctor.satisfiesSimpleRange({ major: 24, minor: 0, patch: 0 }, '不是区间') === null
      );
    })(),
    `${envDoctor.NODE_RANGE} ／ ${envDoctor.NODE_RANGE_BUILD}：18–26 九档 × 7 个小版本`,
  );
  check(
    '环境自检：「Node 版本」= 本机那份 dsh 说的 + 兜底那句，两句都要满足（23 靠兜底那句挡住）',
    (() => {
      const at = (text: string): envDoctor.NodeVersion =>
        envDoctor.parseNodeVersion(text) as envDoctor.NodeVersion;
      const ok = envDoctor.judgeNodeVersion(at('v24.19.0'), envLocalFixture);
      const belowLocal = envDoctor.judgeNodeVersion(at('v22.17.1'), envLocalFixture);
      // 依赖链那句 `>=22.19.0` 数学上包含奇数版 23，而 23 这条线没有 dsh 入口要的那个 Node API
      const odd23 = envDoctor.judgeNodeVersion(at('v23.0.0'), envLocalFixture);
      const stricter = envDoctor.judgeNodeVersion(at('v24.19.0'), {
        ...envLocalFixture,
        required: { range: '>=26.0.0', name: 'undici', version: '9.0.0', count: 1 },
      });
      const alone = envDoctor.judgeNodeVersion(at('v20.9.0'), undefined);
      return (
        ok.status === 'ok' &&
        ok.failedBy === null &&
        belowLocal.status === 'warn' &&
        belowLocal.failedBy === 'local' &&
        odd23.status === 'warn' &&
        odd23.failedBy === 'upstream' &&
        stricter.status === 'warn' &&
        stricter.failedBy === 'local' &&
        alone.status === 'warn' &&
        alone.failedBy === 'upstream' &&
        alone.local === null
      );
    })(),
  );
  check(
    '环境自检：本机那句的优先序与文案（依赖链 > 它自己声明的；点名"来自哪个依赖、几个包也在要"）',
    envDoctor.localNodeRange(envLocalFixture)?.source === 'local' &&
      envDoctor.requirementPhrase(envDoctor.localNodeRange(envLocalFixture)!) ===
        '本机这份 dsh 的要求 >=22.19.0（来自依赖 undici 8.10.2 等 3 个包）' &&
      envDoctor.localNodeRange({
        ...envLocalFixture,
        required: null,
        declared: '^22.19.0 || >=24.0.0',
      })?.source === 'declared' &&
      envDoctor.localNodeRange({ ...envLocalFixture, required: null, declared: null }) === null &&
      envDoctor.localNodeRange(undefined) === null,
  );
  check(
    '环境自检：从本机安装树读得出"这一份 dsh 要哪个 Node"（版本 / 声明的 engines / 依赖链最高的下限）',
    (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-'));
      try {
        const root = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
        const write = (relative: string, body: unknown): void => {
          const file = path.join(root, relative);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(body));
        };
        const pkg = (name: string, version: string, node: string): unknown => ({
          name,
          version,
          engines: { node },
        });
        write('package.json', {
          name: '@deepseek-ai/dsh',
          version: '9.9.9',
          engines: { node: '^22.19.0 || >=24.0.0' },
        });
        write('lib/bin.js', '');
        write('node_modules/undici/package.json', pkg('undici', '8.10.2', '>=22.19.0'));
        write('node_modules/pi/package.json', pkg('pi', '0.1.0', '>=22.19.0'));
        write('node_modules/old/package.json', pkg('old', '1.0.0', '>=18'));
        write('node_modules/junk/package.json', pkg('junk', '1.0.0', '乱写'));
        const launcher = (file: string, prefixArgs: string[]): processUtils.DshLauncher => ({
          file,
          prefixArgs,
          viaCmd: false,
          display: 'x',
          kind: prefixArgs.length > 0 ? 'node-bin' : 'shim',
        });
        // 入口脚本那条路（node-bin / "自定义命令 + bin.js" 都走它）
        const byEntry = envDoctor.readLocalDshRequirement(
          launcher(path.join(dir, 'bin', 'node'), [path.join(root, 'lib', 'bin.js')]),
        );
        // shim 那条路：跟着符号链接找真入口（npm 装的 shim 就是软链）
        const shim = path.join(dir, 'bin', 'dsh');
        fs.mkdirSync(path.dirname(shim), { recursive: true });
        fs.symlinkSync(path.join(root, 'lib', 'bin.js'), shim);
        const byShim = envDoctor.readLocalDshRequirement(launcher(shim, []));
        // 名字对不上就不是我们要的那份（同名的别的包不算）
        const impostor = envDoctor.readLocalDshRequirement(
          launcher(path.join(dir, 'bin', 'node'), [
            path.join(dir, 'node_modules', 'not-dsh', 'lib', 'bin.js'),
          ]),
        );
        return (
          byEntry?.version === '9.9.9' &&
          byEntry.declared === '^22.19.0 || >=24.0.0' &&
          // 下限最高的是 3 个：undici 与 pi 的 `>=22.19.0`，加上 dsh 自己声明的
          // `^22.19.0 || >=24.0.0`（下界也是 22.19.0）。同档时按名字排序取第一个 → pi
          byEntry.required?.range === '>=22.19.0' &&
          byEntry.required.name === 'pi' &&
          byEntry.required.count === 3 &&
          byEntry.scanned === 4 &&
          byShim?.required?.range === '>=22.19.0' &&
          impostor === null
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })(),
  );
  check(
    '环境自检页：长路径的折行落在路径分隔符上（说明切段 + 片段之间插 <wbr>）',
    (() => {
      const cases: [string, string[]][] = [
        [
          '/Users/x/node_modules/@deepseek-ai/dsh/lib/bin.js',
          ['/', 'Users/', 'x/', 'node_modules/', '@deepseek-ai/', 'dsh/', 'lib/', 'bin.js'],
        ],
        ['C:\\Users\\x\\dsh\\lib\\bin.js', ['C:\\', 'Users\\', 'x\\', 'dsh\\', 'lib\\', 'bin.js']],
        ['本地 Shell：/bin/zsh', ['本地 Shell：/', 'bin/', 'zsh']],
        ['没有分隔符', ['没有分隔符']],
        ['', ['']],
      ];
      // 模板里那句注释本身就写着"不用 v-html"，所以查之前先把注释剥掉（§7.13 的老规矩）
      const template = fs
        .readFileSync(repo.vuePath('EnvPane.vue'), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '');
      return (
        cases.every(
          ([input, expected]) =>
            JSON.stringify(envDetail.detailSegments(input)) === JSON.stringify(expected) &&
            // 往返必须一字不差：<wbr> 是元素不是字符，复制出来的文本不能变
            envDetail.detailSegments(input).join('') === input,
        ) &&
        // 接线：模板里真的用它切段、片段之间插 <wbr>、片段本身包在 `.env-seg` 里
        // （不包的话 `@deepseek-ai` 里那个连字符自己就是一个断点，窄窗口下又会切在它上面）；
        // **不许** v-html —— 那段文字里有用户机器上的真实路径
        /detailSegments\(check\.detail\)/.test(template) &&
        /<wbr v-if="index > 0" \/><span class="env-seg">/.test(template) &&
        /white-space:\s*nowrap/.test(cssBlock('.env-seg')) &&
        !/v-html/.test(template)
      );
    })(),
    `切段示例：${envDetail.detailSegments('/a/b/c').join('|')}`,
  );
  check(
    '环境自检页：圆点与内容永远左右并排（.env-main 的 flex 基宽是 0，不是内容宽度）',
    (() => {
      const main = cssBlock('.env-main');
      // 基宽 auto = 内容自己的宽度：说明一长（那几行是两条长路径拼的）就被 flex-wrap 挪到
      // 圆点下面。真机四个宽度实测：auto 时被挤下去 1 / 3 / 4 / 5 / 7 行，基宽 0 时全是 0。
      return (
        /flex:\s*1 1 0;/.test(main) &&
        /min-width:\s*0;/.test(main) &&
        // 换行能力得留给「整行铺开」的那两块（否则它们会跟正文抢同一行）
        /flex-wrap:\s*wrap;/.test(cssBlock('.env-row')) &&
        /flex:\s*1 1 100%;/.test(cssBlock('.env-confirm')) &&
        /flex:\s*1 1 100%;/.test(cssBlock('.env-owner-note'))
      );
    })(),
    cssBlock('.env-main').replace(/\s+/g, ' ').trim().slice(0, 70),
  );
  check(
    '环境自检：完整探测才读安装树（快速探测不起子进程、也不解析启动命令，读不到）',
    (() => {
      // t51 起要读整份（barrel + 六个叶子），`collectEnvProbe` 在 env-probe.ts 里
      const source = envSource;
      const full = source.slice(
        source.indexOf('export async function collectEnvProbe'),
        source.indexOf('function emptyProbe('),
      );
      const boot = source.slice(
        source.indexOf('export function collectBootProbe'),
        source.indexOf('export function judgeWizard'),
      );
      return (
        /readLocalDshRequirement\(/.test(full) &&
        /localDsh,/.test(full) &&
        !/readLocalDshRequirement\(/.test(boot) &&
        !/localDsh/.test(boot)
      );
    })(),
  );

  // 每一份"有毛病"的夹具：非 ok 的行必须有 fixHint、所有行的 detail 非空
  const envBadFixtures: envDoctor.EnvProbeRaw[] = [
    envNoNode,
    envProbe({ node: envVersionProbe({ version: 'v20.9.0' }) }),
    envProbe({
      node: envVersionProbe({ version: null, exitCode: null, error: 'spawnSync EPERM' }),
    }),
    envProbe({ npm: envVersionProbe({ path: null, version: null, exitCode: null }) }),
    envProbe({ npm: envVersionProbe({ version: null, exitCode: null }) }),
    envProbe({ pnpm: envVersionProbe({ path: null, version: null, exitCode: null }) }),
    envProbe({ pnpm: envVersionProbe({ version: null, exitCode: null }) }),
    envProbe({
      dsh: envDshProbe({ kind: null, display: null, runs: false, resolveError: '找不到 dsh' }),
    }),
    envProbe({ dsh: envDshProbe({ kind: 'npx' }) }),
    envProbe({ dsh: envDshProbe({ runs: false, version: null, exitCode: null }) }),
    envProbe({
      dsh: envDshProbe({
        kind: 'shim',
        runs: false,
        version: null,
        exitCode: null,
        error: 'EPERM',
      }),
    }),
    envProbe({ bundled: { electron: '30.0.0', node: '20.9.0', chrome: '124.0.0' } }),
    envProbe({ shell: { file: '/bin/zsh', exists: false } }),
    envProbe({ shell: { file: null, exists: false } }),
  ];
  check(
    '环境自检：不满足必有出路（每项非 ok 都有 fixHint，detail 都不为空）',
    envBadFixtures.every((raw) =>
      envDoctor
        .judgeEnvironment(raw)
        .checks.every(
          (item) =>
            item.detail.length > 0 &&
            (item.status === 'ok' || Boolean(item.fixHint && item.fixHint.length > 0)),
        ),
    ),
    `${envBadFixtures.length} 份夹具`,
  );

  const envNoDsh = envDoctor.judgeEnvironment(
    envProbe({
      dsh: envDshProbe({ kind: null, display: null, runs: false, resolveError: '找不到 dsh' }),
    }),
  );
  const envDeadDsh = envDoctor.judgeEnvironment(
    envProbe({
      dsh: envDshProbe({ kind: 'node-bin', runs: false, version: null, exitCode: null }),
    }),
  );
  check(
    '环境自检：找不到 dsh 与跑不动 dsh 分开判',
    envCheckOf(envNoDsh, 'dsh').status === 'missing' &&
      envCheckOf(envDeadDsh, 'dsh').status === 'ok' &&
      envCheckOf(envDeadDsh, 'dsh-run').status === 'missing' &&
      /静默退出/.test(envCheckOf(envDeadDsh, 'dsh-run').detail),
  );
  const envNpx = envDoctor.judgeEnvironment(envProbe({ dsh: envDshProbe({ kind: 'npx' }) }));
  check(
    '环境自检：dsh 靠"临时下载"运行时只给黄灯（能用，但每次启动都要联网解析）',
    // VM-04 之后这条 detail 不再写那个内部术语，但"为什么要修"这条信息必须在（联网/慢）
    envCheckOf(envNpx, 'dsh').status === 'warn' &&
      Boolean(envCheckOf(envNpx, 'dsh').fixHint) &&
      /联网/.test(envCheckOf(envNpx, 'dsh').detail),
  );
  const envNoPnpm = envDoctor.judgeEnvironment(
    envProbe({ pnpm: envVersionProbe({ path: null, version: null, exitCode: null }) }),
  );
  const envNoNpm = envDoctor.judgeEnvironment(
    envProbe({
      npm: envVersionProbe({ path: null, version: null, exitCode: null }),
      pnpm: envVersionProbe({ path: null, version: null, exitCode: null }),
    }),
  );
  check(
    '环境自检：pnpm 缺失时给出 install-pnpm；npm 也缺失时不给按钮',
    envCheckOf(envNoPnpm, 'pnpm').fixAction === 'install-pnpm' &&
      envNoPnpm.plans.length === 2 &&
      envCheckOf(envNoNpm, 'npm').status === 'missing' &&
      envCheckOf(envNoNpm, 'pnpm').fixAction === null &&
      envNoNpm.plans.length === 0,
  );
  const envEperm = envDoctor.judgeEnvironment(
    envProbe({
      node: envVersionProbe({
        path: '/usr/bin/node',
        version: null,
        exitCode: null,
        error: 'spawnSync EPERM',
      }),
      dsh: envDshProbe({
        kind: 'shim',
        runs: false,
        version: null,
        exitCode: null,
        error: 'spawnSync dsh EPERM',
      }),
    }),
  );
  check(
    '环境自检：起不了子进程（EPERM）是黄灯，不当成没装',
    envCheckOf(envEperm, 'node').status === 'ok' &&
      envCheckOf(envEperm, 'node-version').status === 'warn' &&
      envCheckOf(envEperm, 'dsh-run').status === 'warn',
  );

  // 2026-09-20 真机事故：探测打到 vite-plus 的转发器，它在窄 PATH 下开始下载自己的运行时，
  // 8 秒超时被杀 —— 而判定把"超过 8 秒没回应"当成了"退出码 0 + 零输出"那个静默退出签名，
  // 于是引导用户去重装一个**好端端的** dsh。这两条钉住：超时归"测不出来"，且说法对得上。
  const envTimedOut = envDoctor.judgeEnvironment(
    envProbe({
      node: envVersionProbe({
        version: null,
        exitCode: null,
        error: '超过 8 秒没有回应（已经结束它）',
        timedOut: true,
      }),
      npm: envVersionProbe({
        path: '/opt/homebrew/bin/npm',
        version: null,
        exitCode: null,
        error: '超过 8 秒没有回应（已经结束它）',
        timedOut: true,
      }),
      pnpm: envVersionProbe({
        path: '/opt/homebrew/bin/pnpm',
        version: null,
        exitCode: null,
        error: '超过 8 秒没有回应（已经结束它）',
        timedOut: true,
      }),
      dsh: envDshProbe({
        kind: 'shim',
        runs: false,
        version: null,
        exitCode: null,
        error: '超过 8 秒没有回应（已经结束它）',
        timedOut: true,
      }),
    }),
  );
  check(
    '环境自检：探测超时是黄灯（"它在忙"），不冒充"退出码 0 + 零输出"的静默退出',
    envCheckOf(envTimedOut, 'node-version').status === 'warn' &&
      envCheckOf(envTimedOut, 'npm').status === 'warn' &&
      envCheckOf(envTimedOut, 'pnpm').status === 'warn' &&
      envCheckOf(envTimedOut, 'dsh-run').status === 'warn' &&
      /没有回应/.test(envCheckOf(envTimedOut, 'dsh-run').detail) &&
      !/静默退出/.test(envCheckOf(envTimedOut, 'dsh-run').detail) &&
      // 判定本身不许自己去看计时 / 看时钟（超时是**采集侧**的事实，判定只搬运）
      /timedOut/.test(envJudgeCode),
  );
  check(
    '环境自检：node 那一行报"dsh 要用的那份"，并报出被跳过的转发器（不执行它）',
    (() => {
      const withOther = envDoctor.judgeEnvironment(
        envProbe({
          otherNode: { path: '/Users/x/.vite-plus/bin/node', version: null, shim: true },
          nodeServesDsh: true,
        }),
      );
      const plain = envDoctor.judgeEnvironment(envProbe());
      const detail = envCheckOf(withOther, 'node').detail;
      return (
        /dsh 就用这一份跑/.test(detail) &&
        /转发器/.test(detail) &&
        /\.vite-plus\/bin\/node/.test(detail) &&
        // 没有"另有一份"时不许画蛇添足
        !/另有一个外部 Node/.test(envCheckOf(plain, 'node').detail)
      );
    })(),
  );
  check(
    '环境自检：认得出"转发器"（最终目标不是 node），真实 node 的符号链接不算',
    (() => {
      // 真实文件系统：homebrew 那种 `node -> ../Cellar/node/x/bin/node` 必须算真 node，
      // 而 vite-plus 那种 `node -> ../current/bin/vp` 必须算转发器 —— 判据只能看**最终目标的名字**。
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shim-'));
      try {
        fs.mkdirSync(path.join(dir, 'real'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'proxy'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'real', 'node'), '#!/bin/sh\necho v24\n');
        fs.chmodSync(path.join(dir, 'real', 'node'), 0o755);
        fs.writeFileSync(path.join(dir, 'proxy', 'vp'), '#!/bin/sh\necho vp\n');
        fs.chmodSync(path.join(dir, 'proxy', 'vp'), 0o755);
        // 真 node 的符号链接：最终目标是 .../real/node
        fs.symlinkSync(path.join(dir, 'real', 'node'), path.join(dir, 'bin', 'node-good'));
        // 转发器：最终目标是 .../proxy/vp
        fs.symlinkSync(path.join(dir, 'proxy', 'vp'), path.join(dir, 'bin', 'node-shim'));
        return (
          processUtils.isNodeShim(path.join(dir, 'bin', 'node-good')) === false &&
          processUtils.isNodeShim(path.join(dir, 'bin', 'node-shim')) === true &&
          processUtils.isNodeShim(path.join(dir, 'real', 'node')) === false &&
          // 读不到就别乱扣帽子
          processUtils.isNodeShim(path.join(dir, 'does-not-exist')) === false
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })(),
  );
  check(
    '命令解析：PATH 上的转发器不算"找到真 node"（真 node 优先，一个都没有才退它）',
    (() => {
      const source = repo.processUtilsSource;
      return (
        /const pathShim = fromPath !== null && isNodeShim\(fromPath\) \? fromPath : null;/.test(
          source,
        ) &&
        // PATH 上是真 node 就直接用；是转发器就往下走候选表
        /if \(fromPath && !pathShim\) return fromPath;/.test(source) &&
        // 两趟扫描之后才轮到它 —— 这是 2026-09-20 那个缺口的落点：
        // .zshrc 里 `. "$HOME/.vite-plus/env"` 把转发器塞在 PATH 最前面，直接 return 就等于
        // 把转发器当成系统 Node（它报的版本还随启动环境变，见 §7.25）
        /return pathShim;/.test(source) &&
        /if \(isExecutableFile\(candidate\) && !isNodeShim\(candidate\)\) return candidate;/.test(
          source,
        )
      );
    })(),
  );
  check(
    '环境自检：探测不再走同步子进程（runVersion 里没有 spawnSync），四项并发跑',
    !/spawnSync/.test(stripStrings(functionBodyOf(envSource, 'runVersion'))) &&
      // 四项**并发**发出：`Promise.all` 的数组一求值就 spawn（现在是"先发出去、再趁它们跑的时候
      // 扫本机 dsh 的安装树、最后 await"）—— 盯的还是"一个 Promise.all 里四个探测"，不是串行
      /Promise\.all\(\[\s*probeBinary\(nodeForRow[\s\S]*?probeBinary\(npmPath[\s\S]*?probeBinary\(pnpmPath[\s\S]*?collectDshProbe\(/.test(
        envCode,
      ) &&
      /const \[node, npm, pnpm, dsh\] = await probes;/.test(envCode) &&
      // 超时要真的把子进程树收掉（只 kill 壳会留下孤儿的管道，实测进程退不出来）
      /killTreeSync\(pid\)/.test(envCode) &&
      /stdout\?\.destroy\(\)/.test(envCode),
  );
  const envOldBundled = envDoctor.judgeEnvironment(
    envProbe({ bundled: { electron: '30.0.0', node: '20.9.0', chrome: '124.0.0' } }),
  );
  const envDevBundled = envDoctor.judgeEnvironment(
    envProbe({
      packaged: false,
      bundled: { electron: '30.0.0', node: '20.9.0', chrome: '124.0.0' },
    }),
  );
  check(
    '环境自检：内嵌 Node 用同一句区间判；开发态说明不同（这不是你机器上的 Node）',
    envCheckOf(envOldBundled, 'bundled-runtime').status === 'missing' &&
      /不是你机器上的 Node/.test(envCheckOf(envOldBundled, 'bundled-runtime').detail) &&
      envCheckOf(envDevBundled, 'bundled-runtime').status === 'ok' &&
      /开发态/.test(envCheckOf(envDevBundled, 'bundled-runtime').detail),
  );
  const envWarnOnly = envDoctor.judgeEnvironment(
    envProbe({ node: envVersionProbe({ path: '/usr/bin/node', version: 'v20.9.0' }) }),
  );
  check(
    '环境自检：counts 与 firstProblemId 的算法（missing 优先于 warn，同级按顺序）',
    envAllOk.firstProblemId === null &&
      envAllOk.counts.ok === 8 &&
      envNoNodeReport.firstProblemId === 'node' &&
      envNoNodeReport.counts.ok + envNoNodeReport.counts.warn + envNoNodeReport.counts.missing ===
        8 &&
      envNoNodeReport.counts.missing === 2 &&
      envWarnOnly.counts.missing === 0 &&
      envWarnOnly.firstProblemId === 'node-version',
  );

  // Windows 上的可执行性：解析侧只认带扩展名的，执行侧经 cmd.exe + windowsVerbatimArguments。
  // 本机实测（Windows 11 / Node 24.19.0）：`D:\Node\nodejs\npm` 首行是 `#!/usr/bin/env bash`，
  // spawn 它 ENOENT；同目录的 npm.cmd 直 spawn 是 EINVAL（Node ≥ 20.12 禁止不带 shell 起 .cmd）；
  // 走 cmd.exe 但不声明 verbatim 时 cmd 报 `'\"…npm.cmd\"' is not recognized`。
  // 三条都是"看起来只是 argv 文本差别、实际完全跑不起来"的坑，所以这里钉的是 spec 本身。
  const envWinSpec = envDoctor.npmLaunchSpec(
    'C:\\Program Files\\nodejs\\npm.cmd',
    ['i', '-g', 'pnpm'],
    'win32',
  );
  const envWinExeSpec = envDoctor.npmLaunchSpec(
    'C:\\Program Files\\nodejs\\npm.exe',
    ['i', '-g', 'pnpm'],
    'win32',
  );
  const envWinCmdSpec = processUtils.launchSpec(
    processUtils.COMSPEC,
    ['/d', '/s', '/c', '"D:\\Node\\nodejs\\dsh.cmd"', '--version'],
    'win32',
  );
  const envMacSpec = envDoctor.npmLaunchSpec('/usr/local/bin/npm', ['i', '-g', 'pnpm'], 'darwin');
  check(
    '环境自检：Windows 上的启动 spec 真的起得来（.cmd → cmd.exe + verbatim，PE 直连）',
    envWinSpec.file === processUtils.COMSPEC &&
      processUtils.isRunnablePath(envWinSpec.file, 'win32') &&
      envWinSpec.args[2] === '/c' &&
      // 整条命令拼成一个参数再套一层引号（/s 会剥掉最外层那对）
      envWinSpec.args[3] === '""C:\\Program Files\\nodejs\\npm.cmd" i -g pnpm"' &&
      envWinSpec.windowsVerbatimArguments === true &&
      // 已经是 cmd.exe 的调用（dsh shim / npx 那条路）也要收口成同样的形状
      envWinCmdSpec.file === processUtils.COMSPEC &&
      envWinCmdSpec.args[3] === '""D:\\Node\\nodejs\\dsh.cmd" --version"' &&
      envWinCmdSpec.windowsVerbatimArguments === true &&
      // .exe 是 PE，可以直接 spawn，不必套 cmd 这一层
      envWinExeSpec.file === 'C:\\Program Files\\nodejs\\npm.exe' &&
      envWinExeSpec.args.join(' ') === 'i -g pnpm' &&
      envWinExeSpec.windowsVerbatimArguments === false &&
      envMacSpec.file === '/usr/local/bin/npm' &&
      envMacSpec.args.join(' ') === 'i -g pnpm' &&
      envMacSpec.windowsVerbatimArguments === false,
  );
  /** 读一个可执行文件的首行（用来判它是不是 `#!` 脚本） */
  const headOf = (file: string): string => {
    try {
      return fs.readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] ?? '';
    } catch {
      return '';
    }
  };
  const envResolved: (string | null)[] = [
    envDoctor.findNpm(),
    envDoctor.findPnpmPath(),
    // 插件层用的是 process-utils 的 findPnpm()（同一个 whichSync）—— 它也必须是能执行的那个
    processUtils.findPnpm(),
    envDoctor.findNodePath(),
  ];
  check(
    '环境自检：解析出的 npm / pnpm / node 一定是能执行的那个（不许拿 POSIX sh shim 充数）',
    // 纯函数部分：无扩展名不是可执行文件，带扩展名才是；POSIX 上不看扩展名
    !processUtils.isRunnablePath('D:\\Node\\nodejs\\npm', 'win32') &&
      processUtils.isRunnablePath('D:\\Node\\nodejs\\npm.cmd', 'win32') &&
      processUtils.isRunnablePath('D:\\Node\\nodejs\\pnpm.exe', 'win32') &&
      processUtils.isRunnablePath('/opt/homebrew/bin/npm', 'darwin') &&
      // 本机实测部分（Windows 上真的去解析）：结果要么没有，要么带可执行扩展名**且首行不是 `#!`**
      // ⚠️ 「首行是 `#!` 的 sh shim 不算可执行」**只对 Windows 成立**：POSIX 上 `#!` 脚本本来就是合法的可执行文件，
      // 而 Linux 上的 pnpm 恰恰就是 `#!/bin/sh`（corepack shim）。少了 `!IS_WINDOWS ||` 这个守卫时，
      // 这条断言在 CI（ubuntu-latest）上必红、在 Windows 上永远绿 —— 已经踩过一次。
      envResolved.every(
        (found) =>
          found === null ||
          (processUtils.isRunnablePath(found, process.platform) &&
            (!IS_WINDOWS || !headOf(found).startsWith('#!'))),
      ),
    `npm=${envResolved[0]} pnpm(env)=${envResolved[1]} pnpm(plugin)=${envResolved[2]} node=${envResolved[3]}`,
  );
  // 「PATHEXT 优先于裸名」只能实测：造一个目录，同时放无扩展名的 sh shim 与同名 .cmd，
  // 把 PATH 临时指过去（whichSync 每次调用都读 process.env.PATH），看它挑哪个。
  const whichDir = path.join(sandbox, 'which-fixtures');
  fs.mkdirSync(whichDir, { recursive: true });
  const shimPath = path.join(whichDir, 'dshprobe');
  const cmdPath = path.join(whichDir, 'dshprobe.cmd');
  const probeWhich = (): { picked: string | null; bareOnly: string | null } => {
    fs.writeFileSync(shimPath, '#!/usr/bin/env bash\necho not-executable\n');
    fs.writeFileSync(cmdPath, '@echo off\r\n');
    const pathBefore = process.env.PATH;
    try {
      process.env.PATH = whichDir;
      const picked = processUtils.whichSync('dshprobe');
      fs.rmSync(cmdPath);
      return { picked, bareOnly: processUtils.whichSync('dshprobe') };
    } finally {
      process.env.PATH = pathBefore;
    }
  };
  if (!IS_WINDOWS) {
    skip(
      '环境自检：PATHEXT 优先于裸名，首行 `#!` 的无扩展名 shim 不算可执行文件',
      'POSIX 上裸名本来就是对的（不看扩展名）',
    );
  } else {
    const { picked, bareOnly } = probeWhich();
    check(
      '环境自检：PATHEXT 优先于裸名，首行 `#!` 的无扩展名 shim 不算可执行文件',
      picked === cmdPath && bareOnly === null,
      `两者并存 → ${picked}；只剩 sh shim → ${bareOnly}`,
    );
  }
  check(
    '环境自检：探测与修复走同一个包装器（不是直 spawn .cmd / 无扩展名路径，且都带 verbatim）',
    /function runVersion\([\s\S]{0,160}?const spec = launchSpec\(/.test(envCode) &&
      // 探测**不再走同步子进程**（真机事故：spawnSync × 5 把主进程卡了约 40 秒，见 §7.25）
      !/function runVersion\([\s\S]{0,1400}?spawnSync\(/.test(envCode) &&
      /function runVersion\([\s\S]{0,1400}?spawn\(spec\.file, spec\.args,/.test(envCode) &&
      /function readNpmPrefix\(npmPath: string, platform: string\)[\s\S]{0,200}?npmLaunchSpec\(/.test(
        envCode,
      ) &&
      // 三处 spawn 都要把 verbatim 传下去：runVersion / readNpmPrefix / 修复执行
      (envCode.match(/windowsVerbatimArguments: spec\.windowsVerbatimArguments/g) ?? []).length ===
        3 &&
      /spawn\(spec\.file, spec\.args,/.test(envCode) &&
      /whichWindowsExe\('npm'/.test(envCode) &&
      /whichWindowsExe\('pnpm'/.test(envCode) &&
      /whichWindowsExe\('node'/.test(envCode),
  );
  const envRunBody = stripComments(blockOf(envSource, 'async run(action: EnvFixAction, version'));
  const envRunnerBody = stripComments(
    blockOf(envSource, 'private async execute(action: EnvFixAction, version'),
  );
  // 锚点跟着签名走：`publish` 的入参是 `EnvFixDraft`（= **不含** `finishedAt` 的状态 ——
  // 那个"跑完的时刻"由 `publish()` 自己派生，只此一处，见 t85）。签名再改名时这条会红，
  // 那是提醒：这条断言钉的是"终态释放互斥位"那一句，别让它悄悄切到空串上（切不到就等于没断言）。
  const envPublishBody = stripComments(blockOf(envSource, 'private publish(state: EnvFixDraft)'));
  check(
    '环境自检：超时是独立终态（有自己那句话，且判在「退出码 != 0」之前）',
    envDoctor.fixTimeoutMessage() === '超过 5 分钟没跑完，已自动中断（npm 可能已经写了一部分）' &&
      envDoctor.fixTimeoutMessage(90_000).startsWith('超过 2 分钟没跑完，已自动中断') &&
      envRunnerBody.indexOf('if (this.timedOut)') > 0 &&
      envRunnerBody.indexOf('if (this.timedOut)') <
        envRunnerBody.indexOf('if (outcome.code !== 0)') &&
      /const message = fixTimeoutMessage\(\)/.test(envRunnerBody),
  );
  check(
    '环境自检：单动作互斥是同步置位（在第一个 await 之前，终态释放）',
    envRunBody.indexOf('this.running = true;') > 0 &&
      envRunBody.indexOf('this.running = true;') < envRunBody.indexOf('await ') &&
      /get busy\(\): boolean \{[\s\S]{0,120}?this\.running \|\|/.test(stripComments(envSource)) &&
      /if \(state\.phase !== 'running'\) this\.running = false;/.test(envPublishBody),
  );
  check(
    '环境自检：修复计划只认 npm 存在时的两个动作',
    envDoctor.envFixPlan('install-pnpm', null) === null &&
      envDoctor.envFixPlan('install-dsh', '/usr/bin/npm')?.args.join(' ') ===
        'i -g @deepseek-ai/dsh' &&
      // pnpm 那条多了 install-scripts 的一次性开关（VM-06），argv 的其余部分一字不变
      envDoctor.envFixPlan('install-pnpm', '/usr/bin/npm')?.args.join(' ') ===
        `i -g pnpm ${envDoctor.ALLOW_INSTALL_SCRIPTS_FLAG}` &&
      envDoctor.envFixPlan('install-pnpm', '/usr/bin/npm')?.display ===
        `/usr/bin/npm i -g pnpm ${envDoctor.ALLOW_INSTALL_SCRIPTS_FLAG}`,
  );
  check(
    '环境自检：失败归纳只认认得出的三类，认不出来返回 null（不编原因）',
    /权限/.test(String(envDoctor.summarizeEnvFixFailure('npm ERR! code EACCES'))) &&
      /网络/.test(String(envDoctor.summarizeEnvFixFailure('npm ERR! code ENOTFOUND'))) &&
      /registry\.example\.com/.test(
        String(
          envDoctor.summarizeEnvFixFailure(
            'npm ERR! 404 Not Found - GET https://registry.example.com/pnpm',
          ),
        ),
      ) &&
      envDoctor.summarizeEnvFixFailure('added 1 package in 2s') === null,
  );

  check(
    '环境自检：契约里有 8 个 id、3 个动作（t81 起多了 update-pnpm）、6 个 API',
    (() => {
      const idUnion = /export type EnvCheckId =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      const actionUnion = /export type EnvFixAction =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      return (
        /export type EnvCheckStatus = 'ok' \| 'warn' \| 'missing';/.test(flatIpc) &&
        idUnion.split('|').filter(Boolean).length === 8 &&
        envIds.every((id) => idUnion.includes(`'${id}'`)) &&
        actionUnion.split('|').filter(Boolean).length === 3 &&
        actionUnion.includes("'install-pnpm'") &&
        actionUnion.includes("'install-dsh'") &&
        actionUnion.includes("'update-pnpm'") &&
        /export interface EnvCheck \{/.test(flatIpc) &&
        /fixAction: EnvFixAction \| null;/.test(flatIpc) &&
        /export interface EnvDoctorReport \{/.test(flatIpc) &&
        /export interface EnvFixState \{/.test(flatIpc) &&
        /envCheck: \(options\?: \{ refresh\?: boolean \}\) => Promise<EnvDoctorReport>;/.test(
          flatIpc,
        ) &&
        /envFix: \(request: \{ action: EnvFixAction; version\?: string \}\) => Promise<EnvFixState>;/.test(
          flatIpc,
        ) &&
        /envFixPlan: \(request: \{ action: EnvFixAction; version\?: string \}\) => Promise<EnvFixPlan \| null>;/.test(
          flatIpc,
        ) &&
        /envFixCancel: \(\) => Promise<boolean>;/.test(flatIpc) &&
        /onEnvFixState: \(handler: \(state: EnvFixState\) => void\) => \(\) => void;/.test(
          flatIpc,
        ) &&
        /onEnvFixOutput: \(handler: \(payload: EnvFixOutputEvent\) => void\) => \(\) => void;/.test(
          flatIpc,
        )
      );
    })(),
  );
  // 加设置项要动两处（契约 + DEFAULTS），两边不一致时 tsc 会报错 —— 但 tsc 报错的前提是
  // 有人真的把键写上。这里把"两处一致"本身钉成一条检查：`SettingsValues` 的键集合必须
  // 与 `DEFAULTS` 的键集合完全相同（少一个 key 是 tsc 报错，多一个键是悄悄漂移）。
  const settingsInterfaceBody =
    /\nexport interface SettingsValues \{([\s\S]*?)\n\}/.exec(ipcSource)?.[1] ?? '';
  const contractSettingKeys = [
    ...settingsInterfaceBody.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\??:/gm),
  ].map((match) => match[1]);
  const defaultSettingKeys = Object.keys(DEFAULTS);
  check(
    '环境自检：契约与 DEFAULTS 两处一致（SettingsValues 的键集合 == DEFAULTS 的键集合）',
    contractSettingKeys.length > 0 &&
      contractSettingKeys.length === new Set(contractSettingKeys).size &&
      defaultSettingKeys.length === contractSettingKeys.length &&
      contractSettingKeys.every((key) => defaultSettingKeys.includes(key)) &&
      defaultSettingKeys.includes('envSkips') &&
      defaultSettingKeys.includes('envNodeSource'),
    `契约 ${contractSettingKeys.length} 项 / DEFAULTS ${defaultSettingKeys.length} 项`,
  );

  check(
    '环境自检：子进程不拼 shell、补过 PATH、输出双向都收、cwd 固定',
    /spawn\(spec\.file, spec\.args/.test(envCode) &&
      /envWithKnownBins\(process\.env\)/.test(envCode) &&
      /pluginRegistryEnv\(/.test(envCode) &&
      /stdio: \['ignore', 'pipe', 'pipe'\]/.test(envCode) &&
      /cwd: homeDir\(\)/.test(envCode) &&
      // 两路**分开**收（VM-06 之后：日志里要分得清是 stdout 还是 stderr 在说话），
      // 然后合成同一份 tail 给归纳器与输出区
      /child\.stdout\?\.on\('data', collectOut\)/.test(envCode) &&
      /child\.stderr\?\.on\('data', collectErr\)/.test(envCode) &&
      /const collectOut = \(chunk: Buffer \| string\): void => \{[\s\S]{0,120}?collect\(chunk\);/.test(
        envCode,
      ) &&
      /const collectErr = \(chunk: Buffer \| string\): void => \{[\s\S]{0,120}?collect\(chunk\);/.test(
        envCode,
      ) &&
      !/shell:\s*true/.test(envCode),
  );
  check(
    '环境自检：渲染层只递 action（+ t81 起允许的、已校验的 version）；argv 仍由主进程现算',
    /const parsed = \(request \?\? \{\}\) as \{ action\?: EnvFixAction; version\?: unknown \};/.test(
      envMainCode,
    ) &&
      /const checked = await resolveFixVersion\(\{ action, version: parsed\.version \}\);/.test(
        envMainCode,
      ) &&
      /envFixRunner\.run\(action, checked\.version\)/.test(envMainCode) &&
      /const plan = await this\.doctor\.fixPlan\(action, version\);/.test(envCode) &&
      /const spec = npmLaunchSpec\(plan\.file, plan\.args, this\.doctor\.platform\);/.test(
        envCode,
      ) &&
      !/request\??\.(file|args)\b/.test(envCode),
  );
  check(
    '环境自检：env-doctor 不 import electron（自检才能直接 import 它，运行时事实靠注入）',
    !/from 'electron'/.test(envCode) &&
      /runtime: \(\) => EnvRuntime/.test(envSource) &&
      !/\bapp\.isPackaged/.test(envCode) &&
      /runtime: envRuntime/.test(envMainCode) &&
      /new EnvDoctor\(settings, \{/.test(envMainCode),
  );

  // 渲染层的两条（设计文档第 6 节建议清单的第 21、22 条）：类型面之外的回归防线。
  // 第 21 条防「映射表写成 Record<string, string>」：那样漏一个 id 也不会 tsc 报错；
  // 第 22 条防「按钮在渲染时就调 envFix」：一键修复必须经过页内确认。
  /** 取一个 `const X: ... = { … };` 对象字面量的花括号内容（映射表这类小对象够用） */
  const objectBodyOf = (source: string, head: string): string =>
    new RegExp(`${head} = \\{([\\s\\S]*?)\\n\\};`).exec(source)?.[1] ?? '';
  /** 切出一个局部函数的花括号体（`functionBodyOf` 认的是 `export function`，.vue 里没有 export） */
  const localBodyOf = (source: string, head: string): string => {
    const start = source.indexOf(head);
    if (start < 0) return '';
    const open = source.indexOf('{', start);
    if (open < 0) return '';
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(open, index + 1);
      }
    }
    return '';
  };
  const envTitlesBody = objectBodyOf(envPaneCode, 'const TITLES: Record<EnvCheckId, string>');
  const envMissingTitles = envIds.filter(
    (id) => !new RegExp(`(?:^|\\s)'?${id}'?:`, 'm').test(envTitlesBody),
  );
  check(
    '环境自检：渲染层的标题映射覆盖全部八个 id（写成 Record<string, string> 就会漏）',
    /const TITLES: Record<EnvCheckId, string> = \{/.test(envPaneCode) &&
      envTitlesBody.length > 0 &&
      envMissingTitles.length === 0 &&
      /TITLES\[check\.id\]/.test(envPaneCode),
    envMissingTitles.length
      ? `映射表缺 ${envMissingTitles.join(', ')}`
      : `${envIds.length}/${envIds.length} 个 id（Record<EnvCheckId, string>）`,
  );
  const envStartFixBody = localBodyOf(envPaneCode, 'function startFix(');
  const envStartConfirmedBody = localBodyOf(envPaneCode, 'function startConfirmed(');
  const envRunFixCalls = envPaneCode.match(/runEnvFix\(/g) ?? [];
  check(
    '环境自检：一键修复只在有 fixAction 时给按钮，且必须经过一次页内确认',
    // 按钮只在有动作（且主进程给了计划）时出现
    /v-if="fixActionOf\(check\)"/.test(envPaneCode) &&
      /check\.fixAction !== null && planFor\(check\.fixAction\)/.test(envPaneCode) &&
      // 确认态：先展开确认区，不是点一下就开跑
      /const confirming = ref<EnvFixAction \| null>\(null\)/.test(envPaneCode) &&
      /@click="openConfirmFor\(check\)"/.test(envPaneCode) &&
      /v-if="confirming && confirming === check\.fixAction && confirmPlan"/.test(envPaneCode) &&
      /confirmPlan\.display/.test(envPaneCode) &&
      // 真正的执行只在「开始」那条路上，而且 runEnvFix 全文件只有一处调用点
      /@click="startConfirmed"/.test(envPaneCode) &&
      /void startFix\(action\)/.test(envStartConfirmedBody) &&
      /await runEnvFix\(action, version\)/.test(envStartFixBody) &&
      envRunFixCalls.length === 1,
    envRunFixCalls.length === 1
      ? '按钮受 fixActionOf 门控；envFix 的唯一调用点在确认后的 startFix'
      : `runEnvFix( 出现 ${envRunFixCalls.length} 处（应恰好 1 处：确认后的 startFix 里）`,
  );

  // ---------------------------------------------------------- 17a. VM-06 / VM-07（t31）
  //    VM-06：一键装 pnpm 装出来是坏的（文件在、跑起来没有任何输出）。
  //      船长在隔离 prefix 下的对照实验推翻了"install-scripts 门禁就是病根"这条推断
  //      （不带开关时 npm 只警告、pnpm 照样能跑），所以这里的判据不是"开关修好了一切"，而是：
  //      开关按 npm 的原文照加（不改用户全局配置），**并且把"文件在但跑不起来"做成可诊断的失败态**。
  //    VM-07：同一次运行内刷新不彻底（装完了还让用户重开应用）。
  check(
    '环境自检（VM-06）：装 pnpm 带一次性 install-scripts 开关，且绝不改用户的全局 npm 配置',
    (() => {
      const plan = envDoctor.envFixPlan('install-pnpm', '/usr/bin/npm');
      const oneOff = envDoctor.ALLOW_INSTALL_SCRIPTS_FLAG;
      if (!plan) return false;
      // 官方原文两次都长这样：`Run \`npm install -g --allow-scripts=pnpm\` …`（一次性），
      // 而"写进全局配置"的那条路（`npm config set … --location=user`）我们一个字都不碰
      const touchesUserConfig = /config set|--location=user|\.npmrc/.test(envCode);
      return (
        oneOff === '--allow-scripts=pnpm' &&
        plan.args.includes(oneOff) &&
        plan.display.endsWith(oneOff) &&
        // 确认区那句话要把"不改你的全局 npm 配置"说给用户，而不是我们自己心里知道
        /不改你的全局 npm 配置/.test(plan.note) &&
        !touchesUserConfig
      );
    })(),
  );
  // ---------------------------------------------------------- 17c. VM-09（t37）
  //    真机现象：纯净 Windows 上 `npm ls -g` 显示 pnpm 装上了，但 `pnpm -v` 无输出，
  //    并弹窗「由于找不到 VCRUNTIME140.dll，无法继续执行代码…」。根因是 pnpm 11 起在 Windows 上
  //    发的是**原生 exe**，而纯净 Windows 没有 VC++ 运行库。所以判定要认这条事实、并换到纯 JS 那条线。
  /** VM-09 的真机原文（弹窗里那句话；进程本身无输出，所以 fixture 把它放在 stderr 上） */
  const VM09_DLL_TEXT =
    '由于找不到 VCRUNTIME140.dll，无法继续执行代码。重新安装程序可能会解决此问题。';
  check(
    '环境自检（VM-09）：缺 VC++ 运行库时装纯 JS 那条线（pnpm@10），有则照旧装最新（缺省也照旧）',
    (() => {
      const npm = '/usr/bin/npm';
      const pure = envDoctor.envFixPlan('install-pnpm', npm, false);
      const latest = envDoctor.envFixPlan('install-pnpm', npm, true);
      const dflt = envDoctor.envFixPlan('install-pnpm', npm);
      const dsh = envDoctor.envFixPlan('install-dsh', npm, false);
      if (!pure || !latest || !dflt || !dsh) return false;
      return (
        envDoctor.PNPM_PURE_JS_SPEC === 'pnpm@10' &&
        envDoctor.PNPM_LATEST_SPEC === 'pnpm' &&
        envDoctor.pnpmInstallSpec(true) === 'pnpm' &&
        envDoctor.pnpmInstallSpec(false) === 'pnpm@10' &&
        // 缺运行库 → 装 10.x（`bin` 是 bin/pnpm.cjs，纯 JS）
        pure.args.join(' ') === `i -g pnpm@10 ${envDoctor.ALLOW_INSTALL_SCRIPTS_FLAG}` &&
        // 有运行库 / 没探测过（第三个参数不传）→ 原样装最新（既有夹具与 case G 都靠这一条）
        latest.args.join(' ') === `i -g pnpm ${envDoctor.ALLOW_INSTALL_SCRIPTS_FLAG}` &&
        dflt.args.join(' ') === `i -g pnpm ${envDoctor.ALLOW_INSTALL_SCRIPTS_FLAG}` &&
        // 用户会问"为什么给我装 10.x" → 确认区那句话必须自己说清
        /VC\+\+/.test(pure.note) &&
        /纯 JS/.test(pure.note) &&
        /pnpm 10/.test(pure.note) &&
        !/VC\+\+/.test(latest.note) &&
        // dsh 不掺和这件事（只影响 pnpm）
        dsh.args.join(' ') === 'i -g @deepseek-ai/dsh'
      );
    })(),
  );
  const vcEnv: NodeJS.ProcessEnv = { SystemRoot: 'D:\\Windows' };
  const vcPaths = processUtils.vcRuntimePaths(vcEnv);
  const vcEvery = processUtils.hasVcRuntime(vcEnv, () => true);
  const vcOneMissing = processUtils.hasVcRuntime(vcEnv, (file) =>
    file.endsWith('vcruntime140.dll'),
  );
  const vcNone = processUtils.hasVcRuntime(vcEnv, () => false);
  check(
    '环境自检（VM-09）：VC++ 运行库只读地认两个 DLL，两支分支都能离线跑出来',
    processUtils.VC_RUNTIME_DLLS.join(',') === 'vcruntime140.dll,msvcp140.dll' &&
      vcPaths.length === 2 &&
      vcPaths[0] === path.win32.join('D:\\Windows', 'System32', 'vcruntime140.dll') &&
      vcPaths[1] === path.win32.join('D:\\Windows', 'System32', 'msvcp140.dll') &&
      // 两个都在才算有（缺一个就不能跑原生 exe）
      vcEvery === true &&
      // ⚠️ 「缺一个 / 一个都没有 → false」**只在 Windows 上成立**：`hasVcRuntime` 在非 Windows 上
      // **恒为 true**（源码里写死的语义：VC++ 运行库这条只对 Windows 有意义，POSIX 的 pnpm 是 JS 入口）。
      vcOneMissing === (IS_WINDOWS ? false : true) &&
      vcNone === (IS_WINDOWS ? false : true) &&
      // `windir` 也认（大小写不敏感）
      processUtils.vcRuntimePaths({ windir: 'C:\\Win' })[0].startsWith('C:\\Win'),
    `paths=${vcPaths.join(' | ')} every=${vcEvery} oneMissing=${vcOneMissing} none=${vcNone} isWindows=${IS_WINDOWS}`,
  );
  // 夹具里的 `dir` 是 **Windows** 路径，所以两边都用 `path.win32.join` 拼（实现内部同理）——
  // 用 `path.join` 的话，在 Linux CI 上夹具与实现会拼出不同的分隔符，这条就假红。
  const pnpmDir = 'C:\\fake\\pnpm-home';
  const pnpmEnv: NodeJS.ProcessEnv = { Path: pnpmDir };
  const pnpmBoth = new Set([
    path.win32.join(pnpmDir, 'pnpm.exe'),
    path.win32.join(pnpmDir, 'pnpm.cmd'),
  ]);
  const pnpmExists = (file: string): boolean => pnpmBoth.has(file);
  const pnpmWithoutRuntime = processUtils.findPnpmWindows(false, pnpmEnv, pnpmExists);
  const pnpmWithRuntime = processUtils.findPnpmWindows(true, pnpmEnv, pnpmExists);
  const pnpmOnlyExe = processUtils.findPnpmWindows(false, pnpmEnv, (file) =>
    file.endsWith('pnpm.exe'),
  );
  check(
    '环境自检（VM-09）：查找 pnpm 用同一套偏好 —— 缺运行库时选能跑的 `pnpm.cmd`（哪怕同目录里有坏的原生 exe）',
    processUtils.pnpmExeNames(true).join(',') === 'pnpm.exe,pnpm.cmd' &&
      processUtils.pnpmExeNames(false).join(',') === 'pnpm.cmd,pnpm.exe' &&
      pnpmWithoutRuntime === path.win32.join(pnpmDir, 'pnpm.cmd') &&
      pnpmWithRuntime === path.win32.join(pnpmDir, 'pnpm.exe') &&
      // 只有原生 exe 时（缺运行库）也得把它找出来 —— 如实报告"找到了但跑不起来"，而不是假装没装
      pnpmOnlyExe === path.win32.join(pnpmDir, 'pnpm.exe'),
    `without=${pnpmWithoutRuntime} with=${pnpmWithRuntime} onlyExe=${pnpmOnlyExe}`,
  );
  check(
    '环境自检（VM-09）：「找到了但跑不起来」认得出真机那两种信号，并给出人话 + 两条出路',
    (() => {
      const file = 'C:\\Users\\tester\\AppData\\Local\\Software\\nvm\\nodejs\\pnpm.exe';
      // ① 真机形状：那次执行**没有任何输出**，而且这台机器缺运行库（弹窗不在 stdout/stderr 上）
      const silent = envDoctor.describePnpmRunFailure({
        file,
        exitCode: null,
        stdout: '',
        stderr: '',
        vcRuntime: false,
      });
      // ② 原文出现在输出里（真机弹窗那句话被抄进 fixture）
      const spoken = envDoctor.describePnpmRunFailure({
        file,
        exitCode: 1,
        stdout: '',
        stderr: VM09_DLL_TEXT,
        vcRuntime: true,
      });
      // ③ 加载失败的退出码（STATUS_DLL_NOT_FOUND = 0xC0000135）
      const codeOnly = envDoctor.describePnpmRunFailure({
        file,
        exitCode: 3221225781,
        stdout: '',
        stderr: '',
        vcRuntime: null,
      });
      // ④ 认不出来就不硬编原因（有输出、退出码正常、运行库也在）
      const unknown = envDoctor.describePnpmRunFailure({
        file,
        exitCode: 0,
        stdout: 'something went wrong',
        stderr: '',
        vcRuntime: true,
      });
      const hints = silent?.hints ?? [];
      return (
        silent?.kind === 'vc-runtime-missing' &&
        /坏的/.test(silent.message) &&
        // 两条出路：换成纯 JS 那条线 / 装上 VC++ 运行库
        hints.length === 2 &&
        hints[0].includes('pnpm 10') &&
        /不需要这个运行库/.test(hints[0]) &&
        hints[1].includes('Visual C++') &&
        spoken?.kind === 'vc-runtime-missing' &&
        codeOnly?.kind === 'vc-runtime-missing' &&
        unknown === null
      );
    })(),
  );
  check(
    '环境自检（VM-09）：那条结论进界面文案（人话 + 出路 + 日志位置），且仍然不说「重开应用」',
    (() => {
      const verdict = envDoctor.describePnpmRunFailure({
        file: 'C:\\nvm\\nodejs\\pnpm.exe',
        exitCode: 3221225781,
        stdout: '',
        stderr: VM09_DLL_TEXT,
        vcRuntime: false,
      });
      const withVerdict = envDoctor.fixDoneMessage({
        label: 'pnpm',
        ok: false,
        found: true,
        blocked: false,
        refreshed: 2,
        logFile: 'C:\\Users\\x\\AppData\\Roaming\\dsh-console\\logs\\console.log',
        verdict,
      });
      const withoutVerdict = envDoctor.fixDoneMessage({
        label: 'pnpm',
        ok: false,
        found: true,
        blocked: false,
        refreshed: 2,
        logFile: null,
      });
      return (
        Boolean(verdict) &&
        /Visual C\+\+/.test(withVerdict) &&
        /pnpm 10/.test(withVerdict) &&
        /logs/.test(withVerdict) &&
        !/重开应用/.test(withVerdict) &&
        // 认不出来时退回原来那句"装出来是坏的"（不编原因）
        /坏的/.test(withoutVerdict)
      );
    })(),
  );
  // t47：装插件用的那份 pnpm 必须和这份 profile 记的大版本一致。
  // 真机踩过：PATH 里先命中 nvm 里的 corepack shim（pnpm 9 / store v3），而 profile 是
  // pnpm 10（store v10）装的 —— pnpm 直接拒绝动手，用户拿到一段看不懂的话。
  const profileModulesYaml = [
    'hoistPattern:',
    'packageManager: pnpm@10.15.0',
    'storeDir: /Users/someone/Library/pnpm/store/v10',
    'virtualStoreDir: .pnpm',
  ].join('\n');
  check(
    '插件安装：从 profile 的 .modules.yaml 读出"这份依赖是哪个大版本的 pnpm 装的"（纯函数）',
    processUtils.parseProfilePnpmMajor(profileModulesYaml) === '10' &&
      processUtils.parseProfilePnpmMajor('packageManager: pnpm@9.6.0\n') === '9' &&
      // 没有这一行 / 空文本 → null（这时只能沿用老规矩：PATH 优先那份）
      processUtils.parseProfilePnpmMajor('virtualStoreDir: .pnpm\n') === null &&
      processUtils.parseProfilePnpmMajor('') === null &&
      // 只认 packageManager 这一行，别把 storeDir 里的数字当版本
      processUtils.parseProfilePnpmMajor('storeDir: /x/store/v10\n') === null,
  );
  check(
    '插件安装：store 大版本不一致时给人话（不再是 pnpm 那段原文）',
    (() => {
      // 真机原文（用户截图里那段，截取关键几行）
      const real = [
        'The dependencies at "/Users/me/.dsh/profiles/web/node_modules" are currently linked from the store at',
        '"/Users/me/Library/pnpm/store/v10".',
        'pnpm now wants to use the store at "/Users/me/Library/pnpm/store/v3" to link dependencies.',
        '(This error may happen if the node_modules was installed with a different major version of pnpm)',
      ].join('\n');
      const hint = pluginManager.summarizePluginFailure(real, 'dshmarket', {
        used: '9.6.0',
        expectedMajor: '10',
      });
      return (
        typeof hint === 'string' &&
        /pnpm 10/.test(hint) &&
        /pnpm 9\.6\.0/.test(hint) &&
        /store/.test(hint) &&
        // 没有上下文时也得认出来（只是说不出具体版本）
        typeof pluginManager.summarizePluginFailure(real) === 'string'
      );
    })(),
  );
  check(
    '插件安装：装之前按 profile 挑 pnpm，并把选中的那份顶到子进程 PATH 最前',
    (() => {
      // t54 起 plugin-manager.ts 是 barrel，装插件的子进程在 plugin-runner.ts 里 → 读整份
      const pluginSource = repo.pluginSource;
      const utils = repo.processUtilsSource;
      const body = pluginSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      return (
        /const pick = findPnpmForProfile\(pluginProfileDir\(\)\);/.test(body) &&
        // 选中的那份要排在最前（dsh 在 profile 目录里裸 spawnSync('pnpm')，只认 PATH）
        /env\[key\] = \[\s*dir,/.test(body) &&
        /!pick\.matched && pick\.expectedMajor/.test(body) &&
        // 既有那道"根本没 pnpm"的闸不许被顺手删掉
        /if \(findPnpm\(\) === null\)/.test(body) &&
        // 判定本身是纯的：解析只看 packageManager 那一行
        /export function parseProfilePnpmMajor\(text: string\): string \| null/.test(utils) &&
        /export function findPnpmForProfile\(profileDir: string\): PnpmPick/.test(utils)
      );
    })(),
  );
  check(
    '环境自检（VM-09）：这条判据是共享的（findPnpm 与插件路径同一份偏好），且 process-utils 既有导出签名一个没改',
    (() => {
      const utils = repo.processUtilsSource;
      // 既有签名（阶段一的规矩：只许新增或内部调整）
      const kept: RegExp[] = [
        /export function findNodeExe\(\): string \| null/,
        /export function findPnpm\(\): string \| null/,
        /export function whichSync\(name: string\): string \| null/,
        /export function windowsBinCandidates\(env: NodeJS\.ProcessEnv, home: string\): string\[\]/,
        /export function pathWithKnownBins\(base: string \| undefined\): string/,
        /export function envWithKnownBins\(base: NodeJS\.ProcessEnv\): NodeJS\.ProcessEnv/,
        /export function launchSpec\(file: string, args: string\[\], platform: string\): LaunchSpec/,
      ];
      return (
        kept.every((pattern) => pattern.test(utils)) &&
        // findPnpm 与插件路径共用同一份偏好（插件那边调的就是 findPnpm）
        /if \(isWindows\) return findPnpmWindows\(hasVcRuntime\(\)\);/.test(utils) &&
        /export function findPnpmWindows\(/.test(utils) &&
        // 判定侧读的是同一条事实（探到的 vcRuntime 决定装哪一档）
        /vcRuntime: hasVcRuntime\(\)/.test(envCode) &&
        /const vcRuntime = raw\.vcRuntime !== false;/.test(envCode) &&
        // 方案 A 把"用哪份 npm"换成了三元（dsh 用绑定那份、pnpm 不变），但这一条的意图不变：
        // 一键修复的计划**现场**用当前探测到的 vcRuntime 重算，不吃报告里的旧值
        /const plan = envFixPlan\(action, npmPath, hasVcRuntime\(\), \{ version \}\);/.test(
          envCode,
        ) &&
        // 认出来的结论会进日志（出路也一并记下来）
        /describePnpmRunFailure\(\{/.test(envCode) &&
        /出路：\$\{verdict\.hints\.join/.test(envCode)
      );
    })(),
  );
  const REG_QUERY_USER = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    NVM_HOME    REG_EXPAND_SZ    D:\\Nvm\\nvm',
    '    NVM_SYMLINK    REG_EXPAND_SZ    D:\\Node\\nodejs',
    '    Path    REG_EXPAND_SZ    C:\\Tools\\bin;%NVM_HOME%;%NVM_SYMLINK%;',
    '',
  ].join('\r\n');
  const REG_QUERY_MACHINE = [
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    '    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe',
    '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;D:\\Git\\Git\\cmd',
    '    PATHEXT    REG_SZ    .COM;.EXE;.BAT;.CMD',
  ].join('\r\n');
  check(
    '环境自检（VM-07）：注册表原文解析得出来，`%VAR%` 引用会展开（不展开的 PATH 等于没刷新）',
    (() => {
      const userVars = envDoctor.parseRegQueryVars(REG_QUERY_USER);
      const machineVars = envDoctor.parseRegQueryVars(REG_QUERY_MACHINE);
      const vars = { ...machineVars, ...userVars, SystemRoot: 'C:\\Windows' };
      const expanded = envDoctor.expandEnvRefs(userVars.Path, vars);
      return (
        userVars.NVM_HOME === 'D:\\Nvm\\nvm' &&
        userVars.NVM_SYMLINK === 'D:\\Node\\nodejs' &&
        // 表头 / 空行不算变量
        Object.keys(machineVars).length === 3 &&
        expanded.includes('D:\\Nvm\\nvm') &&
        expanded.includes('D:\\Node\\nodejs') &&
        !expanded.includes('%NVM_') &&
        // 认不出来的引用原样留着，不许变成空字符串（那会让整个 PATH 少一段）
        envDoctor.expandEnvRefs('%NOT_SET_ANYWHERE%', vars) === '%NOT_SET_ANYWHERE%'
      );
    })(),
  );
  check(
    '环境自检（VM-07）：路径合并去重保序；刷新把新目录真的写进本进程的 PATH（Windows 键名保持原样）',
    (() => {
      const sep = path.delimiter;
      const env: NodeJS.ProcessEnv = { Path: '' };
      const added = envDoctor.refreshLookupPath([srcDir], env);
      const afterFirst = String(env.Path ?? '');
      const addedAgain = envDoctor.refreshLookupPath([srcDir], env);
      const pathKeys = Object.keys(env).filter((name) => name.toLowerCase() === 'path');
      return (
        envDoctor.mergePathText(`a${sep}b`, null, `b${sep}c`, '') === `a${sep}b${sep}c` &&
        // 新目录进 PATH，而且**键名还是 `Path`**（再造一个 `PATH` 就会出现两个只差大小写的键）
        pathKeys.length === 1 &&
        pathKeys[0] === 'Path' &&
        added.includes(srcDir) &&
        afterFirst.split(sep).includes(srcDir) &&
        // 幂等：第二次不再把同一个目录报成"新注入"

        !addedAgain.includes(srcDir)
      );
    })(),
  );
  check(
    '环境自检（VM-06）：收尾那句话分得清四种情形，「重开应用」只在刷新后仍找不到时出现',
    (() => {
      const logFile = 'C:\\Users\\x\\AppData\\Roaming\\dsh-console\\logs\\console.log';
      const facts = { label: 'pnpm', refreshed: 2, logFile };
      const done = envDoctor.fixDoneMessage({ ...facts, ok: true, found: true, blocked: false });
      const blocked = envDoctor.fixDoneMessage({ ...facts, ok: false, found: true, blocked: true });
      const broken = envDoctor.fixDoneMessage({ ...facts, ok: false, found: true, blocked: false });
      const missing = envDoctor.fixDoneMessage({
        ...facts,
        ok: false,
        found: false,
        blocked: false,
      });
      // `blockOf` 对"签名里带 `{}`"的函数切不准（它取的是锚点之后第一个 `{` 的配对块，
      // 而这里第一个 `{` 是参数类型），所以按**下一个顶层 export** 为界切整段
      const start = envSource.indexOf('export function fixDoneMessage(');
      const end = start < 0 ? -1 : envSource.indexOf('\nexport ', start + 10);
      const body = start < 0 ? '' : envSource.slice(start, end < 0 ? envSource.length : end);
      return (
        /现在可用了/.test(done) &&
        // 「没能实测」不是「坏了」（EPERM 一类是我们测不出来），不许吓人
        /不允许起子进程/.test(blocked) &&
        !/坏的/.test(blocked) &&
        // 「找到了但跑不起来」：点名 + 把日志位置给出来（原文在日志里，界面只说人话）
        /坏的/.test(broken) &&
        broken.includes(logFile) &&
        // 只有"刷新之后仍然找不到"这一条才允许说重开应用
        /重开应用/.test(missing) &&
        !/重开应用/.test(done + blocked + broken) &&
        (body.match(/重开应用/g) ?? []).length === 1
      );
    })(),
  );
  check(
    '环境自检（VM-06）：没有装出可用结果时，命令 / 退出码 / stdout / stderr 全落进日志（可诊断）',
    (() => {
      const fixRaw = blockOf(envSource, 'private logFixRaw(');
      const probeRaw = blockOf(envSource, 'private logProbeRaw(');
      return (
        /命令：\$\{plan\.display\}/.test(fixRaw) &&
        /退出码：/.test(fixRaw) &&
        /stdout：/.test(fixRaw) &&
        /stderr：/.test(fixRaw) &&
        // 空的那一路也要写出来 —— VM 那一屏的症状正是 stdout 空 + stderr 空
        /（空）/.test(fixRaw) &&
        // 功能实测那一条命令的原文同样要落（`<pnpm> -v` 的退出码 / 两路输出）
        /命令：\$\{probe\.file\} -v/.test(probeRaw) &&
        // 收集时两路**分开**收，否则日志里看不出是哪一路在说话
        /child\.stdout\?\.on\('data', collectOut\)/.test(envCode) &&
        /child\.stderr\?\.on\('data', collectErr\)/.test(envCode)
      );
    })(),
  );
  check(
    '环境自检（VM-07）：装完先刷新查找路径再复检（渲染层那一半见 17b）',
    // 顺序是判据：刷新必须在 recheck 之前，否则复检看到的还是旧环境
    /const added = refreshLookupPath\(this\.lookupDirs\(plan\)\);[\s\S]{0,400}?const report = await this\.doctor\.recheck\(\);/.test(
      envCode,
    ) &&
      /const probe = await probeFixTarget\(action, this\.doctor\.platform\);/.test(envCode) &&
      // dsh 的"能用"要两步都过（定位到 + 实测跑得动），与门禁那条判据同一份口径
      /statusOf\('dsh'\) === 'ok' && statusOf\('dsh-run'\) === 'ok'/.test(envCode) &&
      // 主进程把日志位置注入进去，界面才说得清"细节在哪"
      /logFile: \(\) => fileLog\.file \|\| null/.test(envMainCode),
  );

  // ---------------------------------------------------------- t79. 版本比对的更新入口
  //    需求：环境自检页里给 dsh / pnpm 两行各加一个**带版本比对**的更新入口。
  //    这一组是静态文本 + 纯函数断言（真查一次 registry 要联网，沙箱里没有）。纯函数那几条
  //    的详细反例在 `scripts/env-doctor-cases.mjs`；`fetchPackageMetadata` 只承诺"失败返回 null"。
  const registrySource = fs.readFileSync(path.join(srcDir, 'main', 'npm-registry.ts'), 'utf8');
  const registryCode = stripComments(registrySource);
  const confirmCode = stripComments(fs.readFileSync(repo.vuePath('EnvUpdateConfirm.vue'), 'utf8'));
  const preloadCode = fs.readFileSync(path.join(srcDir, 'preload', 'preload.ts'), 'utf8');
  check(
    '环境自检（t79）：dsh 那一行有更新入口，确认区也认这一档（pnpm 与 dsh 复用同一份确认区）',
    // 入口：`missing` 时给「一键安装」，其余给「更新」—— dsh 那一行也要有
    /if \(check\.id === 'dsh'\) return 'dsh';/.test(envPaneCode) &&
      // 确认区：那个条件要带上 dsh，否则按钮点开什么都不出来
      /check\.id === 'dsh'/.test(envPaneCode) &&
      /planFor\('install-dsh'\)/.test(envPaneCode) &&
      /startDshUpdate/.test(envPaneCode) &&
      // 子组件那一侧：kind 认三档、dsh 有自己的计划与版本读数 prop
      /kind: 'node' \| 'pnpm' \| 'dsh';/.test(confirmCode) &&
      /dshPlan: EnvFixPlan \| null;/.test(confirmCode) &&
      /versionOptions: string\[\];/.test(confirmCode) &&
      /versionSelected: string \| null;/.test(confirmCode) &&
      // 命令原文仍然只来自主进程给的计划（渲染层不自己拼命令，同 7.18）；
      // t81 起 dsh 那一张显示的是**按选中版本现算**的 openFixPlan（显示 == 执行）
      /openFixPlan\?\.display/.test(confirmCode) &&
      // 「要重启 dsh 才生效」这句必须在：升级 dsh 之前不停它，这就是唯一的收口
      /重新启动之后新版本才会生效/.test(confirmCode) &&
      // 两个更新入口各自的计划来源：dsh = install-dsh（可钉版本）、pnpm = update-pnpm（按归属）
      /loadEnvFixPlan\(\s*kind === 'dsh' \? 'install-dsh' : 'update-pnpm'/.test(envPaneCode),
  );
  check(
    '环境自检（t79）：pnpm / dsh 的更新按钮**只在真有新版本时**才出现（用户裁定）',
    // 显示条件与"有新版"绑在一起，而不是"这一项可用就给按钮"。三种情况都不给：
    // 还没拿到读数（初始态）、已经是最新版、这一轮没查到 —— 都退回 `false`。
    /function pkgUpdateVisible\(check: EnvCheck\): boolean \{/.test(envPaneCode) &&
      /if \(pkgTargetOf\(kind\)\) return true;/.test(envPaneCode) &&
      /return kind === 'dsh' && dshNotRunnable\.value;/.test(envPaneCode) &&
      // 唯一例外只对 dsh 开，而且判据是"sibling 的 dsh-run 不是 ok"（本机那一份真跑不动）
      /const dshNotRunnable = computed<boolean>\(\(\) => \{/.test(envPaneCode) &&
      /check\.id === 'dsh-run'/.test(envPaneCode) &&
      // 模板里按钮挂在这个条件上，不再挂在 `updateKindOf(check)` 上（那会给初始态也画一个）
      /v-if="pkgUpdateVisible\(check\)"/.test(envPaneCode) &&
      // 没有新版时只能留**读数**（一句 span），不许再跟一个「重装」按钮
      /v-if="pkgReadoutOf\(check\)" class="wizard-readout"/.test(envPaneCode) &&
      !/>\s*重装\s*<\/button>/.test(envPaneCode) &&
      // 没有目标版本时：dsh 那一支是「重装 dsh」；pnpm 那一支按**归属**给文案（t81）
      /return kind === 'dsh' \? '重装 dsh' : base;/.test(envPaneCode) &&
      /function pnpmUpdateLabel\(\): string \{/.test(envPaneCode),
  );

  // ---- 方案 A（真机 bug）：dsh 的更新入口必须用「被升级的那份 dsh 所属 Node」的 npm ----
  //    现场：console 用的是 nvm 的 v24.14.1 那份 dsh，而 `findNpm()` 在 macOS 上撞上了 PATH 里
  //    vite-plus 的 `vp` symlink → 升级装进了 v22.17.1 那棵树，界面仍写着「更新 dsh → …」→ 不收敛。
  const dshNpmCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'main', 'dsh-npm.ts'), 'utf8'),
  );
  const judgeCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'main', 'env-judge.ts'), 'utf8'),
  );
  const doctorCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'main', 'env-doctor.ts'), 'utf8'),
  );
  check(
    '环境自检（方案 A）：更新 dsh 只用"被升级的那份 dsh 所属 Node"的 npm，且按进程缓存',
    // 两步纯函数：判启动形状（node + dsh 的 bin.js）→ 推同目录的 npm
    /export function dshNodeForLauncher\(launcher: DshLauncherShape\): string \| null \{/.test(
      dshNpmCode,
    ) &&
      /export function npmForNode\([\s\S]{0,80}?platform: string\): string \| null \{/.test(
        dshNpmCode,
      ) &&
      // 必须按**目标平台**选 path 实现：否则在 macOS 上跑反例脚本测不到 win32 那一支（§7.23）
      /const impl = platform === 'win32' \? path\.win32 : path\.posix;/.test(dshNpmCode) &&
      // 三档绑定都在，且只有 bound 那份是被升级的 dsh 自己的 npm
      /kind: 'bound'/.test(dshNpmCode) &&
      /kind: 'fallback'/.test(dshNpmCode) &&
      /kind: 'unbound'/.test(dshNpmCode) &&
      // 按进程缓存 = "显示 == 执行"的机械保证（先例：canRunDsh）；refresh 只给「重新检测」
      /let bindingCache: DshNpmBinding \| null = null;/.test(dshNpmCode) &&
      /if \(!options\.refresh && bindingCache\) return bindingCache;/.test(dshNpmCode) &&
      // 不可用就不绑（**不回退**到 findNpm —— 那正是这个 bug 的成因）
      /if \(isUsableNpm\(npmPath, platform\)\) \{/.test(dshNpmCode) &&
      // 判定侧只搬运：install-dsh 用绑定那份，install-pnpm 保持原来的 npmPath 不动
      /const actionNpm = action === 'install-dsh' \? dshNpm\.path : npmPath;/.test(judgeCode) &&
      // 执行侧与报告侧同一个来源（收口成一份解析）
      /action === 'install-dsh' \? resolveNpmForDsh\(this\.settings\.all\(\)\) : findNpm\(\)/.test(
        doctorCode,
      ) &&
      /raw\.dshNpm = resolveDshNpmBinding\(this\.settings\.all\(\), \{ refresh \}\);/.test(
        doctorCode,
      ),
  );
  check(
    '环境自检（方案 A）：报告带出绑定事实；界面据此不给入口并写一条诚实边界；两条计划各问自己的 prefix',
    /export interface DshNpmBinding \{/.test(flatIpc) &&
      /kind: 'bound' \| 'fallback' \| 'unbound';/.test(flatIpc) &&
      /dshNpm: DshNpmBinding;/.test(flatIpc) &&
      // 渲染层：unbound 时**一个入口都不给**（优先级高于"重装"那条例外）
      /function dshUpdateRefused\(check: EnvCheck\): boolean \{/.test(envPaneCode) &&
      /dshNpmBinding\.value\?\.kind === 'unbound'/.test(envPaneCode) &&
      /if \(kind === 'dsh' && dshUpdateRefused\(check\)\) return false;/.test(envPaneCode) &&
      // 那条诚实边界：照 nodeUpdateRefused / .env-owner-note 那套写法，正文与命令都由主进程给
      /v-if="dshUpdateRefused\(check\)" class="env-owner-note"/.test(envPaneCode) &&
      /env-owner-note-text">\{\{ dshRefusedNote \}\}/.test(envPaneCode) &&
      /copyHint\(dshRefusedHint\)/.test(envPaneCode) &&
      // 「会装进 …」按**计划里那一条 npm**分别问，不能拿一份 prefix 糊弄两个计划
      /target: await this\.npmPrefixFor\(plan\.file\)/.test(doctorCode) &&
      /private prefixByNpm = new Map<string, string \| null>\(\);/.test(doctorCode),
  );
  check(
    '环境自检（t79）：动作只有这三个 —— install-pnpm / install-dsh / update-pnpm（t81 新增最后一个）',
    /export type EnvFixAction = 'install-pnpm' \| 'install-dsh' \| 'update-pnpm';/.test(flatIpc) &&
      // 没有第二套"更新"动作名：更新 dsh 复用 install-dsh（带版本），更新 pnpm 用 update-pnpm
      !/install-dsh-update|install-update|update-dsh/.test(flatIpc + envPaneCode) &&
      // 回归：更新 dsh **不先停 dsh**（npm 换的是磁盘上的文件），界面也不许自己调停止
      !/stopDshForUpdate/.test(envPaneCode) &&
      /await startFix\('install-dsh'/.test(envPaneCode),
  );
  check(
    '环境自检（t79）：`env:pkg-updates` 在契约 / preload / 主进程三边都在，且不在自检报告里（门禁要离线读报告）',
    /export interface EnvPkgUpdate \{/.test(flatIpc) &&
      /export interface EnvPkgUpdates \{/.test(flatIpc) &&
      /dsh: EnvPkgUpdate;/.test(flatIpc) &&
      /pnpm: EnvPkgUpdate;/.test(flatIpc) &&
      /current: string \| null;/.test(flatIpc) &&
      /newer: boolean;/.test(flatIpc) &&
      /ahead: boolean;/.test(flatIpc) &&
      /envPkgUpdates: \(options\?: \{ refresh\?: boolean \}\) => Promise<EnvPkgUpdates>;/.test(
        flatIpc,
      ) &&
      /ipcRenderer\.invoke\('env:pkg-updates'/.test(preloadCode) &&
      /ipcMain\.handle\(\s*'env:pkg-updates'/.test(envMainCode) &&
      // 它**不进**报告：首启门禁也读那条路，往里塞网络请求会把门禁变成"断网就进不去"
      !/pkgUpdates: EnvPkgUpdates/.test(flatIpc) &&
      // 报告形态（八项 + plans）没有被这一轮改动动过
      /plans: EnvFixPlan\[\];/.test(flatIpc),
  );
  check(
    '环境自检（t79）：registry 查询只读、纯函数与 IO 分开、不 import electron（反例脚本要能直接加载）',
    // 只读：一次 GET，不写用户的任何配置
    /Accept: 'application\/vnd\.npm\.install-v1\+json'/.test(registryCode) &&
      !/\bfs\b/.test(registryCode) &&
      !/from 'electron'/.test(registryCode) &&
      // 四个纯函数 + 一个 IO，名字就是契约
      /export function normalizeRegistryBase\(/.test(registryCode) &&
      /export function comparePackageVersions\(/.test(registryCode) &&
      /export function pickTargetVersion\(/.test(registryCode) &&
      /export function pickPackageUpdate\(/.test(registryCode) &&
      /export async function fetchPackageMetadata\(/.test(registryCode) &&
      // 超时那条路：AbortSignal.timeout + 失败一律 null（错误不当结论）
      /AbortSignal\.timeout\(/.test(registryCode),
  );
  check(
    '环境自检（t79 + t81）：目标版本跟着"该装到哪条线"走 —— pnpm 更新看大版本线、安装看 vcRuntime',
    // 判据在内核里（pickPackageUpdate 是纯函数），这里钉的是"调用方把两条线分开传了"。
    // t81 起缓存与查询搬去 `pkg-updates.ts`（执行侧也要用同一份），于是这一条改读新家。
    (() => {
      const pkg = stripComments(
        fs.readFileSync(path.join(srcDir, 'main', 'pkg-updates.ts'), 'utf8'),
      );
      return (
        // ① 更新路径：目标钉在 profile 记的大版本线上（读不到才跟随当前那份）
        /const pnpmMajor = input\.pnpmBinding\.file/.test(pkg) &&
        /pnpmMajorForUpdates\(input\.pnpmBinding\)/.test(pkg) &&
        /allowMajor: pnpmMajor,/.test(pkg) &&
        // ② 安装路径（还没有 pnpm 时）：缺 VC++ 运行库就是纯 JS 那条 10.x 线（VM-09）
        /pnpmInstallSpec\(hasVcRuntime\(\)\) === PNPM_PURE_JS_SPEC \? '10' : null/.test(
          envMainCode,
        ) &&
        // 安装源只从设置里取，且只用于这一次查询（不改用户的 .npmrc）
        /normalizeRegistryBase\(input\.settings\.pluginRegistry\)/.test(pkg) &&
        // 按需查 + 5 分钟内存缓存
        /PKG_UPDATE_TTL_MS = 5 \* 60 \* 1000/.test(pkg) &&
        // 渲染层那边只在详情层打开 / 重新检测 / 修复完成之后拉（不在启动时替用户发请求）
        /envDetailOpen\.value/.test(envPaneCode) &&
        /loadPkgUpdates\(true\)/.test(envPaneCode)
      );
    })(),
  );
  check(
    '环境自检（t79）：版本比对的纯函数就是 semver 那一套（预发布序），不是 Console 自己更新那份',
    // 两份实现方向相反：updater.ts 那个故意把预发布当同版本，这里必须区分
    npmRegistry.comparePackageVersions('0.2.0-rc.1', '0.2.0-rc.2') < 0 &&
      npmRegistry.comparePackageVersions('0.2.0-rc.2', '0.2.0') < 0 &&
      npmRegistry.comparePackageVersions('0.2.0', '0.2.1') < 0 &&
      npmRegistry.comparePackageVersions('1.0.0', '1.0.0') === 0 &&
      // 预发布段：数字标识符 < 字母标识符；前缀全同时标识符多的更大
      npmRegistry.comparePackageVersions('1.0.0-1', '1.0.0-alpha') < 0 &&
      npmRegistry.comparePackageVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0 &&
      // 构建元数据不参与比较；`v` 前缀认（node -v / pnpm -v 的写法）
      npmRegistry.comparePackageVersions('1.2.3+a', '1.2.3+b') === 0 &&
      npmRegistry.comparePackageVersions('v24.19.0', '24.19.0') === 0 &&
      // 认不出来的输入不抛：给确定序（垃圾项不许把整份列表搞乱）
      Number.isFinite(npmRegistry.comparePackageVersions('不是版本号', '1.0.0')),
  );
  check(
    '环境自检（t79）：挑目标版本的两支（含预发布 / 主版本区间），跳过垃圾项',
    npmRegistry.pickTargetVersion(['1.0.0', '1.1.0', '2.0.0-rc.1'], {
      includePrerelease: false,
    }) === '1.1.0' &&
      npmRegistry.pickTargetVersion(['1.0.0', '1.1.0', '2.0.0-rc.1'], {
        includePrerelease: true,
      }) === '2.0.0-rc.1' &&
      // 区间那一支：只在这个主版本里挑（`pnpm@10` 装的是 10.x 里最高的）
      npmRegistry.pickTargetVersion(['10.1.0', '10.34.6', '12.8.1'], {
        includePrerelease: false,
        allowMajor: '10',
      }) === '10.34.6' &&
      // 垃圾项跳过；没有候选给 null
      npmRegistry.pickTargetVersion(['不是版本号', 'latest'], { includePrerelease: true }) === null,
  );
  check(
    '环境自检（t79）：`npm i -g` 的假承诺防线 —— 目标必须是那条命令真的会装到的版本',
    // `@deepseek-ai/dsh` 真机数据：一个稳定版都没有，latest = 0.2.0-rc.2，而列表里最新的是
    // 0.2.1-alpha.1。取"列表里最新的"就会显示一个点下去装不到、而且**永远不收敛**的目标。
    (() => {
      const metadata = {
        versions: ['0.1.5-rc.1', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1'],
        distTags: { latest: '0.2.0-rc.2', alpha: '0.2.1-alpha.1' },
      };
      const dsh = npmRegistry.pickPackageUpdate({ current: '0.1.5-rc.1', metadata });
      // pnpm 真机形状：latest = 12.8.1，而 12.9.0 已经发布（在 `next-12` 标签下）
      const pnpm = npmRegistry.pickPackageUpdate({
        current: '12.4.2',
        metadata: { versions: ['12.8.1', '12.9.0'], distTags: { latest: '12.8.1' } },
      });
      const pure = npmRegistry.pickPackageUpdate({
        current: '10.15.0',
        metadata: { versions: ['10.15.0', '10.34.6', '12.8.1'], distTags: { latest: '12.8.1' } },
        allowMajor: '10',
      });
      // 查不到：目标为空 + 一句原因，界面退回不带版本号的入口
      const offline = npmRegistry.pickPackageUpdate({ current: '1.0.0', metadata: null });
      return (
        dsh.target === '0.2.0-rc.2' &&
        dsh.newer === true &&
        dsh.ahead === false &&
        pnpm.target === '12.8.1' &&
        pure.target === '10.34.6' &&
        // 本机比安装源还新：不写"已是最新版"（点了反而是降级）
        npmRegistry.pickPackageUpdate({ current: '0.2.1-alpha.1', metadata }).ahead === true &&
        offline.target === null &&
        offline.newer === false &&
        Boolean(offline.error)
      );
    })(),
  );

  // ---------------------------------------------------------- t81. pnpm 的归属 + dsh 的版本选择
  //    用户原话：「还需要支持选择 dsh 的更新版本，支持 pnpm 的更新，pnpm 要能识别原来是怎么安装的，
  //    并且用对应的更新方法进行更新」。两条硬约定：
  //      ① 更新对象是**插件页实际会用的那一份**（`findPnpmForProfile`），不是 PATH 上随便一份；
  //      ② 目标版本钉在 profile 记的那个大版本线上（store 布局按大版本走）。
  //    纯函数那几条的详细反例在 `scripts/env-doctor-cases.mjs` 的 O5 组（不碰磁盘、不联网）。
  const processPnpmCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'main', 'process-pnpm.ts'), 'utf8'),
  );
  const fixPlanCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'main', 'env-fix-plan.ts'), 'utf8'),
  );
  const pkgUpdatesCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'main', 'pkg-updates.ts'), 'utf8'),
  );
  const probeCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'main', 'env-probe.ts'), 'utf8'),
  );
  // t83 起 picker 本体搬去了 `VersionPick.vue`（两档共用同一个子组件）。这一组断言**跨两个文件**读，
  // 所以把两份源码拼起来喂给正则 —— 而不是把每条断言都拆成"到底读哪个文件"。
  const confirmCode2 = [
    stripComments(fs.readFileSync(repo.vuePath('EnvUpdateConfirm.vue'), 'utf8')),
    stripComments(fs.readFileSync(repo.vuePath('VersionPick.vue'), 'utf8')),
  ].join('\n');
  check(
    '环境自检（t81）：pnpm 归属四档 + unknown，判据收在纯函数里（realpath 是决定性的那条）',
    /export type EnvPnpmOwner = 'standalone' \| 'corepack' \| 'npm-global' \| 'homebrew' \| 'unknown';/.test(
      flatIpc,
    ) &&
      /export function detectPnpmOwner\(facts: PnpmOwnerFacts\): PnpmOwnerVerdict \{/.test(
        processPnpmCode,
      ) &&
      /pathHasSegment\(realPath, '\/node_modules\/corepack\/'\)/.test(processPnpmCode) &&
      /pathHasSegment\(realPath, '\/node_modules\/pnpm\/'\)/.test(processPnpmCode) &&
      // standalone 必须是**普通文件**：符号链接说明那是别处 shim 过来的
      /if \(samePath\(file, standalone\) && isFile && !isSymlink\) \{/.test(processPnpmCode) &&
      /pathHasSegment\(file, '\/opt\/homebrew\/'\) \|\| pathHasSegment\(realPath, '\/Cellar\/'\)/.test(
        processPnpmCode,
      ),
  );
  check(
    '环境自检（t81）：更新对象 = profile 匹配到的那份 + 目标钉在同一条大版本线上',
    // ① 归属事实从 `findPnpmForProfile()` 出发（不是 findPnpm），并带出 expectedMajor / matched
    /export function pnpmBindingForProfile\(profileDir: string\): EnvPnpmBinding \{/.test(
      processPnpmCode,
    ) &&
      /const pick = findPnpmForProfile\(profileDir\);/.test(processPnpmCode) &&
      // ② 目标大版本：profile 记的那条，读不到才跟随当前那份
      /export function pnpmMajorForUpdates\(binding: EnvPnpmBinding\): string \| null \{/.test(
        pkgUpdatesCode,
      ) &&
      /return binding\.expectedMajor \?\? majorOf\(binding\.version\);/.test(pkgUpdatesCode) &&
      // 采集侧把归属算进 raw（同步、不起新探测路径），判定与报告只搬运
      /const pnpmBinding = pnpmBindingForProfile\(pluginProfileDir\(\)\);/.test(probeCode) &&
      /pnpmBinding,/.test(judgeCode) &&
      /pnpmBinding: EnvPnpmBinding;/.test(flatIpc),
  );
  check(
    '环境自检（t81）：`update-pnpm` 的 argv 随归属变化，且**一定钉版本**（裸跑会跨大版本）',
    /if \(action === 'update-pnpm'\) \{/.test(fixPlanCode) &&
      /const command = pnpmUpdateCommand\(\{/.test(fixPlanCode) &&
      /return \{ file: binding\.file, args: \['self-update', target\] \};/.test(processPnpmCode) &&
      /args: \['prepare', `pnpm@\$\{target\}`, '--activate'\]/.test(processPnpmCode) &&
      /args: \['i', '-g', `pnpm@\$\{target\}`\]/.test(processPnpmCode) &&
      /args: \['upgrade', 'pnpm'\]/.test(processPnpmCode) &&
      // 拿不到目标版本 → 拒绝（不给一条会跳到最新的命令）
      /if \(!target\) return null;/.test(processPnpmCode) &&
      // Homebrew 钉不了版本：只有目标与当前同一条大版本线时才允许
      /if \(!major \|\| !currentMajor \|\| major !== currentMajor\) return null;/.test(
        processPnpmCode,
      ) &&
      // 界面那一侧只递 action（版本由主进程自己算，见 docs/env-doctor.md §3.6）；
      // t84 起 pnpm 那一档**连版本参数都不递** —— 它不吃版本，递过去会被 IPC 正确地拒掉
      /await startFix\('update-pnpm'\);/.test(envPaneCode),
  );
  check(
    '环境自检（t81）：探 pnpm 版本要带中立 cwd + 关掉 Corepack 的项目绑定（否则自检会改用户的 package.json）',
    // 两个纯函数在公开面上（反例脚本直接喂字面量）
    /export function pnpmProbeEnv\(base: NodeJS\.ProcessEnv\): NodeJS\.ProcessEnv \{/.test(
      processPnpmCode,
    ) &&
      /return \{ \.\.\.base, COREPACK_ENABLE_PROJECT_SPEC: '0' \};/.test(processPnpmCode) &&
      /export function pnpmProbeCwd\(\): string \{/.test(processPnpmCode) &&
      // spawnSync **必须**同时带这两个：不给就继承应用的 cwd，Corepack 的 shim 会替那个项目
      // 钉一行 `packageManager`（真机实测复现：在仓库根跑一次核对脚本，package.json 就多一行）
      /cwd: pnpmProbeCwd\(\),/.test(processPnpmCode) &&
      /env: pnpmProbeEnv\(process\.env\),/.test(processPnpmCode),
  );
  check(
    '环境自检（t81）：`unknown` / 缺工具 → 不给自动动作，改走诚实边界（与 Node 归属同构）',
    /canAutoUpdate: boolean;/.test(flatIpc) &&
      /blockedReason: string \| null;/.test(flatIpc) &&
      /const canAutoUpdate = helper\.ok;/.test(processPnpmCode) &&
      /function pnpmUpdateRefused\(check: EnvCheck\): boolean \{/.test(envPaneCode) &&
      // 行上：拒绝时不给按钮、也不给读数，改在行下方写事实 + 手工步骤 + 重新检测
      /if \(kind === 'pnpm' && pnpmUpdateRefused\(check\)\) return false;/.test(envPaneCode) &&
      /pnpmRefusedNote/.test(envPaneCode) &&
      /pnpmRefusedHint/.test(envPaneCode) &&
      /正在检测|重新检测/.test(envPaneCode),
  );
  check(
    '环境自检（t81）：dsh 的版本下拉 —— 列全部发行版 + 标 dist-tags + 默认落在目标 + 降级要说明',
    /export interface EnvPkgUpdate \{/.test(flatIpc) &&
      /versions: string\[\];/.test(flatIpc) &&
      /tags: Record<string, string>;/.test(flatIpc) &&
      // 下拉本身（确认区里）：v-for 版本列表 + tags 后缀 + 当前版标注
      /v-for="one in options"/.test(confirmCode2) &&
      /tagSuffix\(one\)/.test(confirmCode2) &&
      // 降级必须明说（照 Node 换档那套说辞）
      /这是一次<b>降级<\/b>/.test(confirmCode2) &&
      /v-if="versionDowngrade"/.test(confirmCode2) &&
      // 行上那个「选择版本…」ghost：与 Node 那一行的「换一档」完全同形，**不叫「更新」**
      /选择版本…/.test(envPaneCode) &&
      /v-if="canPickVersionOf\(check\)"/.test(envPaneCode) &&
      /选择版本…/.test(envPaneCode) &&
      // 尺寸必须与主按钮一致（`.btn.small`）：差 4px 会被真机一眼看出来
      /class="btn small ghost"/.test(envPaneCode),
  );
  check(
    '环境自检（t82）：版本下拉是**自绘浮层**（用户裁定 A）—— 触发器两态 + listbox + Teleport + 层号',
    // 触发器：折叠 / 展开两态、aria 三件套、点它开关
    /class="env-version-pick"/.test(confirmCode2) &&
      /class="env-version-trigger"/.test(confirmCode2) &&
      /:class="\{ 'is-open': versionOpen \}"/.test(confirmCode2) &&
      /aria-haspopup="listbox"/.test(confirmCode2) &&
      /:aria-expanded="versionOpen \? 'true' : 'false'"/.test(confirmCode2) &&
      /:aria-controls="versionListId"/.test(confirmCode2) &&
      /@click="toggleVersionPanel"/.test(confirmCode2) &&
      // 浮层：Teleport 到 body + role=listbox + 每项 role=option + aria-selected +
      // aria-activedescendant 指高亮项（原生 <select> 已被替掉：组件里不许再有它）
      /<Teleport to="body">/.test(confirmCode2) &&
      /class="env-version-pop"/.test(confirmCode2) &&
      /:style="versionPanelStyle"/.test(confirmCode2) &&
      /role="listbox"/.test(confirmCode2) &&
      /tabindex="-1"/.test(confirmCode2) &&
      /role="option"/.test(confirmCode2) &&
      /:aria-selected="one === selected \? 'true' : 'false'"/.test(confirmCode2) &&
      /:aria-activedescendant=/.test(confirmCode2) &&
      !/<select/.test(confirmCode2) &&
      // 定位：fixed + 视口坐标（留在卡片里会被裁），id 每个实例一份（多个确认区不会撞）
      /function placeVersionPanel\(\): void \{/.test(confirmCode2) &&
      /trigger\.getBoundingClientRect\(\)/.test(confirmCode2) &&
      /const versionListId = `env-version-list-\$\{Math\.random\(\)/.test(confirmCode2) &&
      // 样式与层号：--z-pop 必须高于 --z-env(30)、低于 --z-gate(58) 与启动锁(60)
      /position: fixed;/.test(repo.css) &&
      /z-index: var\(--z-pop\);/.test(repo.css) &&
      /--z-pop: 45;/.test(repo.css) &&
      /--z-env: 30;/.test(repo.css) &&
      /--z-gate: 58;/.test(repo.css) &&
      /\.env-version-trigger\.is-open \{/.test(repo.css) &&
      /\.env-version-opt\.is-on \{/.test(repo.css) &&
      // 「当前」那一行：右侧「当前」+ 版本号 accent（任务明确要求；与预览的有意差异写在样式注释里）
      /'is-current': one === \(current \?\? ''\)/.test(confirmCode2) &&
      /\.env-version-opt\.is-current \.env-version-opt-ver \{/.test(repo.css) &&
      // tags 的 chip 只用既有语义色令牌（不许颜色字面量）
      /\.env-version-tag\.is-latest \{[\s\S]*?var\(--run-soft\)/.test(repo.css) &&
      /\.env-version-tag\.is-next \{[\s\S]*?var\(--sky-soft\)/.test(repo.css) &&
      /\.env-version-tag\.is-alpha \{[\s\S]*?var\(--amber-soft\)/.test(repo.css),
  );
  check(
    '环境自检（t82）：浮层的交互 —— 点外关（pointerdown）/ Esc 还焦点 / ↑↓·Enter / 滚动收口 / 只递版本字符串',
    // 点外关闭用 pointerdown（click 会先落在选项上、先选中再关）
    /document\.addEventListener\('pointerdown', onDocumentPointerDown, true\)/.test(confirmCode2) &&
      /if \(versionTrigger\.value\?\.contains\(target\)\) return;/.test(confirmCode2) &&
      /if \(versionPanel\.value\?\.contains\(target\)\) return;/.test(confirmCode2) &&
      // Esc 关并把焦点还给触发器（鼠标点外面时不抢焦点）
      /function closeVersionPanel\(restoreFocus = false\): void \{/.test(confirmCode2) &&
      /if \(restoreFocus\) versionTrigger\.value\?\.focus\(\);/.test(confirmCode2) &&
      /closeVersionPanel\(true\);\n\s+return;/.test(confirmCode2) &&
      // 键盘：导航交给纯函数、Enter/Space 选中（折叠态 ↑↓/Enter/Space 打开）
      /versionActive\.value = nextActiveIndex\(versionActive\.value, nav, props\.options\.length\)/.test(
        confirmCode2,
      ) &&
      /event\.key === 'Enter' \|\| event\.key === ' '/.test(confirmCode2) &&
      // 滚动/视口变化：收口**关闭**，但放过面板自己内部的滚动（否则列表一滚就关）
      /window\.addEventListener\('scroll', onViewportMove, true\)/.test(confirmCode2) &&
      /window\.addEventListener\('resize', onViewportMove\)/.test(confirmCode2) &&
      // 组件拆掉时摘监听（不然监听会挂着一个已经不存在的面板）
      /onBeforeUnmount\(\(\) => \{/.test(confirmCode2) &&
      /window\.removeEventListener\('scroll', onViewportMove, true\)/.test(confirmCode2) &&
      // 选中只有一条路：emit 版本字符串（命令与校验都在主进程）
      /function emitPickedVersion\(version: string\): void \{/.test(confirmCode2) &&
      /emit\('pick-version', version\);/.test(confirmCode2) &&
      /'pick-version': \[version: string\];/.test(confirmCode2),
  );
  check(
    '环境自检（t82）：版本下拉的键盘导航是**纯函数**（到边界停住、空列表 -1、无高亮时上下键落首尾）',
    // 这一条直接调函数（与 env-detail / wizard-view 同一条路：test 侧 import renderer 的纯模块）
    versionPick.nextActiveIndex(0, 'ArrowUp', 3) === 0 &&
      versionPick.nextActiveIndex(2, 'ArrowDown', 3) === 2 &&
      versionPick.nextActiveIndex(0, 'ArrowDown', 3) === 1 &&
      versionPick.nextActiveIndex(-1, 'ArrowDown', 3) === 0 &&
      versionPick.nextActiveIndex(-1, 'ArrowUp', 3) === 2 &&
      versionPick.nextActiveIndex(1, 'Home', 5) === 0 &&
      versionPick.nextActiveIndex(1, 'End', 5) === 4 &&
      versionPick.nextActiveIndex(0, 'ArrowDown', 0) === -1 &&
      versionPick.clampActive(9, 3) === 2 &&
      versionPick.clampActive(-5, 3) === -1,
  );
  check(
    '环境自检（t82）：列表按 **C 的时间轴**画 —— 轴 + 节点 + 当前/目标/区间三个状态',
    // 每行自己一条轴 + 一个节点（轴在行内 stretch，行高变化不会把线画歪）
    /class="env-version-axis"/.test(confirmCode2) &&
      /class="env-version-node"/.test(confirmCode2) &&
      /\.env-version-axis \{[\s\S]*?align-self: stretch;/.test(repo.css) &&
      // 首尾收口：第一行从节点起、最后一行到节点止（别在列表头尾画出悬空的线）
      /\.env-version-opt:first-child \.env-version-axis::before \{[\s\S]*?top: 50%;/.test(
        repo.css,
      ) &&
      /\.env-version-opt:last-child \.env-version-axis::before \{[\s\S]*?bottom: 50%;/.test(
        repo.css,
      ) &&
      // 当前 = 实心绿点（--run）；目标 = 空心 accent 环 + accent-soft 光晕
      /\.env-version-opt\.is-current \.env-version-node \{[\s\S]*?var\(--run\)/.test(repo.css) &&
      /\.env-version-opt\.is-target \.env-version-node \{[\s\S]*?var\(--accent\)[\s\S]*?box-shadow: 0 0 0 3px var\(--accent-soft\)/.test(
        repo.css,
      ) &&
      // 区间：下标集合（`betweenIndexes`）算出来，**不用 :nth-child 猜**；升 accent、降 amber
      /'is-between': betweenIndexSet\.has\(versionIndexOf\(one\)\)/.test(confirmCode2) &&
      /'is-down': direction === 'down'/.test(confirmCode2) &&
      /'is-up': direction === 'up'/.test(confirmCode2) &&
      /\.env-version-opt\.is-between\.is-up \.env-version-axis::before \{[\s\S]*?var\(--accent\)/.test(
        repo.css,
      ) &&
      /\.env-version-opt\.is-between\.is-down \.env-version-axis::before \{[\s\S]*?var\(--amber\)/.test(
        repo.css,
      ) &&
      // 两个端点行各补"朝目标的那半行"：不然线段与节点之间会留一截发丝线的缝
      /\.env-version-opt\.is-current\.is-up \.env-version-axis::before \{[\s\S]*?bottom: 50%;/.test(
        repo.css,
      ) &&
      /\.env-version-opt\.is-target\.is-up \.env-version-axis::before \{[\s\S]*?top: 50%;/.test(
        repo.css,
      ) &&
      /\.env-version-opt\.is-current\.is-down \.env-version-axis::before \{[\s\S]*?top: 50%;/.test(
        repo.css,
      ) &&
      /\.env-version-opt\.is-target\.is-down \.env-version-axis::before \{[\s\S]*?bottom: 50%;/.test(
        repo.css,
      ) &&
      !/\.env-version-opt:nth-child/.test(repo.css),
  );
  check(
    '环境自检（t82）：浮层顶部的**粘性摘要行**（限高会滚，方向信息不能跟着滚走）',
    // 摘要在浮层里、而且是 sticky：浮层没滚动时它也在（它是摘要，不是"滚动才出现"的东西）
    /class="env-version-head"/.test(confirmCode2) &&
      /\.env-version-head \{[\s\S]*?position: sticky;[\s\S]*?top: 0;/.test(repo.css) &&
      // 背景必须自己给（不然文字与下面的节点叠在一起）+ 下边一条发丝线
      /\.env-version-head \{[\s\S]*?background: var\(--surface-2\);[\s\S]*?border-bottom: 1px solid var\(--hairline\);/.test(
        repo.css,
      ) &&
      // 色调按方向：升 accent、降 amber（色调就是"升/降"本身）
      /\.env-version-head\.is-up \{[\s\S]*?var\(--accent\)/.test(repo.css) &&
      /\.env-version-head\.is-down \{[\s\S]*?var\(--amber\)/.test(repo.css) &&
      // 三种文案分支：升（→ … · 升级）/ 降（↓ 降级）/ 相等（当前就是这一版）；缺当前版本不编"从哪来"
      /const headText = computed\(\(\) => \{/.test(confirmCode2) &&
      /· \$\{direction\.value === 'down' \? '↓ 降级' : '升级'\}/.test(confirmCode2) &&
      /（当前就是这一版）/.test(confirmCode2) &&
      /if \(!current\) return target;/.test(confirmCode2) &&
      // 限高与滚动保持 232px（滚动条仍由全局那一套管）
      /\.env-version-pop \{[\s\S]*?max-height: 232px;[\s\S]*?overflow: auto;/.test(repo.css),
  );
  check(
    '环境自检（t82）：键盘高亮与「当前/目标」是**两套独立状态**（同一行两件事都看得见）',
    // 高亮 = 底色 + 字色；当前/目标 = 节点 + 右侧标签 —— 四个 class 各自独立挂
    /'is-on': versionIndexOf\(one\) === versionActive/.test(confirmCode2) &&
      /'is-current': one === \(current \?\? ''\)/.test(confirmCode2) &&
      /'is-target': isTargetRow\(one\)/.test(confirmCode2) &&
      /class="env-version-opt-right is-cur"/.test(confirmCode2) &&
      /class="env-version-opt-right is-target"/.test(confirmCode2) &&
      /\.env-version-opt-right\.is-cur \{[\s\S]*?var\(--run\)/.test(repo.css) &&
      /\.env-version-opt-right\.is-target \{[\s\S]*?var\(--accent\)/.test(repo.css) &&
      // 高亮那条规则写在「当前/目标」之后：两者同占时字色给高亮，节点与标签仍然说身份
      repo.css.indexOf('.env-version-opt.is-on .env-version-opt-ver') >
        repo.css.indexOf('.env-version-opt.is-current .env-version-opt-ver') &&
      // 两个真源确实不同：高亮是 versionActive（鼠标 hover 也写它），目标是父级传的 dshSelected
      /function isTargetRow\(one: string\): boolean \{/.test(confirmCode2) &&
      /one === \(props\.selected \?\? ''\) && one !== \(props\.current \?\? ''\)/.test(
        confirmCode2,
      ),
  );
  check(
    '环境自检（t82）：方向与区间是纯函数（倒序列表里"下标更小 = 升"；界面不比版本号字符串）',
    // 这一条直接调函数：`rc.9` 与 `rc.10` 按字典序比会得出相反的方向，所以方向不许在界面里判
    versionPick.pickDirection(3, 0) === 'up' &&
      versionPick.pickDirection(0, 3) === 'down' &&
      versionPick.pickDirection(2, 2) === 'same' &&
      versionPick.pickDirection(-1, 2) === 'unknown' &&
      versionPick.pickDirection(2, -1) === 'unknown' &&
      JSON.stringify(versionPick.betweenIndexes(0, 3)) === JSON.stringify([1, 2, 3]) &&
      JSON.stringify(versionPick.betweenIndexes(3, 1)) === JSON.stringify([2, 3]) &&
      versionPick.betweenIndexes(2, 2).length === 0 &&
      versionPick.betweenIndexes(-1, 2).length === 0,
  );
  check(
    '环境自检（t81 + t84）：渲染层递回来的版本号**必须校验**（形状 + 只在 dsh 那一档 + 落在这一轮的列表里）',
    // 形状 + **只有 `install-dsh` 有意义**（t84 回退：pnpm 不做选版本）+ 必须命中列表（拿不到列表时拒绝）
    /async function resolveFixVersion\(/.test(envMainCode) &&
      /\^\\d\+\\.\\d\+\\.\\d\+\(\?:-\[0-9A-Za-z\.-\]\+\)\?\$/.test(envMainCode) &&
      /if \(request\.action !== 'install-dsh'\) \{/.test(envMainCode) &&
      /pnpm 那一档不选版本/.test(envMainCode) &&
      // 白名单就是 dsh 那一份（pnpm 恒为空，见 t84 那条）
      /const list = updates\.dsh\.versions;/.test(envMainCode) &&
      /if \(!list\.includes\(wanted\)\) \{/.test(envMainCode) &&
      /if \(list\.length === 0\) \{/.test(envMainCode) &&
      // 递回来的东西一律不采信：命令由主进程现场重算
      /return await envFixRunner\.run\(action, checked\.version\);/.test(envMainCode),
  );
  check(
    '环境自检（t81）：确认区那一份定向计划走新通道（显示 == 执行）',
    /envFixPlan: \(request: \{ action: EnvFixAction; version\?: string \}\) => Promise<EnvFixPlan \| null>;/.test(
      flatIpc,
    ) &&
      /ipcRenderer\.invoke\('env:fix-plan'/.test(preloadCode) &&
      /ipcMain\.handle\(\s*'env:fix-plan'/.test(envMainCode) &&
      // 确认区用它而不是报告里那份（报告那份是"没选版本"的版本）
      /:open-fix-plan="openFixPlan"/.test(envPaneCode) &&
      /openFixPlan\?\.display/.test(confirmCode2) &&
      // 版本参数**按档位给**：只有 dsh 那一档带选中的版本（t84 —— pnpm 不吃版本，递过去会被主进程拒）
      /await loadEnvFixPlan\(\s*kind === 'dsh' \? 'install-dsh' : 'update-pnpm',\s*kind === 'dsh' \? \(versionPick\.value \?\? undefined\) : undefined,/.test(
        envPaneCode,
      ) &&
      // 执行那条路同样分档：pnpm 那一档不带版本
      /await startFix\('update-pnpm'\);/.test(envPaneCode) &&
      /await startFix\('install-dsh', versionPick\.value \?\? undefined\);/.test(envPaneCode),
  );
  check(
    '环境自检（t84 回退）：只有 dsh 能选版本 —— pnpm 固定在线内最新，带版本的 pnpm 请求被明确拒绝',
    // ① 主进程给 pnpm 的"可挑列表"恒为空（判据是 `allowMajor`：有它就说明是 pnpm 那一档）；
    //    **只为此存在**的过滤函数已经删掉 —— 别留死代码
    /const selectable = allowMajor === null \? versions : \[\];/.test(registryCode) &&
      /versions: selectable,/.test(registryCode) &&
      /major: allowMajor,/.test(registryCode) &&
      !/versionsOfMajor/.test(registryCode) &&
      // ② 校验只认 dsh；`update-pnpm` 带版本要给**明确说法**（收下再悄悄忽略就是"显示 A、执行 B"）
      /if \(request\.action !== 'install-dsh'\) \{/.test(envMainCode) &&
      /pnpm 那一档不选版本/.test(envMainCode) &&
      /const list = updates\.dsh\.versions;/.test(envMainCode) &&
      // ③ 计划里不再吃版本参数（chosen 只用算出来的目标）；但 **homebrew 那条"同一条大版本线才允许"
      //    的守卫要留着** —— 它防的是 `brew upgrade pnpm` 把大版本换掉，与"选版本"无关
      /const chosen = pnpm\.target;/.test(fixPlanCode) &&
      /if \(!major \|\| !currentMajor \|\| major !== currentMajor\) return null;/.test(
        processPnpmCode,
      ) &&
      // ④ 界面：那个自绘控件只剩 dsh 一处；pnpm 那一档不再渲染它、行上也不给「选择版本…」
      (confirmCode2.match(/<VersionPick/g) ?? []).length === 1 &&
      /if \(updateKindOf\(check\) !== 'dsh'\) return false;/.test(envPaneCode) &&
      // ⑤ 那句解释留着，并改写成用户那个问题的答案（跨大版本是一次**单独的迁移动作**）
      /目标钉在/.test(confirmCode2) &&
      /大版本线内/.test(confirmCode2) &&
      /不在这里做/.test(confirmCode2),
  );
  check(
    '环境自检（t83）：同一行里两个按钮必须**同高**（真机抓到的 4px 错位）',
    // 根因：`.env-actions` 没写 align-items（flex 默认 stretch，而按钮是固定高）→ 按顶边对齐
    /\.env-actions \{[\s\S]*?align-items: center;/.test(repo.css) &&
      // 「选择版本…」与主按钮同尺寸（`.btn.small`），层级只由 ghost 的配色表达
      /v-if="canPickVersionOf\(check\)"[\s\S]{0,220}class="btn small ghost"/.test(envPaneCode),
  );

  // ---------------------------------------------------------- t80. 修复子进程的 env 清洗（根因修复）
  //    根因（真机实测）：Electron 把父进程那套 `npm_config_*` 原样传给了修复子进程，而 npm 的
  //    优先级是"环境变量 > 由自身位置推出的默认值" —— 于是 `i -g` 的全局目录由**继承来的变量**
  //    决定，而不是由这份 npm 的位置决定。表现是"拿 v24 的 npm 装进 v22 那棵树"：装是成功了，
  //    可要升级的那份 dsh 一个字没变，界面于是永远提示有新版本。
  //    这一组钉三件事：清洗在家里、调用点真的用了它、刻意注入的安装源排在它**之后**。
  const doctorSource = fs.readFileSync(path.join(srcDir, 'main', 'env-doctor.ts'), 'utf8');
  const runnerEnvBlock =
    /const env: NodeJS\.ProcessEnv = \{([\s\S]*?)\n {4}\};/.exec(doctorSource)?.[1] ?? '';
  const cleanAt = runnerEnvBlock.indexOf('cleanNpmEnv(envWithKnownBins(process.env))');
  const registryAt = runnerEnvBlock.indexOf(
    'pluginRegistryEnv(this.settings.all().pluginRegistry)',
  );
  check(
    '环境自检（t80）：修复子进程的 env 先过 cleanNpmEnv，再注入安装源（顺序反了会丢源）',
    cleanAt >= 0 &&
      registryAt >= 0 &&
      // 注入必须排在清洗**之后**：反过来的话，设置里填的安装源会被一起清掉
      cleanAt < registryAt &&
      // PATH 补齐那一步没被顺手拿掉（清洗只删 npm 配置键，不该动 PATH）
      /cleanNpmEnv\(envWithKnownBins\(process\.env\)\)/.test(doctorSource),
    `env 块里 cleanNpmEnv@${cleanAt} < pluginRegistryEnv@${registryAt}（都要 >= 0）`,
  );
  // 「会装进 …」那一行读的是 `readNpmPrefix`（它跑一次 `npm prefix -g`），它必须与执行安装时
  // 那份 env 得出**同一个**答案 —— 否则会错位成"显示 v22、实际装进 v24"，比原来更难查。
  const probeSource = fs.readFileSync(path.join(srcDir, 'main', 'env-probe.ts'), 'utf8');
  const prefixBody = stripComments(blockOf(probeSource, 'async function readNpmPrefix('));
  const runVersionBody = stripComments(blockOf(probeSource, 'function runVersion('));
  check(
    '环境自检（t80）：显示的「会装进」与执行走同一份干净 env（readNpmPrefix 也过 cleanNpmEnv）',
    prefixBody.length > 0 &&
      runVersionBody.length > 0 &&
      /cleanNpmEnv\(envWithKnownBins\(process\.env\)\)/.test(prefixBody) &&
      // 只钉"读数"这条路；`runVersion` 那条（`npm -v` 之类，结果不进"会装进"）本轮刻意没动
      /envWithKnownBins\(process\.env\)/.test(runVersionBody) &&
      !/cleanNpmEnv/.test(runVersionBody),
    `readNpmPrefix=${prefixBody.length} 字符（cleanNpmEnv=${/cleanNpmEnv/.test(prefixBody)}）、runVersion=${runVersionBody.length} 字符（没动=${!/cleanNpmEnv/.test(runVersionBody)}）`,
  );
  check(
    '环境自检（t80）：cleanNpmEnv 在家里（process-utils 的公开面），判据是前缀、大小写不敏感',
    typeof processUtils.cleanNpmEnv === 'function' &&
      (() => {
        const base: NodeJS.ProcessEnv = {
          PATH: '/usr/bin:/bin',
          HOME: '/Users/someone',
          npm_config_prefix: '/nvm/versions/node/v22.17.1',
          NPM_CONFIG_PREFIX: '/nvm/versions/node/v22.17.1',
          npm_config_registry: 'https://registry.npmmirror.com',
          npm_config_cache: '/Users/someone/.npm',
          HTTP_PROXY: 'http://127.0.0.1:7890',
          LANG: 'zh_CN.UTF-8',
        };
        const cleaned = processUtils.cleanNpmEnv(base);
        const leftNpmKeys = Object.keys(cleaned).filter((key) =>
          key.toLowerCase().startsWith('npm_config_'),
        );
        return (
          leftNpmKeys.length === 0 &&
          // 非 npm 键一律留着：清的是 npm 的配置，不是"环境"（代理与 locale 都得在）
          cleaned.PATH === '/usr/bin:/bin' &&
          cleaned.HOME === '/Users/someone' &&
          cleaned.HTTP_PROXY === 'http://127.0.0.1:7890' &&
          cleaned.LANG === 'zh_CN.UTF-8' &&
          // 键与值一起丢：留个空串在 npm 眼里仍然算"设过"
          !Object.prototype.hasOwnProperty.call(cleaned, 'npm_config_prefix') &&
          !Object.prototype.hasOwnProperty.call(cleaned, 'NPM_CONFIG_PREFIX') &&
          // 前缀匹配而不是固定清单（漏一个键就等于没修）；没有下划线的 npm_config 不误伤
          Object.keys(processUtils.cleanNpmEnv({ npm_config_whatever_new: '1' })).length === 0 &&
          processUtils.cleanNpmEnv({ npm_config: '3' }).npm_config === '3' &&
          // 入参不许被改（调用点那份 env 还要继续用）
          Object.keys(base).length === 8 &&
          base.npm_config_prefix === '/nvm/versions/node/v22.17.1' &&
          // 空对象 / undefined 不炸，且返回的是对象不是 undefined
          Object.keys(processUtils.cleanNpmEnv({})).length === 0 &&
          Object.keys(processUtils.cleanNpmEnv(undefined)).length === 0
        );
      })(),
    `typeof=${typeof processUtils.cleanNpmEnv}；清洗后只剩 ${Object.keys(
      processUtils.cleanNpmEnv({ npm_config_prefix: 'x', PATH: '/bin' }),
    ).join(',')}`,
  );

  // ---------------------------------------------------------- t85. 更新完 dsh 的"重启提示"由事实决定
  //    真机反馈：更新完 dsh、**自己重启过 dsh**，之后再点任何更新入口，那条「新版本的 dsh 要重新
  //    启动之后才会生效」又冒出来了。根因是判据里带着一个会话内的布尔（`restartDismissed`），而
  //    `openUpdate()` 每次打开更新入口都把它复位 —— 一次早已生效的更新被反复提示。
  //    修法：**比事实**（`dsh.startedAt` vs `EnvFixState.finishedAt`），并删掉那个复位。
  check(
    '环境自检（t85）：`EnvFixState` 带上"这一轮跑完的时刻"，且只在终态有值',
    /finishedAt: number \| null;/.test(flatIpc) &&
      // 一轮只打一次戳：终态补上、新一轮开头清掉（每次终态都取 Date.now() 会让时间戳往后漂，
      // 而界面拿它判"运行中的 dsh 是不是更新之后起来的" —— 漂晚一点就会把已生效的又提示一遍）
      /if \(terminal && this\.finishedAt === null\) this\.finishedAt = Date\.now\(\);/.test(
        doctorSource,
      ) &&
      /finishedAt: terminal \? this\.finishedAt : null/.test(doctorSource) &&
      /this\.finishedAt = null;/.test(doctorSource),
  );
  check(
    '环境自检（t85）："要不要提示重启 dsh"比的是事实，不是"用户有没有关过提示"',
    /import \{ shouldAskRestartDsh \} from '\.\/restart-ask\.js';/.test(envPaneCode) &&
      /return shouldAskRestartDsh\(\{/.test(envPaneCode) &&
      /startedAt: dsh\.value\?\.startedAt \?\? null,/.test(envPaneCode) &&
      /finishedAt: state\.finishedAt \?\? null,/.test(envPaneCode) &&
      // 纯函数本身要能被独立加载（反例脚本直接喂字面量；这条同时保证它进了编译产物）
      typeof restartAsk.shouldAskRestartDsh === 'function',
  );
  check(
    '环境自检（t85）：`openUpdate` 里不许再复位那个布尔（那正是"重启完还会冒出来"的直接原因）',
    // 反例：`openUpdate` 每次打开更新入口都 `restartDismissed.value = false` —— 它把"用户已经
    // 自己重启过 dsh"这个事实抹掉了。整份源码里都不许再出现这个复位。
    !/restartDismissed\.value = false/.test(envPaneCode) &&
      // 但「先不用」与两个重启动作仍然要能置真（那是用户明确的"别再问我"）
      /restartDismissed\.value = true;/.test(envPaneCode),
  );
}
