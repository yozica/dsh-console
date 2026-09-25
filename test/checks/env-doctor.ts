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
import * as pluginManager from '../../src/main/plugin-manager';
import * as processUtils from '../../src/main/process-utils';
import { DEFAULTS } from '../../src/main/settings';
import * as envDetail from '../../src/renderer/lib/env-detail';

import { createEnvFixtures } from '../env-fixtures';
import { check, skip, IS_WINDOWS } from '../harness';
import type { Repo } from '../repo';
import { blockOf, functionBodyOf, stripComments, stripStrings } from '../text';

export function runEnvDoctor(repo: Repo): void {
  const f = createEnvFixtures(repo);
  const repoRoot = repo.root;
  const rendererDir = repo.rendererDir;
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
        .readFileSync(path.join(rendererDir, 'panes', 'EnvPane.vue'), 'utf8')
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
      const source = fs.readFileSync(path.join(srcDir, 'main', 'env-doctor.ts'), 'utf8');
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
  const envRunBody = stripComments(blockOf(envSource, 'async run(action: EnvFixAction)'));
  const envRunnerBody = stripComments(blockOf(envSource, 'async execute(action: EnvFixAction)'));
  const envPublishBody = stripComments(blockOf(envSource, 'private publish(state: EnvFixState)'));
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
    '环境自检：契约里有 8 个 id、2 个动作、5 个 API',
    (() => {
      const idUnion = /export type EnvCheckId =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      const actionUnion = /export type EnvFixAction =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      return (
        /export type EnvCheckStatus = 'ok' \| 'warn' \| 'missing';/.test(flatIpc) &&
        idUnion.split('|').filter(Boolean).length === 8 &&
        envIds.every((id) => idUnion.includes(`'${id}'`)) &&
        actionUnion.split('|').filter(Boolean).length === 2 &&
        actionUnion.includes("'install-pnpm'") &&
        actionUnion.includes("'install-dsh'") &&
        /export interface EnvCheck \{/.test(flatIpc) &&
        /fixAction: EnvFixAction \| null;/.test(flatIpc) &&
        /export interface EnvDoctorReport \{/.test(flatIpc) &&
        /export interface EnvFixState \{/.test(flatIpc) &&
        /envCheck: \(options\?: \{ refresh\?: boolean \}\) => Promise<EnvDoctorReport>;/.test(
          flatIpc,
        ) &&
        /envFix: \(request: \{ action: EnvFixAction \}\) => Promise<EnvFixState>;/.test(flatIpc) &&
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
    '环境自检：渲染层只递 action（执行的是主进程自己算的 argv）',
    /const \{ action \} = \(request \?\? \{\}\) as \{ action\?: EnvFixAction \};/.test(
      envMainCode,
    ) &&
      /envFixRunner\.run\(action\)/.test(envMainCode) &&
      /const plan = await this\.doctor\.fixPlan\(action\);/.test(envCode) &&
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
      /await runEnvFix\(action\)/.test(envStartFixBody) &&
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
      const pluginSource = fs.readFileSync(path.join(srcDir, 'main', 'plugin-manager.ts'), 'utf8');
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
        /envFixPlan\(action, findNpm\(\), hasVcRuntime\(\)\)/.test(envCode) &&
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
}
