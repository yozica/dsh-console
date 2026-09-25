'use strict';

/**
 * 主进程逻辑自检（不需要 Electron、不会启动/结束任何进程）。
 * 运行：npm test
 *
 * 覆盖：
 *   1. dsh 启动命令解析（node + bin.js / shim / npx 三级回退，按平台判定）
 *   2. ANSI 清理 + 从 dsh 横幅里提取带令牌的 URL
 *   3. HTTP 健康探测的 dsh 判据（真实探测本机端口 + 纯函数夹具）
 *   4. 端口占用解析（Windows 的 netstat / macOS·Linux 的 lsof 夹具 + 可选的真实查询）
 *   5. DshManager 状态机（外部实例接管判定）
 *   6. 渲染层静态检查（含 macOS 的平台适配契约）
 *   7. 主题取值、发布：CHANGELOG 条目与 changeset 片段的汇总规则
 *   8. 自动更新契约（不自动下载 / 安装、macOS 与开发态不加载 electron-updater）
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

import * as processUtils from '../src/main/process-utils';
import * as pluginManager from '../src/main/plugin-manager';
import * as patchLayer from '../src/main/patch-layer';
import * as profileBundles from '../src/main/profile-bundles';
import * as envDoctor from '../src/main/env-doctor';
// 渲染层的纯逻辑（`lib/**` 与 selftest 同属「契约与编排」那一层，见 AGENTS §2 的模块边界）
import * as envDetail from '../src/renderer/lib/env-detail';
import * as wizardView from '../src/renderer/lib/wizard-view';
import * as restartNav from '../src/renderer/lib/restart-nav';
import * as nodeInstaller from '../src/main/node-installer';
import { Settings, DEFAULTS } from '../src/main/settings';
import { RELEASES_URL, UPDATE_MAC_FEED_URL } from '../src/shared/ipc';
import type {
  EnvCheckId,
  EnvCheckStatus,
  EnvDoctorReport,
  EnvNodeOwner,
  EnvStepStatus,
  EnvWizardState,
  EnvWizardStep,
  EnvWizardStepId,
} from '../src/shared/ipc';
import { PtySessions } from '../src/main/pty-sessions';
import { DshManager } from '../src/main/dsh-manager';

const IS_WINDOWS = process.platform === 'win32';

/** package.json 里本文件真正读到的字段（用最小的 interface 兜住 JSON.parse 的 any）*/
interface PackageJson {
  version: string;
  build?: { mac?: { identity?: string } };
}

interface CheckResult {
  name: string;
  ok: boolean;
  /** 这条断言打印的实际值（失败时进 CI 注解，见文件末尾汇总） */
  extra?: unknown;
}

const results: CheckResult[] = [];
function check(name: string, ok: boolean, extra?: unknown) {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
}
function skip(name: string, why: string) {
  console.log(`SKIP  ${name}  — ${why}`);
}

/** 当前环境能否启动外部命令（受限沙箱里 netstat/lsof/ps 会被拒） */
function canSpawnBinaries(): Promise<boolean> {
  return new Promise((resolve) => {
    const command = IS_WINDOWS ? 'netstat' : 'lsof';
    const args = IS_WINDOWS ? ['-ano', '-p', 'tcp'] : ['-nP', '-iTCP:1', '-sTCP:LISTEN'];
    try {
      execFile(command, args, { windowsHide: true, timeout: 8000 }, (error) => {
        // 命令不存在/被拒才算不可用；"没匹配到监听"（lsof 退出码 1）也是跑起来了
        resolve(!error || !['ENOENT', 'EPERM', 'EACCES'].includes(String(error.code)));
      });
    } catch {
      resolve(false);
    }
  });
}

/** 进程名查询单独探测：macOS 上 lsof 可能可用而 ps 被沙箱禁掉 */
function canQueryProcessName(): Promise<boolean> {
  return new Promise((resolve) => {
    const command = IS_WINDOWS ? 'tasklist' : 'ps';
    const args = IS_WINDOWS ? ['/FI', 'PID eq 1', '/FO', 'CSV', '/NH'] : ['-o', 'comm=', '-p', '1'];
    try {
      execFile(command, args, { windowsHide: true, timeout: 8000 }, (error) => {
        resolve(!error || !['ENOENT', 'EPERM', 'EACCES'].includes(String(error.code)));
      });
    } catch {
      resolve(false);
    }
  });
}

async function main(): Promise<void> {
  const sandbox = path.join(__dirname, '..', '.verify');
  fs.mkdirSync(sandbox, { recursive: true });

  // ---------------------------------------------------------- 1. 命令解析
  const settings = new Settings(path.join(sandbox, 'settings.json'));
  settings.patch({ port: 3080, host: '127.0.0.1', extraArgs: '' });
  check(
    '设置：不认识的设置项直接报错、一个字都不写（界面比主进程新时不能假装保存成功）',
    (() => {
      const before = JSON.stringify(settings.all());
      let threw = false;
      try {
        // 真机上丢过一次「插件安装源」：窗口热重载了、主进程还是旧构建，
        // 旧的主进程不认识这个键，静默丢掉，界面照样显示"已保存"。
        settings.patch({ pluginRegistry: 'https://registry.example.com', noSuchSetting: 1 });
      } catch {
        threw = true;
      }
      return threw && JSON.stringify(settings.all()) === before;
    })(),
  );
  const launch = processUtils.resolveDshInvocation(settings.all());
  check(
    '命令解析：拿到可执行文件与参数',
    Boolean(launch.file) && Array.isArray(launch.args) && launch.args.includes('web'),
    `${launch.kind}: ${launch.display}`,
  );
  check(
    '命令解析：带上了 --no-open 与 --port',
    launch.args.includes('--no-open') && launch.args.includes('--port'),
  );

  if (IS_WINDOWS) {
    const shimLaunch = processUtils.resolveDshInvocation({
      ...settings.all(),
      dshCommand: 'C:\\fake\\dsh.cmd',
    });
    check(
      '命令解析：自定义 .cmd 走 cmd.exe',
      shimLaunch.file.toLowerCase().includes('cmd') && shimLaunch.kind === 'custom-shim',
    );
  } else {
    // macOS/Linux 上 .cmd 是 Windows 批处理：必须明确报错，而不是假装能跑
    let rejected = false;
    try {
      processUtils.resolveDshInvocation({ ...settings.all(), dshCommand: 'C:\\fake\\dsh.cmd' });
    } catch (error) {
      rejected = /批处理/.test(error instanceof Error ? error.message : String(error));
    }
    check('命令解析：POSIX 下 .cmd 明确报错而不是假装能跑', rejected);
  }

  const directLaunch = processUtils.resolveDshInvocation({
    ...settings.all(),
    dshCommand: '/usr/local/bin/dsh',
  });
  check(
    '命令解析：自定义命令直接执行（不带 shim）',
    directLaunch.kind === 'custom' && directLaunch.file === '/usr/local/bin/dsh',
    directLaunch.display,
  );

  // 回归：macOS 上从 Finder/Dock 启动的 GUI 应用 PATH 很窄（不含 nvm/homebrew 的 bin），
  // 那时既找不到 dsh shim 也找不到 node，于是退到 npx —— 而 npx 要联网解析/安装包，
  // 一旦 npm 缓存或网络有问题，dsh 会瞬间以退出码 1 结束，界面只看到"启动不了"。
  // 所以解析必须能直接从全局安装目录找到 bin.js，不依赖 PATH。
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = IS_WINDOWS ? 'C:\\Windows\\System32' : '/usr/bin:/bin';
    const narrow = processUtils.resolveDshInvocation(settings.all());
    if (narrow.kind === 'node-bin') {
      check('命令解析：PATH 里没有 dsh 也能从全局安装目录找到 bin.js', true, narrow.display);
    } else {
      skip(
        '命令解析：PATH 里没有 dsh 也能从全局安装目录找到 bin.js',
        `本机未发现全局安装的 @deepseek-ai/dsh（解析为 ${narrow.kind}）`,
      );
    }
  } catch (error) {
    skip(
      '命令解析：PATH 里没有 dsh 也能从全局安装目录找到 bin.js',
      `本机没有可用的 node/dsh：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    process.env.PATH = savedPath;
  }

  // 自定义命令可以写整条命令行：第一个 token 是可执行文件，后面的作为前置参数。
  // 这是"换一个能跑 dsh 的 Node"的唯一出口（PATH 里的 node 未必是能跑它的那个）。
  const prefixed = processUtils.resolveDshInvocation({
    ...settings.all(),
    dshCommand: '/opt/x/bin/node /opt/x/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  });
  check(
    '命令解析：自定义命令带前置参数（node + 入口脚本）',
    prefixed.kind === 'custom' &&
      prefixed.file === '/opt/x/bin/node' &&
      prefixed.args[0].endsWith('lib/bin.js') &&
      prefixed.args.includes('--port'),
    prefixed.display,
  );

  // 关键回归：解析出来的解释器必须**真的能跑 dsh**。
  // dsh 的 CLI 在不兼容的 Node 上不会报错，只安静退出（退出码 0、零输出）——
  // 光看退出码永远发现不了，所以选解释器时要实测一次（`<node> <bin.js> --version`）。
  const candidates = processUtils.dshInterpreterCandidates();
  const working = candidates.filter((c) => processUtils.canRunDsh(c.node, c.binJs));
  if (working.length === 0) {
    skip(
      '命令解析：解析出的解释器实测能跑 dsh',
      '本机没有任何能跑 dsh 的 node（或不允许起子进程）',
    );
  } else {
    check(
      '命令解析：解析出的解释器实测能跑 dsh',
      processUtils.canRunDsh(launch.file, launch.args[0]),
      `${launch.file} ← 候选里可用的有 ${working.length} 个`,
    );
  }

  const shell = processUtils.resolveShell(settings.all());
  check('本地 Shell 解析：文件存在', fs.existsSync(shell.file), shell.file);
  if (!IS_WINDOWS) {
    // 契约：POSIX 上必须是**用户自己的 sh 系登录 shell**（$SHELL 优先，否则 zsh → bash → sh），
    // 而且**不能**是 pwsh —— 装了 PowerShell 的 mac 不少（GitHub 的 macOS runner 就自带），
    // 自动挑它会让"新建本地 Shell"开出 PowerShell 而不是用户的 zsh（CI 上因此红过一条）。
    // 顺带记一个坑：老的断言写的是 /(zsh|bash|sh)$/，而 "pwsh" 也以 sh 结尾，它其实放过了 pwsh，
    // 真正拦下来的是 args 里没有 -l —— 所以这里既查文件也查 -l，别只查其中一个。
    const envShell = String(process.env.SHELL || '').trim();
    const expected: string | RegExp =
      envShell && fs.existsSync(envShell) ? envShell : /(zsh|bash)$|\/sh$/;
    const sameAsUserShell =
      typeof expected === 'string' ? shell.file === expected : expected.test(shell.file);
    check(
      '本地 Shell 解析：POSIX 用用户自己的登录 shell（$SHELL 优先，不会是 pwsh）',
      sameAsUserShell && shell.args.includes('-l'),
      `${shell.file} ${shell.args.join(' ')}（$SHELL=${envShell || '未设置'}）`,
    );
  }

  // ---------------------------------------------------------- 2. ANSI + 横幅
  const banner =
    '\u001b[32mdsh web\u001b[0m: \u001b[36mhttp://127.0.0.1:3080/?token=abc123DEF\u001b[0m (LAN: http://192.168.1.5:3080/?token=abc123DEF)\r\n';
  const plain = processUtils.stripAnsi(banner);
  check('ANSI 清理：不残留转义序列', !/\u001b/.test(plain), JSON.stringify(plain.slice(0, 40)));
  const urlMatch = plain.match(/dsh web:\s+(https?:\/\/[^\s)]+)/);
  check(
    '横幅解析：提取到带令牌 URL',
    Boolean(urlMatch && urlMatch[1].includes('token=abc123DEF')),
    urlMatch && urlMatch[1],
  );

  // ---------------------------------------------------------- 3. 健康探测判据
  check(
    'dsh 判据：401 + 鉴权提示算 dsh',
    processUtils.isDshResponse(
      401,
      'dsh web authentication required; reopen the URL printed by dsh web.\n',
    ) === true,
  );
  check(
    'dsh 判据：带 __DSH_BOOT__ 的 200 算 dsh',
    processUtils.isDshResponse(200, '<script>window.__DSH_BOOT__={}</script>') === true,
  );
  check(
    'dsh 判据：别的 200 页面不算 dsh',
    processUtils.isDshResponse(200, '<html>hello nginx</html>') === false,
  );

  const probe = await processUtils.probeHttp('http://127.0.0.1:3080', 1500);
  if (probe.reachable) {
    check(
      '健康探测（真实）：判定为 dsh',
      probe.isDsh === true,
      `HTTP ${probe.statusCode}, ${probe.latencyMs}ms`,
    );
  } else {
    skip('健康探测（真实）', `本机 3080 无服务：${probe.error}`);
  }
  const deadProbe = await processUtils.probeHttp('http://127.0.0.1:59999', 800);
  check('健康探测：无服务时判定不可达', deadProbe.reachable === false && deadProbe.isDsh === false);

  // ---------------------------------------------------------- 4. 端口占用解析
  //    两个解析器都是纯函数，所以**在哪个平台都跑两套夹具** ——
  //    这样在 mac 上开发也不会把 Windows 的 netstat 解析改坏（反之亦然）。
  const netstatFixture = [
    '',
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       42112',
    '  TCP    127.0.0.1:3081         0.0.0.0:0              LISTENING       42113',
    '  TCP    127.0.0.1:54321        127.0.0.1:3080         ESTABLISHED     9999',
    '  TCP    [::]:445               [::]:0                 LISTENING       4',
    '',
  ].join('\r\n');
  const parsed = processUtils.parseNetstatForPort(netstatFixture, 3080);
  check(
    'netstat 解析：挑出 LISTENING 行的 PID',
    Boolean(parsed && parsed.pid === 42112),
    JSON.stringify(parsed),
  );
  check(
    'netstat 解析：不会误取其它端口',
    processUtils.parseNetstatForPort(netstatFixture, 4242) === null,
  );
  check(
    'netstat 解析：ESTABLISHED 行不会被当成监听',
    processUtils.parseNetstatForPort(netstatFixture, 54321) === null,
  );

  const lsofFixture = [
    'COMMAND   PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node    42112 licheng   20u  IPv4 0x8a1b2c3d4e5f      0t0  TCP 127.0.0.1:3080 (LISTEN)',
    'node    42113 licheng   21u  IPv6 0x8a1b2c3d4e60      0t0  TCP *:3081 (LISTEN)',
    'node    42112 licheng   22u  IPv4 0x8a1b2c3d4e61      0t0  TCP 127.0.0.1:54321->127.0.0.1:3080 (ESTABLISHED)',
    '',
  ].join('\n');
  const lsofParsed = processUtils.parseLsofForPort(lsofFixture, 3080);
  check(
    'lsof 解析：挑出 LISTEN 行的 PID',
    Boolean(lsofParsed && lsofParsed.pid === 42112),
    JSON.stringify(lsofParsed),
  );
  check(
    'lsof 解析：通配监听 *:3081 也能命中',
    processUtils.parseLsofForPort(lsofFixture, 3081)?.pid === 42113,
  );
  check('lsof 解析：不会误取其它端口', processUtils.parseLsofForPort(lsofFixture, 4242) === null);
  check(
    'lsof 解析：ESTABLISHED 行不会被当成监听',
    processUtils.parseLsofForPort(lsofFixture, 54321) === null,
  );

  const spawnOk = await canSpawnBinaries();
  const nameQueryOk = await canQueryProcessName();
  if (!spawnOk) {
    skip('端口占用查询（真实系统命令）', '当前环境不允许启动外部命令（受限沙箱）');
  } else if (!probe.reachable) {
    skip('端口占用查询（真实系统命令）', '3080 无监听');
  } else {
    const owner = await processUtils.portOwnerSync(3080);
    check(
      '端口占用查询：拿到 PID',
      Boolean(owner && Number.isInteger(owner.pid)),
      owner ? `PID ${owner.pid}` : 'null',
    );
    if (owner && nameQueryOk) {
      const name = await processUtils.processNameSync(owner.pid);
      check('端口占用查询：拿到进程名', name.length > 0, name);
    } else if (owner) {
      skip('端口占用查询：拿到进程名', '当前环境不允许启动 ps / tasklist');
    }
  }

  // ---------------------------------------------------------- 5. 状态机
  const ptySessions = new PtySessions();
  const manager = new DshManager({ settings, ptySessions });
  manager.log = () => {}; // 静音，避免刷屏
  await manager.pollOnce();
  const snapshot = manager.snapshot();
  if (probe.reachable && probe.isDsh) {
    check(
      '状态机：识别为外部实例（接管模式）',
      snapshot.phase === 'external',
      `phase=${snapshot.phase}`,
    );
    if (spawnOk) {
      check('状态机：记录了外部 PID', Boolean(snapshot.externalPid), `PID ${snapshot.externalPid}`);
    } else {
      skip('状态机：外部 PID', '当前环境不允许启动端口查询命令');
    }
  } else {
    check('状态机：无服务时判定为已停止', snapshot.phase === 'stopped', `phase=${snapshot.phase}`);
  }
  check(
    '状态机：快照字段齐全',
    ['phase', 'origin', 'probe', 'launch', 'logs', 'latencyHistory'].every(
      (key) => key in snapshot,
    ),
  );
  check('进程存活判定：不存在的 PID 视为已死', processUtils.isAlive(999999) === false);
  check(
    `node-pty 可加载（${IS_WINDOWS ? 'ConPTY' : 'forkpty'} 支持）`,
    typeof ptySessions.create === 'function',
  );

  // 回归：node-pty 在 Windows/ConPTY 下构造时 pid=0，要等 ready_datapipe 才原地更新。
  // 曾经用 Boolean(pid) 判断归属，导致 pid=0 时"启动"可点、"停止"被禁用。
  // macOS 上 PID 是同步就绪的，但"就绪前按会话归属、不按 PID"这条判据仍然要成立。
  let fakePid = 0;
  // DshManager 只用到 on/has/pid 三个成员；PtySessions 带私有字段，结构类型天然对不上，
  // 所以这里按"测试替身"断言一次（下面还会改 has 来模拟会话消失）。
  const stubPty = {
    on() {},
    has: () => true,
    pid: () => fakePid,
    write: () => true,
    resize: () => true,
    kill: () => true,
    list: () => [],
  };
  const stubManager = new DshManager({
    settings,
    ptySessions: stubPty as unknown as PtySessions,
  });
  stubManager.log = () => {};
  const early = stubManager.snapshot();
  check(
    '状态机：PID 尚未就绪（0）时仍认定为本应用启动',
    early.owned === true && early.pid === null,
    `owned=${early.owned} pid=${early.pid}`,
  );
  fakePid = 42148;
  check(
    '状态机：PTY 就绪后能读到真实 PID',
    stubManager.ownedPid === 42148,
    `pid=${stubManager.ownedPid}`,
  );
  fakePid = 0;
  stubManager.portPid = 999;
  check(
    '状态机：PID 未知时用端口占用者兜底',
    stubManager.ownedPid === 999,
    `pid=${stubManager.ownedPid}`,
  );

  // 会话消失 + 没有兜底 PID => 不再算自己的进程（界面据此把"停止"置灰）
  stubPty.has = () => false;
  stubManager.portPid = null;
  check('状态机：会话结束后不再认定为本应用启动', stubManager.ownProcess === false);

  // 启动失败时要把 dsh 自己说的原因带进事件日志。
  // 之前只记「退出码 1」，真正的原因（端口被占 / npx 报错）躺在终端页里没人发现 ——
  // 用户看到的就只是"启动不了"。
  stubManager.buffer = [
    '\u001b[32mdsh\u001b[0m 正在启动…\r\n',
    '\u001b[31mnpm error code EPERM\u001b[0m\r\n',
    'npm error syscall open\r\n',
    'npm error Log files were not written due to an error writing to the directory\r\n',
  ];
  const reason = stubManager.lastOutputLine();
  check('启动失败：能从终端缓冲里摘出像报错的那一行', /EPERM/.test(reason), reason);
  stubManager.buffer = [];
  check('启动失败：没有输出时返回空串（不会伪造原因）', stubManager.lastOutputLine() === '');

  // Node 抛异常时缓冲里先出现「file:///… 源码行 + ^」，真正的原因在后面的 `Error: …`。
  // 真机截图里救援条显示成了那行源码，等于什么都没说 —— 这几类必须滤掉。
  stubManager.buffer = [
    'file:///Users/x/.nvm/versions/node/v24/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1199\n',
    '\tif (!Array.isArray(parsed)) throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`);\n',
    '\t                     ^\n',
    '\n',
    'Error: dsh: overlay /Users/x/.dsh/profiles/web/cordis.patch.yml must be a top-level YAML array of loader patch entries\n',
    '    at loadOverlay (file:///Users/x/.nvm/versions/node/v24/lib/index.js:1199:8)\n',
  ];
  const fromStack = stubManager.lastOutputLine();
  check(
    '启动失败：Node 堆栈里要摘出 `Error: …` 那一行，不是源码行',
    /^Error: dsh: overlay /.test(fromStack) && !/throw new/.test(fromStack),
    fromStack,
  );
  stubManager.buffer = [];

  // ---------------------------------------------------------- 6. 渲染层静态检查
  //    渲染层没有类型检查，这里挡掉最容易犯的错：元素 id / class / API 名拼错。
  //    界面正在逐页迁到 Vue 单文件组件，所以**标记与脚本都要把 .vue 一起算进来**
  //    （panes/ 是页面，shell/ 是外壳），否则迁走的部分会悄悄脱离这些检查的覆盖。
  const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
  const srcDir = path.join(__dirname, '..', 'src');
  const vueDirs = ['panes', 'shell'];
  const vueFiles: { dir: string; name: string }[] = []; // 形如 { dir, name }
  for (const dir of vueDirs) {
    const full = path.join(rendererDir, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full).filter((n) => n.endsWith('.vue'))) {
      vueFiles.push({ dir, name });
    }
  }
  const vueSource = vueFiles
    .map(({ dir, name }) => fs.readFileSync(path.join(rendererDir, dir, name), 'utf8'))
    .join('\n');

  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  // 渲染层脚本的来源有三处：app.ts（应用级胶水）、lib/（共享模块）、.vue 的 <script setup>
  const libDir = path.join(rendererDir, 'lib');
  const libSource = fs.existsSync(libDir)
    ? fs
        .readdirSync(libDir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => fs.readFileSync(path.join(libDir, name), 'utf8'))
        .join('\n')
    : '';
  const rendererJs = `${fs.readFileSync(path.join(rendererDir, 'app.ts'), 'utf8')}\n${libSource}`;
  const markup = `${html}\n${vueSource}`; // 标记来源：静态 HTML + 已迁移的 .vue 模板
  const rendererAll = `${rendererJs}\n${vueSource}`; // 渲染层脚本：app.ts + lib/ + .vue
  // 只看代码，不看注释：注释里常拿 `getElementById('btn-xxx')` 这种示意写法举例，
  // 当真引用去查会误报（已经误报过一次）。
  const rendererCode = rendererAll.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const htmlIds = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const jsIds = [
    ...new Set([...rendererCode.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1])),
  ];
  const missingIds = jsIds.filter((id) => !htmlIds.has(id));
  check(
    '渲染层：JS 引用的元素 id 都存在于标记里（HTML + .vue）',
    missingIds.length === 0,
    missingIds.length
      ? `缺少 ${missingIds.join(', ')}`
      : `${jsIds.length} 个 id（覆盖 ${vueFiles.length} 个 .vue）`,
  );

  // preload 已随主进程一起迁到 TS（src/preload/preload.ts），这里读它
  const preloadJs = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'preload', 'preload.ts'),
    'utf8',
  );
  const exposed = new Set([...preloadJs.matchAll(/^\s{2}([A-Za-z]+):/gm)].map((match) => match[1]));
  const apiCalls = [
    ...new Set([...rendererCode.matchAll(/\bapi\.([A-Za-z]+)\(/g)].map((match) => match[1])),
  ];
  const missingApi = apiCalls.filter((name) => !exposed.has(name));
  check(
    '渲染层：调用的 api.* 都在 preload 里暴露',
    missingApi.length === 0,
    missingApi.length ? `缺少 ${missingApi.join(', ')}` : `${apiCalls.length} 个方法`,
  );

  // 会话的"输入"与"输出"必须成对：只调 sessionInput 而不订阅 onSessionOutput，
  // 输入会送进 PTY，但 PTY 返回的提示符与回显没人接 —— 界面上就是"打字没反应"。
  // 迁移时正好漏了这条订阅（本地 Shell 全程没有回显），所以用检查盯住。
  const createsShell = /api\.createShell\(/.test(rendererCode);
  const wiresSession =
    /api\.sessionInput\(/.test(rendererCode) && /api\.onSessionOutput\(/.test(rendererCode);
  check(
    '渲染层：发起会话的页面同时接了输入与输出',
    !createsShell || wiresSession,
    createsShell
      ? wiresSession
        ? '输入/输出成对'
        : '有 createShell 但没有 onSessionOutput'
      : '没有会话功能',
  );

  // 每个组件都必须**有人用**：要么在 mount.ts 的挂载清单里，要么被别的组件 import
  //（t45 起「终端」页把 dsh 那一路拆成了子组件 DshTerminal，它不该出现在挂载清单里）。
  // 两种都不占的组件等于死代码 —— 界面上那块永远空着，或者根本没人渲染它。
  const mountJs = fs.readFileSync(path.join(rendererDir, 'mount.ts'), 'utf8');
  const allVueSources =
    mountJs +
    vueFiles
      .map(({ dir, name }) => fs.readFileSync(path.join(rendererDir, dir, name), 'utf8'))
      .join('\n');
  const unusedVue = vueFiles
    .filter(({ dir, name }) => {
      const stem = name.replace(/\.vue$/, '');
      // 两种写法都算：挂载清单里是 `./panes/X.vue`，同目录的组件之间是 `./X.vue`
      const specs = [
        dir === 'panes' ? `./panes/${stem}.vue` : `./shell/${stem}.vue`,
        `./${stem}.vue`,
      ];
      return !specs.some((spec) => allVueSources.includes(`from '${spec}'`));
    })
    .map(({ name }) => name);
  check(
    '渲染层：每个 .vue 组件都被用到（在挂载清单里，或被别的组件 import）',
    vueFiles.length > 0 && unusedVue.length === 0,
    unusedVue.length ? `没人用 ${unusedVue.join(', ')}` : `${vueFiles.length} 个组件`,
  );
  // 挂了终端的页面必须自己订阅容器尺寸变化。"靠全局 resize"或"切页时才 fit"都不够：
  // 本地 Shell 就因此不跟随窗口（踩过 —— 旧代码里是 app.js 的全局 resize 处理器负责，
  // 迁移时只搬进了终端页）。
  const terminalUsers = vueFiles.filter(({ dir, name }) =>
    fs.readFileSync(path.join(rendererDir, dir, name), 'utf8').includes('attachTerminal('),
  );
  const noObserver = terminalUsers
    .filter(
      ({ dir, name }) =>
        !fs.readFileSync(path.join(rendererDir, dir, name), 'utf8').includes('ResizeObserver'),
    )
    .map(({ name }) => name);
  check(
    '渲染层：用终端的页面都订阅了容器尺寸变化',
    terminalUsers.length > 0 && noObserver.length === 0,
    noObserver.length
      ? `缺 ResizeObserver：${noObserver.join(', ')}`
      : `${terminalUsers.length} 个页面`,
  );
  // 挂了终端的页面还要让应用快捷键穿过去：xterm 会把 Ctrl+2~6 当控制字符吃掉并停止冒泡，
  // 不调 attachCustomKeyEventHandler 的话，人在终端里按这些键切不动页面
  // （症状：只有 Ctrl+1 有效，因为 1 恰好不在 xterm 的按键表里）。
  const noShortcutPassthrough = terminalUsers
    .filter(
      ({ dir, name }) =>
        !fs
          .readFileSync(path.join(rendererDir, dir, name), 'utf8')
          .includes('passAppShortcutsThrough'),
    )
    .map(({ name }) => name);
  check(
    '渲染层：用终端的页面让应用快捷键穿过去',
    terminalUsers.length > 0 && noShortcutPassthrough.length === 0,
    noShortcutPassthrough.length
      ? `未放行：${noShortcutPassthrough.join(', ')}`
      : `${terminalUsers.length} 个页面`,
  );
  // 挂载点必须是"布局透明"的（display: contents）：否则组件渲染出的内容会多包一层块级元素，
  // 把父级的 flex/grid 链断掉 —— 症状是内嵌页只剩顶上一条（webview 退回默认高度）。
  // （css 变量在下面的主题一节才定义，这里单独读一次，别提前引用。）
  const cssText = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const rootIds = [...html.matchAll(/id="([\w-]*-root)"/g)].map((match) => match[1]);
  const contentsRules = (cssText.match(/#[\w-]*-root[^{]*\{[^}]*\}/g) || []).filter((rule) =>
    /display:\s*contents/.test(rule),
  );
  const declaredTransparent = new Set(
    contentsRules.flatMap((rule) => [...rule.matchAll(/#([\w-]*-root)/g)].map((match) => match[1])),
  );
  const notTransparent = rootIds.filter((id) => !declaredTransparent.has(id));
  check(
    '渲染层：每个挂载点都是 display: contents',
    rootIds.length > 0 && notTransparent.length === 0,
    notTransparent.length ? `未声明 ${notTransparent.join(', ')}` : `${rootIds.length} 个挂载点`,
  );
  check(
    '渲染层：外壳与页面的挂载点都在',
    rootIds.length >= 5 && /export function mountAll/.test(mountJs),
    `${rootIds.length} 个挂载点`,
  );

  // CSS 与 JS 的契约：样式用 body[data-xxx] 当开关，就必须有人去设置这个属性。
  // 漏掉的话按钮改了状态、界面毫无反应 —— 应用内全屏就这么整个失效过一次
  // （CSS 里 8 条规则全挂在 body[data-immersive] 上，而没人写它）。
  const bodyFlags = [
    ...new Set([...cssText.matchAll(/body\[data-([\w-]+)/g)].map((match) => match[1])),
  ];
  const unwiredFlags = bodyFlags.filter((flag) => {
    const camel = flag.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    return !new RegExp(`dataset\\.(?:${flag}|${camel})\\s*=`).test(rendererCode);
  });
  check(
    '渲染层：CSS 用到的 body[data-*] 开关都有人设置',
    bodyFlags.length > 0 && unwiredFlags.length === 0,
    unwiredFlags.length ? `没人设置 ${unwiredFlags.join(', ')}` : bodyFlags.join(', '),
  );

  // macOS 适配的契约一：红绿灯画在**窗口**左上角，而贴窗口左边的是左栏（.rail）——
  // 顶栏在左栏右侧，够不到红绿灯。踩过两次，所以四条都用检查钉住：
  //   1. 左栏顶部让出一条与标题栏等高的区域（padding-top）
  //   2. 顶栏只在「应用内全屏（左栏被藏掉、顶栏变成最左列）」时才让白
  //   3. 顶栏在非全屏时**不能**有左内边距（否则页面标题被冤枉缩进 84px）
  //   4. 系统全屏（红绿灯自动隐藏）时把 1、2 都撤回
  const platformJs = fs.readFileSync(path.join(rendererDir, 'lib', 'platform.ts'), 'utf8');
  check(
    '渲染层：macOS 红绿灯留白给左栏（应用内全屏让白、系统全屏撤回、非全屏顶栏不缩进）',
    /html\[data-platform='darwin'\]\s*\.rail\s*\{[^}]*padding-top/.test(cssText) &&
      /html\[data-platform='darwin'\]\s*body\[data-immersive='true'\]\s*\.topbar\s*\{[^}]*padding-left/.test(
        cssText,
      ) &&
      !/html\[data-platform='darwin'\]\s*\.topbar\s*\{[^}]*padding-left/.test(cssText) &&
      /html\[data-platform='darwin'\]\s*body\[data-native-fullscreen='true'\]\s*\.rail\s*\{[^}]*padding-top/.test(
        cssText,
      ) &&
      /html\[data-platform='darwin'\]\s*body\[data-native-fullscreen='true'\]\s*\.topbar[^{]*\{[^}]*padding-left/.test(
        cssText,
      ) &&
      // 门禁层是**另一条左轨**（.gate-rail）：全屏时它也得顶到窗口上沿，
      // 否则向导页的左栏会比"没有门禁时"低 36px（用户抓图指出过）
      /html\[data-platform='darwin'\]\s*body\[data-native-fullscreen='true'\]\s*\.gate-rail\s*\{[^}]*margin-top: calc\(-1 \* var\(--bar-h\)\)/.test(
        cssText,
      ) &&
      /html\[data-platform='darwin'\]\s*body\[data-native-fullscreen='true'\]\s*\.gate-rail\s*\{[^}]*padding-top: 16px/.test(
        cssText,
      ) &&
      /api\.onFullscreen\(/.test(rendererCode) &&
      /onFullscreen:/.test(preloadJs) &&
      /documentElement\.dataset\.platform\s*=/.test(platformJs) &&
      /setPlatform\(snapshot\.value\?\.env\?\.platform\)/.test(rendererCode),
    '两条左轨的让位与撤回 + 应用内全屏顶栏让位 + 非全屏不缩进 + platform/全屏状态都有来源',
  );

  // macOS 适配的契约二：三处快捷键处理器都必须走平台修饰键
  // （mac 认 Cmd、其它平台认 Ctrl），不能各自写死 ctrlKey —— 写死的话 mac 上全部失灵。
  const shortcutFiles = ['app.ts', 'dev-diagnostics.ts', path.join('lib', 'xterm.ts')];
  const notPlatformAware = shortcutFiles.filter(
    (rel) => !fs.readFileSync(path.join(rendererDir, rel), 'utf8').includes('isAppModifier('),
  );
  check(
    '渲染层：三处快捷键处理器都按平台取修饰键',
    notPlatformAware.length === 0,
    notPlatformAware.length
      ? `未适配：${notPlatformAware.join(', ')}`
      : `${shortcutFiles.length} 处都走 isAppModifier`,
  );

  // 依赖从"index.html 里的 script 标签"改成了模块导入（Vite 构建），
  // 所以要检查的是：入口被引入、入口导入了样式表、xterm 由 lib/xterm.ts 直接用类导入。
  const rendererEntry = fs.readFileSync(path.join(rendererDir, 'main.ts'), 'utf8');
  const xtermLib = fs.readFileSync(path.join(rendererDir, 'lib', 'xterm.ts'), 'utf8');
  check(
    '渲染层：入口被引入，样式与 xterm 都有来源',
    /<script type="module" src="\.\/main\.ts"><\/script>/.test(html) &&
      /import '\.\/styles\.css'/.test(rendererEntry) &&
      /from '@xterm\/xterm'/.test(xtermLib) &&
      /from '@xterm\/addon-fit'/.test(xtermLib),
  );
  // 产物必须是普通脚本：file:// 下 ES module 会走 CORS 检查而加载失败。
  // 这条检查看的是"有没有把 module 改回 classic"的构建插件，以及入口有没有动态 import
  // （动态 import 会切出第二个 chunk，跨 chunk 就必须用模块语法）。
  const viteConfig = fs.readFileSync(path.join(__dirname, '..', 'vite.config.mts'), 'utf8');
  check(
    '构建：产物走普通脚本（file:// 兼容）',
    /type="module" crossorigin /.test(viteConfig) && /classicScriptPlugin/.test(viteConfig),
    'vite.config.mts 里把 module 标签改回 defer',
  );
  check(
    '构建：入口不用动态 import（否则产物跨 chunk 必须用模块语法）',
    !/\bawait import\(|\bimport\(/.test(rendererEntry),
  );

  // macOS 打包必须签名（没有开发者证书时用 ad-hoc，即 `mac.identity: "-"`）。
  // 踩过：0.2.1 的 mac 包装完在 Finder 里双击只报「已损坏，无法打开」——因为打包时
  // **完全没签名**（Electron 自带二进制的签名被重新打包改坏了，等于"签名存在但无效"），
  // 而 Apple 芯片上签名无效的 app 会被系统直接拒绝。同一个坑还有第二个入口：
  // CI 里的 CSC_IDENTITY_AUTO_DISCOVERY=false 会让 app-builder-lib 的 isSignAllowed()
  // 提前返回 false，连 ad-hoc 签名都跳过 —— 所以这两处一起检查。
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ) as PackageJson;
  const releaseWorkflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  check(
    '构建：macOS 走 ad-hoc 签名，且 CI 没有把签名整个关掉',
    pkgJson.build?.mac?.identity === '-' &&
      !/CSC_IDENTITY_AUTO_DISCOVERY\s*:\s*['"]?false/.test(releaseWorkflow),
    `mac.identity=${JSON.stringify(pkgJson.build?.mac?.identity)}`,
  );
  // xterm 与 addon 必须直接用导入的类，不能绕 window 全局：
  // UMD 全局是命名空间对象（window.FitAddon.FitAddon 才是类），把 ESM 导入的类
  // 挂上去再读 .FitAddon 就是 undefined —— fit addon 会静默装不上、
  // 终端永远停在默认 80×24（踩过：容器 966×723，终端却只画 572×432）。
  check(
    '渲染层：xterm 与 addon 用导入的类，不经过 window 全局',
    !/window\.(Terminal|FitAddon|WebLinksAddon)/.test(rendererCode) &&
      /new Terminal\(/.test(xtermLib) &&
      /new FitAddon\(/.test(xtermLib),
  );
  // 两个内嵌页必须各自用独立且持久的分区：DSH 界面存令牌 cookie，用量页存登录态。
  // 扫 markup（HTML + .vue）：两个 webview 现在分别住在各自的页面组件里。
  const partitions = [
    ...markup.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<webview[^>]*partition="([^"]+)"/g),
  ].map((match) => match[1]);
  const allPersistent =
    partitions.length === 2 && partitions.every((name) => name.startsWith('persist:'));
  check(
    '渲染层：两个内嵌页各有独立的持久分区',
    allPersistent && new Set(partitions).size === partitions.length,
    partitions.length ? partitions.join(' / ') : '没有找到 webview 分区',
  );

  // ---------------------------------------------------------- 7. 主题
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  // t48 样式分层起，「整份样式」是**两层**：全局表（变量 / 主题 / 骨架 / 共享件）+ 各组件
  // 自己的 `<style>` 块（页面私有的规则搬进组件）。变量块与主题仍在全局表里 —— 那不是
  // 页面私有的东西，所以下面几条读变量块的检查继续只看 `css`。
  const vueStyles = vueFiles
    .map(({ dir, name }) => {
      const text = fs.readFileSync(path.join(rendererDir, dir, name), 'utf8');
      return text.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '';
    })
    .join('\n');
  const allCss = `${css}\n${vueStyles}`;
  check('主题：CSS 定义了亮色变量块', /:root\[data-theme='light'\]\s*\{/.test(css));

  // 深色基础块 + 亮色覆盖块之外不应再出现硬编码颜色，否则亮色下会漏改。
  // 先剥注释：解释性注释里常引用颜色字面量（例如说明"xterm 自带样式写死了 #000"），
  // 那不是样式声明，不该报（这类误报已经出现三次）。两层都要查 —— 搬进组件的规则
  // 同样是"亮色下会漏改"的一份。
  const cssCode = allCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutVarBlocks = cssCode
    .replace(/:root\s*\{[\s\S]*?\n\}/, '')
    .replace(/:root\[data-theme='light'\]\s*\{[\s\S]*?\n\}/, '');
  const strayColors = [...withoutVarBlocks.matchAll(/#[0-9a-fA-F]{3,6}\b|rgba?\(/g)].map(
    (match) => match[0],
  );
  check(
    '主题：样式表除变量块外没有硬编码颜色',
    strayColors.length === 0,
    strayColors.length ? `残留 ${[...new Set(strayColors)].join(', ')}` : '全部走 CSS 变量',
  );

  // 主题无关的尺度令牌（字号、圆角、字体）不需要亮色重复定义，只需要覆盖颜色令牌
  const parseVars = (block: string | null | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const match of String(block || '').matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi))
      out[match[1]] = match[2].trim();
    return out;
  };
  const isColorValue = (value: string): boolean => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(value);
  const darkBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  const lightBlock = css.match(/:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/);
  const darkVars = parseVars(darkBlock && darkBlock[1]);
  const lightVars = parseVars(lightBlock && lightBlock[1]);
  const darkColors = Object.keys(darkVars).filter((name) => isColorValue(darkVars[name]));
  const uncovered = darkColors.filter((name) => !(name in lightVars));
  check(
    '主题：亮色覆盖了深色的全部颜色变量',
    uncovered.length === 0,
    uncovered.length ? `未覆盖 ${uncovered.join(', ')}` : `${darkColors.length} 个颜色变量`,
  );

  const usedVars = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]));
  const undefinedVars = [...usedVars].filter((name) => !(name in darkVars) && !(name in lightVars));
  check(
    '主题：样式里 var() 引用的变量都有定义',
    undefinedVars.length === 0,
    undefinedVars.length ? `未定义 ${undefinedVars.join(', ')}` : `${usedVars.size} 个引用`,
  );

  const openBraces = (css.match(/\{/g) || []).length;
  const closeBraces = (css.match(/\}/g) || []).length;
  check('样式：花括号配对', openBraces === closeBraces, `${openBraces} / ${closeBraces}`);

  // @font-face 指到不存在的文件会静默回退到系统字体，等于"刻意选字体"这件事白做了。
  // 引号不挑：Prettier 会按 singleQuote 配置把 url() 里的引号统一成单引号。
  const fontUrls = [...css.matchAll(/url\(["']([^"']+\.woff2)["']\)/g)].map((match) => match[1]);
  const missingFonts = fontUrls.filter((rel) => !fs.existsSync(path.resolve(rendererDir, rel)));
  check(
    '字体：@font-face 引用的文件都存在',
    fontUrls.length > 0 && missingFonts.length === 0,
    missingFonts.length ? `缺失 ${missingFonts.join(', ')}` : `${fontUrls.length} 个 woff2`,
  );

  // 页面容器不能用 display:none 隐藏：<webview> 会以 0 尺寸挂载 guest，
  // 切回来时 guest 的视口可能还是旧的 —— 症状是内嵌页只渲染出顶部一小条。
  const paneBlock = css.match(/\n\.pane\s*\{([\s\S]*?)\n\}/);
  const paneBody = paneBlock ? paneBlock[1] : '';
  const paneUsesDisplayNone = /display:\s*none/.test(paneBody);
  check(
    '样式：页面容器靠 visibility 隐藏，不用 display:none',
    !paneUsesDisplayNone && /visibility:\s*hidden/.test(paneBody),
    paneUsesDisplayNone
      ? '又用回 display:none 了（webview 会拿到错误视口）'
      : 'visibility: hidden + absolute',
  );

  // 每个 <webview> 都必须在样式里拿到明确高度。漏一个，它就会退化成浏览器默认的
  // 替换元素尺寸（约 300×150），内嵌页只剩顶部一小条 —— 这个坑真踩过一次。
  const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasSizedRule = (selector: string): boolean => {
    const rule = css.match(new RegExp(`${escaped(selector)}\\s*\\{([\\s\\S]*?)\\n\\}`));
    return rule ? /(^|\s)(height|inset)\s*:/.test(rule[1]) : false;
  };
  // 扫 markup（HTML + .vue）：webview 现在住在页面组件里。
  // 先剥掉注释：注释里常拿 `<webview>` 这种示意写法举例，会被"找标签"的正则误当成真标签。
  const markupCode = markup.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const webviews = [...markupCode.matchAll(/<webview\b[^>]*>/g)].map((match) => match[0]);
  const unsizedViews = webviews.filter((tag) => {
    const id = (tag.match(/id="([^"]+)"/) || [])[1];
    const classes = ((tag.match(/class="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    const selectors = [...(id ? [`#${id}`] : []), ...classes.map((name) => `.${name}`)];
    return !selectors.some(hasSizedRule);
  });
  check(
    '样式：每个 webview 都有明确高度的样式',
    webviews.length === 2 && unsizedViews.length === 0,
    unsizedViews.length
      ? `没尺寸规则：${unsizedViews.length} 个`
      : `${webviews.length} 个 webview 都有`,
  );

  // 标记里写了但样式表里没有的 class，通常意味着"这块还没做完"。
  // 用 markup（HTML + .vue 模板）：迁到 Vue 的页面不能因此脱离这条覆盖。
  // 两种来源都要认：
  //   1. 静态 `class="a b"` —— 但要排除 `:class` 绑定（值是表达式，不是类名）
  //   2. 动态 `:class="{ active: 条件, 'is-on': 条件 }"` —— 取花括号里的键名
  const staticClasses = [...markup.matchAll(/(?<!:)class="([^"]+)"/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter((name) => name && !/[{}():]/.test(name));
  const dynamicClasses = [...markup.matchAll(/:class="\{([^}]*)\}"/g)]
    .flatMap((match) =>
      match[1].split(',').map((pair) => pair.split(':')[0].trim().replace(/^'|'$/g, '')),
    )
    .filter((name) => /^[a-zA-Z][\w-]*$/.test(name));
  const htmlClasses = new Set([...staticClasses, ...dynamicClasses]);
  const cssClasses = new Set([...allCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]));
  const unstyled = [...htmlClasses].filter((name) => !cssClasses.has(name));
  check(
    '样式：标记用到的 class 都有对应样式（HTML + .vue，两层样式表都算）',
    unstyled.length === 0,
    unstyled.length ? `未定义样式 ${unstyled.join(', ')}` : `${htmlClasses.size} 个 class`,
  );

  // t48 样式分层。判据是"这个 class 只有这一页在用"，搬走的必须是私有的：
  //   - 搬进组件后**全局表里不许再有一份** —— 两份定义谁生效要看谁更具体（scoped 会 +1 个属性
  //     选择器），正是分层想消灭的那种推理；
  //   - 跨组件的共享件（`.check` 被 5 处画、`.panel-block > .hint` 多处用）**必须留在全局表**，
  //     否则搬进某一个组件后，别的页面就没有这条样式了。
  // 查"规则在不在"要先剥注释：两张表里都有解释性注释点名这些 class（"设置页那一族（.settings…）"），
  // 拿原文去 match 会把注释当成定义 —— 这正是这类检查最容易骗过自己的地方。
  const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const readScoped = (file: string): string => {
    const text = fs.readFileSync(path.join(rendererDir, 'panes', file), 'utf8');
    const body = text.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? '';
    return body.replace(/\/\*[\s\S]*?\*\//g, '');
  };
  // 改一页就往这张表里加一行。它同时守住三件事：
  //   ① 搬走的私有规则**不许在全局表里留第二份**；② `staysGlobal` 的共享件**不许被搬走**；
  //   ③ 组件里**真有**那些规则 —— 别只删不加。
  const styleLayers: { pane: string; scoped: string[]; staysGlobal: string[] }[] = [
    {
      pane: 'SettingsPane.vue',
      scoped: [
        '.settings',
        '.form-row',
        '.input-suffix',
        '.update-head',
        '.update-title',
        '.update-phase',
        '.update-progress',
        '.update-bar',
        '.spotlight',
      ],
      // 设置页画了、但是多页共用的：复选框行（5 处）、卡片后面那句提示（多处）
      staysGlobal: ['.check', '.panel-block > .hint'],
    },
    {
      pane: 'ArchivePane.vue',
      scoped: [
        '.archive',
        '.archive-body',
        '.archive-search-input',
        '.archive-item',
        '.archive-turn-body',
        '.archive-empty',
      ],
      staysGlobal: [],
    },
  ];
  const layerProblems: string[] = [];
  for (const row of styleLayers) {
    const scopedRules = readScoped(row.pane);
    for (const sel of row.scoped) {
      const pattern = new RegExp(`\\${sel}(?![\\w-])`);
      if (pattern.test(cssRules)) layerProblems.push(`${row.pane}: ${sel} 还在全局表里`);
      if (!pattern.test(scopedRules)) layerProblems.push(`${row.pane}: 组件里缺 ${sel}`);
    }
    for (const sel of row.staysGlobal) {
      const pattern = new RegExp(`\\${sel}(?![\\w-])`);
      if (!pattern.test(cssRules)) layerProblems.push(`${row.pane}: 共享件 ${sel} 没留在全局表`);
      if (pattern.test(scopedRules)) layerProblems.push(`${row.pane}: 共享件 ${sel} 被搬进组件了`);
    }
  }
  // v-html 渲染出来的元素没有 scope 属性，`.archive-turn-body <元素>` 必须写成 `:deep(...)`。
  // **多行选择器列表踩过**：`.archive-turn-body h1,\n h2,\n h3 { }` 只给最后一行加了 :deep()，
  // 前几行会编译成 `.archive-turn-body h2[data-v-x]` —— 一条都匹配不上（h2..h5、ul 就是这么漏的，
  // 靠"看构建产物里的选择器"才抓到）。`(?!\{)` 是因为 `.archive-turn-body {` 本来就该是普通写法。
  const archiveRules = readScoped('ArchivePane.vue');
  const deepLeaks = archiveRules
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\.archive-turn-body\s+(?!\{)\S/.test(line) && !line.includes(':deep('));
  check(
    '样式分层：页面私有的规则搬进组件的 <style scoped>，共享件留在全局表（v-html 内容走 :deep）',
    layerProblems.length === 0 &&
      styleLayers.every((row) => readScoped(row.pane).length > 200) &&
      /\.archive-turn-body :deep\(/.test(archiveRules) &&
      deepLeaks.length === 0,
    layerProblems.length || deepLeaks.length
      ? [...layerProblems, ...deepLeaks.map((l) => `漏了 :deep：${l}`)].join('；')
      : `${styleLayers.length} 个页面、${styleLayers.reduce((n, r) => n + r.scoped.length, 0)} 条私有规则`,
  );

  check(
    '主题：终端两套配色都在（xterm 不走 CSS）',
    /TERM_THEMES[^=]*=\s*\{[\s\S]*?dark:\s*\{[\s\S]*?light:\s*\{/.test(rendererJs),
  );
  check('主题：设置里有 themeMode 默认值', DEFAULTS.themeMode === 'system');
  check(
    '主题：左下角开关与设置项都存在',
    markup.includes('id="theme-switch"') && markup.includes('id="s-themeMode"'),
    '开关在 shell/RailNav.vue，主题下拉框在 panes/SettingsPane.vue',
  );

  // 启动锁必须是单向状态机（idle → waiting → done）。
  // 早期版本用布尔量 + 每次状态变化重新判定，结果解锁后只要条件又变回不满足
  // （用户手动退出全屏就会），锁会重新扣上来。这几条检查就是防它回归。
  const armCalls = (rendererJs.match(/setBootLock\(true\)/g) || []).length;
  check(
    '启动锁：只在一处上锁（idle → waiting）',
    armCalls === 1,
    `${armCalls} 处 setBootLock(true)`,
  );
  check('启动锁：解锁写入 done，不可逆', /bootLockState = 'done'/.test(rendererJs));
  check('启动锁：done 之后直接返回', /if \(bootLockState === 'done'\) return/.test(rendererJs));
  // t44（冻结 §0.4 的 R-32）：向导结束后的自动启动那一次也要上锁，但**不许**改成可重入 ——
  // 只加一个显式的第二回合；回合带 5 秒窗口，且只有放行页那条路开回合（逃生口不上锁）。
  // 计数与切片都先剥掉注释（注释里也会提到这些名字）。
  const bootLockCode = rendererJs.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const armAfterGateBody =
    bootLockCode.match(/function armAfterGate\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
  const gateAutoStartBody =
    bootLockCode.match(/function wireGateAutoStart\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
  const idleWrites = (bootLockCode.match(/bootLockState = 'idle';/g) || []).length;
  // t46 起"开回合"这件事收进了一个 `armEpisode()`：第二回合（向导之后）与第三回合（重启之后）
  // 都只委托给它，不许各自复制一遍体。5 秒窗口、"没有等待就不上锁"、不自己调 setBootLock
  // 这三条仍然逐字成立 —— 只是从 armAfterGate 挪到了 armEpisode。
  const armEpisodeBody = bootLockCode.match(/function armEpisode\([\s\S]*?\n\}/)?.[0] ?? '';
  const armAfterRestartBody =
    bootLockCode.match(/function armAfterRestart\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
  check(
    '启动锁：向导之后的自动启动是"显式开的一个回合"（只委托给 armEpisode、带 5 秒窗口、自己不调 setBootLock）',
    armEpisodeBody.length > 200 &&
      armAfterGateBody.length > 60 &&
      /armEpisode\('afterGate'\);/.test(armAfterGateBody) &&
      /bootLockEpisode = episode;/.test(armEpisodeBody) &&
      /bootLockState = 'idle';/.test(armEpisodeBody) &&
      /GATE_ARM_WINDOW_MS/.test(armEpisodeBody) &&
      /if \(bootLockState === 'idle'\) bootLockState = 'done';/.test(armEpisodeBody) &&
      // 写 idle 的地方只有两处：声明那一行 + armEpisode。上锁本身仍然只有一处（idle → waiting）
      idleWrites === 1 &&
      /let bootLockState: BootLockState = 'idle';/.test(bootLockCode) &&
      !/setBootLock\(/.test(armEpisodeBody) &&
      !/setBootLock\(/.test(armAfterGateBody),
    `${idleWrites} 处 bootLockState = 'idle';`,
  );
  // t46：第三个回合（点了「重启 dsh」之后）。同样只委托给 armEpisode；锁文案按回合分开 ——
  // 重启那一轮不抢屏（规格 §1 的 4A），所以它的 note 不许提全屏。
  const lockCopyBody = bootLockCode.match(/const LOCK_COPY[\s\S]*?\n\};/)?.[0] ?? '';
  check(
    '启动锁：重启 dsh 之后是第三个回合（afterRestart），锁文案按回合分开、重启那轮不提全屏',
    armAfterRestartBody.length > 40 &&
      /armEpisode\('afterRestart', RESTART_ARM_WINDOW_MS\);/.test(armAfterRestartBody) &&
      // 重启要先把旧实例停掉、等端口释放（最长 10 秒），所以窗口比 R-32 那个长
      /const RESTART_ARM_WINDOW_MS = 20000;/.test(bootLockCode) &&
      // 中间相位（stopping / stopped）不许把这一回合收掉 —— 它的过期只由窗口定时器管
      /if \(bootLockEpisode !== 'afterRestart'\) bootLockState = 'done';/.test(bootLockCode) &&
      // 与第二回合不同：重启可能来第二次，所以**不带**幂等守卫
      !/bootLockEpisode === 'afterRestart'\) return/.test(armAfterRestartBody) &&
      ['startup', 'afterGate', 'afterRestart'].every((key) =>
        new RegExp(`${key}: \\{`).test(lockCopyBody),
      ) &&
      /afterRestart: \{[^}]*noteTail: '就绪后自动打开 DeepSeek Harness'/.test(lockCopyBody) &&
      !/afterRestart: \{[^}]*全屏/.test(lockCopyBody) &&
      (lockCopyBody.match(/并进入全屏/g) || []).length === 2,
  );
  // t46：就绪判据是**纯函数**，直接喂相位试 —— 只看 running 会切到"还没捕获到令牌"那一屏
  check(
    '重启后进 Harness：就绪判据 = 看见旧实例停过 + running + 已拿到带令牌地址（只看 running 会切到 401，立意图当场就判成到了）',
    restartNav.isRestartReady('running', 'http://127.0.0.1:3080/?token=abc') &&
      !restartNav.isRestartReady('running', null) &&
      !restartNav.isRestartReady('running', undefined) &&
      !restartNav.isRestartReady('starting', 'http://127.0.0.1:3080/?token=abc') &&
      // 真机踩到的那条：点下去那一刻旧实例还是 running + 带着旧令牌，**不许**当场判成"到了"
      !restartNav.restartArrived(
        {
          reason: 'plugin',
          outcome: 'pending',
          startedAt: 0,
          error: null,
          leftRunning: false,
          sawStarting: false,
          uiUrlAtBegin: 'http://127.0.0.1:3080/?token=old',
        },
        'running',
        'http://127.0.0.1:3080/?token=old',
      ) &&
      // 看见它停过之后（leftRunning）才算到
      restartNav.restartArrived(
        {
          reason: 'plugin',
          outcome: 'pending',
          startedAt: 0,
          error: null,
          leftRunning: true,
          sawStarting: true,
          uiUrlAtBegin: 'http://127.0.0.1:3080/?token=old',
        },
        'running',
        'http://127.0.0.1:3080/?token=new',
      ) &&
      // 万一没看见中间相位（快得不给观察机会）：令牌换了也算到（令牌是每进程随机的）
      restartNav.restartArrived(
        {
          reason: 'plugin',
          outcome: 'pending',
          startedAt: 0,
          error: null,
          leftRunning: false,
          sawStarting: false,
          uiUrlAtBegin: 'http://127.0.0.1:3080/?token=old',
        },
        'running',
        'http://127.0.0.1:3080/?token=new',
      ) &&
      // "起不来"也要先看见它 starting 过：重启必然经过 stopped，那一段不是失败（真机踩到过）
      !restartNav.restartStalled(
        {
          reason: 'plugin',
          outcome: 'pending',
          startedAt: 0,
          error: null,
          leftRunning: true,
          sawStarting: false,
          uiUrlAtBegin: null,
        },
        'stopped',
      ) &&
      restartNav.restartStalled(
        {
          reason: 'plugin',
          outcome: 'pending',
          startedAt: 0,
          error: null,
          leftRunning: true,
          sawStarting: true,
          uiUrlAtBegin: null,
        },
        'stopped',
      ) &&
      // "起不来"的三个终态：stopping / starting 还在路上，不算
      restartNav.isRestartStalled('stopped') &&
      restartNav.isRestartStalled('degraded') &&
      restartNav.isRestartStalled('conflict') &&
      !restartNav.isRestartStalled('starting') &&
      !restartNav.isRestartStalled('stopping') &&
      !restartNav.isRestartStalled('running') &&
      // 四个入口的文案各自不同（状态栏那句与到达提示都要能对上）
      new Set(
        (['plugin', 'dashboard', 'env', 'ui'] as const).map((reason) =>
          restartNav.readyMessage(reason),
        ),
      ).size === 4,
  );
  // t46：意图必须在调 restart 之前立 —— `start()` 一 spawn 就返回，晚立就错过那 5 秒上锁窗口
  const restartFlowSource = fs.readFileSync(
    path.join(rendererDir, 'lib', 'restart-flow.ts'),
    'utf8',
  );
  const restartFlowBody =
    restartFlowSource
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/export async function restartThenOpenHarness\([\s\S]*?\n\}/)?.[0] ?? '';
  check(
    '重启后进 Harness：意图在调用重启之前立（start 一 spawn 就返回，晚立就错过上锁窗口）',
    restartFlowBody.length > 200 &&
      // 立意图时把"当时的带令牌地址"一起带上（用来判断令牌到底换没换）
      /beginRestartNav\(reason, getDsh\(\)\?\.uiUrl \?\? null\)/.test(restartFlowBody) &&
      restartFlowBody.indexOf('beginRestartNav(reason') > 0 &&
      restartFlowBody.indexOf('beginRestartNav(reason') <
        restartFlowBody.indexOf("mode === 'start'") &&
      // 失败与"用户取消"分开处理：取消不该在界面上说成"重启失败"
      /if \(result\.cancelled\) clearRestartNav\(\)/.test(restartFlowBody) &&
      /else if \(!result\.ok\) settleRestartNav\('failed'/.test(restartFlowBody) &&
      // 编排这一层不许自己 setBootLock / 不许自己切页 —— 那是 app.ts 的事
      !/setBootLock\(|currentTab\.value =/.test(restartFlowBody),
  );
  // t46：四个入口共用同一条流程（规格 §1 的 3B + "顺带的第四处"）
  const entryFiles = ['PluginPane', 'DashboardPane', 'EnvPane', 'UiPane'];
  const entryMissing = entryFiles.filter(
    (name) =>
      !new RegExp(
        `restartThenOpenHarness\\(api, \\(\\) => dsh\\.value, '(plugin|dashboard|env|ui)'`,
      ).test(fs.readFileSync(path.join(rendererDir, 'panes', `${name}.vue`), 'utf8')),
  );
  check(
    '重启后进 Harness：四个入口都走同一条流程（插件页 / 控制台 / 环境自检 / 重启为受管实例）',
    entryMissing.length === 0 &&
      // 页面里不许再有人自己调 restartFlow —— 那条路已经收进编排层 lib/restart-flow.ts
      // （编排层自己当然要用它，所以这里只查四个页面，不查 rendererCode 合集）
      !entryFiles.some((name) =>
        /restartFlow\(/.test(
          fs.readFileSync(path.join(rendererDir, 'panes', `${name}.vue`), 'utf8'),
        ),
      ) &&
      /restartThenOpenHarness/.test(rendererCode),
    entryMissing.length ? `缺：${entryMissing.join(', ')}` : `${entryFiles.length} 个入口`,
  );
  // t46：这两份源码要用在下面几条钉子里（黄条四态、到达提示）。`uiPaneSource` 后面第 12 节
  // 还要再用一次，所以在这儿声明一次就够（放在它们之前，别在下面重复声明）。
  const mergedPluginSource = fs.readFileSync(
    path.join(rendererDir, 'panes', 'PluginPane.vue'),
    'utf8',
  );
  const uiPaneSource = fs.readFileSync(path.join(rendererDir, 'panes', 'UiPane.vue'), 'utf8');
  const restartNavCode = fs.readFileSync(path.join(rendererDir, 'lib', 'restart-nav.ts'), 'utf8');
  const topBarSource = fs.readFileSync(path.join(rendererDir, 'shell', 'TopBar.vue'), 'utf8');
  const stylesCode = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  // t46：黄条的四态 + Harness 页那条到达提示（可关闭）
  check(
    '重启后进 Harness：新一轮开始时收掉上一条到达提示（它说的是"上一轮已生效"）',
    /harnessArrivalNotice\.value = null;/.test(
      fs.readFileSync(path.join(rendererDir, 'lib', 'restart-nav.ts'), 'utf8'),
    ) &&
      restartNav.beginRestartNav('plugin') === undefined &&
      restartNav.restartNav.value.outcome === 'pending' &&
      restartNav.harnessArrivalNotice.value === null,
  );
  // 黄条那两条规则的原文（按行取整段，避免 `[\s\S]*?` 跨到别的规则里去）
  const bannerBlock = stylesCode.match(/^\.banner \{[\s\S]*?^\}/m)?.[0] ?? '';
  const bannerIconBlock = stylesCode.match(/^\.banner \.i \{[\s\S]*?^\}/m)?.[0] ?? '';
  check(
    '重启后进 Harness：黄条有进行中 / 失败 / 未就绪 / 已生效四态，到达提示走顶栏那格已有的信息位（方案 A）',
    ['pending', 'failed', 'unready', 'external', 'escaped', 'ready'].every((state) =>
      new RegExp(`case '${state}':`).test(mergedPluginSource),
    ) &&
      /id="plugin-restart-line"/.test(mergedPluginSource) &&
      /id="btn-plugin-restart"/.test(mergedPluginSource) &&
      /:disabled="navPending"/.test(mergedPluginSource) &&
      // 到达提示 = 工具栏右端那条**已有**的状态槽亮一下（方案 A，见 docs/harness-arrival-design.html）：
      // 用户先否了"可关闭的常驻横条"（"给个轻提示就可以了"），又否了"浮在正文上的胶囊"
      // （"不好看，你学一下UI设计呗"）—— 所以既不新增表面、也不遮内容、也没有按钮。
      // 那一格是**顶栏**右侧的上下文信息（`#topbar-note`）——它窗口模式与全屏模式都在，
      // 而 Harness 页工具条右端那格在应用内全屏时整条被藏起来。
      /id="topbar-note"/.test(topBarSource) &&
      /harnessArrivalNotice\.value \|\| contextNote\.value/.test(topBarSource) &&
      /:class="\{ lit: harnessArrivalNotice \}"/.test(topBarSource) &&
      /import \{ harnessArrivalNotice \} from '\.\.\/lib\/restart-nav\.js';/.test(topBarSource) &&
      !/harnessArrivalNotice/.test(uiPaneSource) &&
      !/id="ui-arrival"/.test(uiPaneSource) &&
      !/class="toast"/.test(uiPaneSource) &&
      !/btn-ui-arrival-dismiss/.test(uiPaneSource) &&
      !/dismissHarnessArrival/.test(uiPaneSource) &&
      /ARRIVAL_TOAST_MS = 4000/.test(restartNavCode) &&
      /arrivalTimer = setTimeout\(/.test(restartNavCode) &&
      /harnessArrivalNotice\.value = null;\n {2}\}, ARRIVAL_TOAST_MS\);/.test(restartNavCode) &&
      // 文案要短（那一格宽度有限）；长解释留在插件页那条黄条里
      /plugin: '✓ 装配层改动已加载'/.test(restartNavCode) &&
      // 样式：只给状态槽加一层绿色底；浮层/胶囊那套已经删掉
      /\.topbar-note\.lit \{[\s\S]*?color: var\(--run\);[\s\S]*?background: var\(--run-soft\);[\s\S]*?\}/.test(
        stylesCode,
      ) &&
      /\.toast \{/.test(stylesCode) === false &&
      /\.banner\.arrival/.test(stylesCode) === false &&
      // 黄条的竖直居中**不能按"单行 / 两行"分叉**：同一条黄条在宽窗口是一行、窄窗口才是两行，
      // JS 判不出来 —— 老写法用 `line: !!navLine` 挂变体，于是"装/卸/升级"那条默认文案
      // （宽窗口下一行）永远拿不到覆盖，一直是偏上的（用户第二次抓图指出，真机量出来偏上 3.5px）。
      // 现在统一居中：两行时最高的那一项本来就是文本块，居中与顶对齐对它的位置没有影响。
      /align-items: center;/.test(bannerBlock) &&
      /align-items: flex-start;/.test(bannerBlock) === false &&
      bannerIconBlock.length > 0 &&
      /margin-top/.test(bannerIconBlock) === false &&
      /\.banner\.line/.test(stylesCode) === false &&
      // 那条宽度依赖的类在渲染层也不许再出现（注释里留着都会诱导人加回来）
      /banner\.line/.test(vueSource) === false &&
      /line: !!navLine/.test(vueSource) === false &&
      /:class="\{ rose: navOutcome === 'failed' \}"/.test(vueSource),
  );

  // t46：用户在锁上按「不等了」/ Esc 要**取消**这次跳转（唯一会取消的路径，规格 §2.4）
  const userSkipBody =
    bootLockCode.match(/function userSkipBootLock\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
  const wireBootLockBody =
    bootLockCode.match(/function wireBootLock\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
  check(
    '启动锁：锁上的「不等了」/ Esc 取消这一轮跳转（唯一会取消的路径）',
    userSkipBody.length > 80 &&
      /restartNav\.value\.outcome === 'pending'/.test(userSkipBody) &&
      /settleRestartNav\('escaped'\)/.test(userSkipBody) &&
      /releaseBootLock\(\);/.test(userSkipBody) &&
      /userSkipBootLock\(\)/.test(wireBootLockBody) &&
      // Esc 那条路也走它（两处都是"用户说别等了"）
      (bootLockCode.match(/userSkipBootLock\(\)/g) || []).length >= 3,
  );
  check(
    '启动锁：只有放行页那条路开第二回合（逃生口不上锁），且整个运行只试一次',
    gateAutoStartBody.length > 200 &&
      /if \(phase === 'entered'\) armAfterGate\(\);/.test(gateAutoStartBody) &&
      /if \(phase !== 'escaped' && phase !== 'entered'\) return;/.test(gateAutoStartBody) &&
      /if \(gateAutoStartTried\) return;/.test(gateAutoStartBody) &&
      // armAfterGate 只有"定义 + 这一处调用"
      (bootLockCode.match(/armAfterGate\(\)/g) || []).length === 2 &&
      // 上锁那一刻要把窗口定时器收掉（不然它 5 秒后还会去改状态）
      /clearTimeout\(gateArmTimer\)/.test(bootLockCode),
  );

  // 解锁条件里一旦掺进"当前是否全屏"，用户一退全屏就会重新满足上锁条件。
  // 只看代码，不看注释（注释里提到 immersive 是为了解释这个坑）。
  const updateBootLockBody =
    rendererJs.match(/function updateBootLock\([\s\S]*?\n {2}\}/)?.[0] || '';
  const updateBootLockCode = updateBootLockBody
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  check(
    '启动锁：解锁判定不看当前是否全屏',
    updateBootLockBody.length > 0 && !/immersive/.test(updateBootLockCode),
    updateBootLockBody ? `函数体 ${updateBootLockBody.length} 字符` : '没找到 updateBootLock',
  );

  // 锁必须盖满窗口、且盖住顶栏：左栏是贯穿全高的整列、顶栏又在最上面，
  // 留任何一条缝都会露出"DSH Console"品牌或页面标题（两次被用户抓图指出）。
  const cssBlock = (selector: string): string =>
    css.match(
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`),
    )?.[0] || '';
  const lockZ = Number(cssBlock('.boot-lock').match(/z-index:\s*(\d+)/)?.[1] || 0);
  const topbarZ = Number(cssBlock('.topbar').match(/z-index:\s*(\d+)/)?.[1] || 0);
  check('启动锁：盖满窗口（inset: 0）', /inset:\s*0;/.test(cssBlock('.boot-lock')));
  check(
    '启动锁：顶栏也被盖住（没给它更高的 z-index）',
    lockZ > 0 && topbarZ < lockZ,
    `lock=${lockZ} topbar=${topbarZ}`,
  );
  check(
    '渲染层：整块内容区不画焦点环（main 的焦点是程序化交过去的，不是 Tab 来的）',
    (() => {
      const ring = cssBlock(':focus-visible');
      // 控件的焦点环必须原样留着（可达性），只掐掉 main 那一圈 —— 真机上用户报的
      // "多余的框"就是它（CDP 强制 :focus-visible 复现：顶部/左边/下边各一条蓝边）
      return (
        /outline:\s*2px solid var\(--focus\)/.test(ring) &&
        /outline-offset:\s*2px/.test(ring) &&
        /outline:\s*none/.test(cssBlock('main:focus-visible'))
      );
    })(),
    cssBlock('main:focus-visible').replace(/\s+/g, ' ').trim(),
  );

  // ---------------------------------------------------------- 8. 发布：CHANGELOG 与版本号对齐
  //    发版时 Release 正文是按版本号从 CHANGELOG.md 里取的（tools/changelog-extract.mts）。
  //    忘了写条目的话，CI 会红在最后那个 publish job —— 这里提前到构建阶段就拦住，
  //    两个 build job 都会先失败，不会出现"包打好了才发现没说明"。
  const repoRoot = path.join(__dirname, '..');
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as PackageJson;
  // 读不到就给空串：下面的断言会以"缺条目"的形式失败，比在这里抛异常更好读
  const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
  const changelogText = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
  // 动态 import：提取逻辑只此一份，不在自检里再抄一遍正则。
  // 这里写 .mjs（而不是 .mts）：NodeNext 与 tsx 都会把这个标识符解析到同名的 .mts 源码，
  // 而 .mjs 才是"工具最终以 ESM 运行"时它真实的名字。
  const { extractChangelog } = await import('../tools/changelog-extract.mjs');
  const section = extractChangelog(changelogText, pkg.version);
  check(
    `发布：CHANGELOG.md 有当前版本 ${pkg.version} 的条目`,
    Boolean(section && section.trim()),
    section ? section.split('\n')[0] : '缺条目 —— 发版前先在 CHANGELOG.md 里写这一版',
  );

  // ---------------------------------------------------------- 9. 发布片段（changesets）
  //    CHANGELOG 不再手写：每条改动写一个 .changeset/*.md 片段，发版前由 tools/release-prepare.mts
  //    汇总成 `## [x.y.z] - YYYY-MM-DD` 的条目。汇总脚本万一算错版本号或写歪标题，
  //    坏掉的是 Release 正文 —— 所以这里把它的纯函数逐个钉住。
  const releaseTools = await import('../tools/release-prepare.mjs');

  check(
    '发布片段：版本号规则与 changesets 一致（0.2.2 + patch / minor / major）',
    releaseTools.incrementVersion('0.2.2', 'patch') === '0.2.3' &&
      releaseTools.incrementVersion('0.2.2', 'minor') === '0.3.0' &&
      releaseTools.incrementVersion('0.2.2', 'major') === '1.0.0',
  );
  check(
    '发布片段：多个片段时取最高一级',
    releaseTools.pickBump(['patch', 'major', 'minor']) === 'major' &&
      releaseTools.pickBump(['patch', 'patch']) === 'patch',
  );
  const parsedFragment = releaseTools.parseFragment(
    "---\n'dsh-console': minor\n---\n\n### 小节\n\n正文\n",
    'dsh-console',
  );
  check(
    '发布片段：能解析 front matter 与正文（小节结构原样保留）',
    parsedFragment?.type === 'minor' && parsedFragment.body === '### 小节\n\n正文',
  );
  check(
    '发布片段：空片段（changeset add --empty）不算本包的改动',
    releaseTools.parseFragment('---\n---\n', 'dsh-console') === null,
  );
  const releaseEntry = releaseTools.buildEntry('0.2.3', '2026-09-17', [
    { file: 'a.md', type: 'patch', body: '一条改动' },
  ]);
  check(
    '发布片段：条目是 `## [x.y.z] - 日期`（提取脚本认的形状）',
    releaseEntry === '## [0.2.3] - 2026-09-17\n\n一条改动',
    releaseEntry.split('\n')[0],
  );
  const insertedEntry = releaseTools.insertEntry(
    '# Changelog\n\n## [Unreleased]\n\n## [0.2.2] - 2026-09-16\n\n旧条目\n',
    releaseEntry,
  );
  check(
    '发布片段：新条目插在 Unreleased 之后、上一个版本之前',
    insertedEntry.indexOf('## [Unreleased]') < insertedEntry.indexOf('一条改动') &&
      insertedEntry.indexOf('一条改动') < insertedEntry.indexOf('## [0.2.2]'),
  );
  check(
    '发布片段：改版本号只动 "version" 那一行，package.json 其余部分逐字节不变',
    releaseTools.replaceVersion('{\n  "name": "x",\n  "version": "0.2.2"\n}\n', '0.3.0') ===
      '{\n  "name": "x",\n  "version": "0.3.0"\n}\n',
  );
  // 配置里必须留着 changelog: false —— 打开它 changesets 就会自己写 `## x.y.z` 这种
  // 没有方括号与日期的标题，与提取脚本的契约不符（见 tools/release-prepare.mts 顶部说明）。
  const changesetConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, '.changeset/config.json'), 'utf8'),
  ) as { changelog?: unknown; privatePackages?: { version?: unknown } };
  check(
    '发布片段：.changeset/config.json 关掉了 changesets 自带的 CHANGELOG 生成',
    changesetConfig.changelog === false,
    `changelog=${JSON.stringify(changesetConfig.changelog)}`,
  );
  check(
    '发布片段：私有包也要能被改版本号（privatePackages.version）',
    changesetConfig.privatePackages?.version === true,
  );

  // ---------------------------------------------------------- 10. Release 的标题与正文
  //    publish job 用 tools/release-notes.mts 生成标题与正文：标题 = `v<版本>: <主题>`（主题
  //    写在 CHANGELOG 标题行里），正文里的安装表来自**真实产物清单**。这两块最容易在改标题
  //    格式、改产物名、或换 electron-builder 之后悄悄跑偏 —— 而跑偏的代价是发出去的 Release
  //    让人下错文件（v0.2.0 就是说明里让下、页面上没有），所以全部钉住。
  const releaseNotes = await import('../tools/release-notes.mjs');
  const sampleAssets = [
    'DSH.Console.Setup.0.3.0.exe',
    'DSH.Console.0.3.0.exe',
    'DSH.Console-0.3.0-arm64.dmg',
    'DSH.Console-0.3.0.dmg',
    'DSH.Console-0.3.0.zip',
    'DSH.Console.0.3.0.exe.blockmap',
    'latest.yml',
  ];

  check(
    '发布正文：标题 = `v<版本>: <主题>`，主题取自 CHANGELOG 标题行',
    releaseNotes.releaseTitle(
      '0.3.0',
      releaseNotes.extractTopic('## [0.3.0] - 2026-09-17: TypeScript 迁移'),
    ) === 'v0.3.0: TypeScript 迁移',
  );
  check(
    '发布正文：没写主题时标题退化成 v<版本>；早期条目的 `——` 也认',
    releaseNotes.extractTopic('## [0.3.0] - 2026-09-17') === null &&
      releaseNotes.releaseTitle('0.3.0', null) === 'v0.3.0' &&
      releaseNotes.extractTopic('## [0.2.2] - 2026-09-16 —— 归档会话页') === '归档会话页',
  );

  const classified = releaseNotes.classifyAssets(sampleAssets);
  check(
    '发布正文：四类核心产物都认得出来，zip 与更新器元数据分列',
    classified.missing.length === 0 &&
      classified.downloads.length === 5 &&
      classified.metadata.length === 2,
    classified.downloads.map((item: { label: string }) => item.label).join(' / '),
  );
  check(
    '发布正文：缺 Windows 产物时判为"不该发"（v0.2.0 就是缺了这两个）',
    releaseNotes.classifyAssets(['DSH.Console-0.3.0-arm64.dmg', 'DSH.Console-0.3.0.dmg']).missing
      .length === 2,
  );

  const composed = releaseNotes.composeReleaseNotes({
    version: '0.3.0',
    topic: 'TypeScript 迁移',
    entry: '## [0.3.0] - 2026-09-17: TypeScript 迁移\n\n一条改动',
    assets: sampleAssets,
  });
  check(
    '发布正文：H1 写版本与主题、不留重复的二级标题行、安装表点名真实文件',
    composed.startsWith('# DSH Console v0.3.0: TypeScript 迁移') &&
      !composed.includes('## [0.3.0]') &&
      composed.includes('`DSH.Console.Setup.0.3.0.exe`') &&
      composed.includes('## 安装'),
  );
  let assetGateThrew = false;
  try {
    releaseNotes.composeReleaseNotes({
      version: '0.3.0',
      topic: null,
      entry: '## [0.3.0] - 2026-09-17\n\n一条改动',
      assets: ['DSH.Console-0.3.0.dmg'],
    });
  } catch {
    assetGateThrew = true;
  }
  check('发布正文：产物不全时直接抛错，不会默默发出', assetGateThrew);

  // ---------------------------------------------------------- 11. 自动更新契约
  //     electron-updater 接上了 GitHub Releases 的 latest.yml。三条最容易静默失效的边界：
  //     不会偷偷下载 / 偷偷安装；macOS 是 ad-hoc 签名（Squirrel.Mac 会拒绝安装）所以不更新；
  //     开发态没有 app-update.yml 所以连 electron-updater 都不加载。
  const ipcSource = fs.readFileSync(path.join(repoRoot, 'src', 'shared', 'ipc.ts'), 'utf8');
  // 类型声明会被 Prettier 折行，所以先把空白压平再匹配
  const flatIpc = ipcSource.replace(/\s+/g, ' ');
  check(
    '自动更新：契约里有 7 个相位、UpdateState 字段与 4 个 API',
    /export type UpdatePhase = 'idle' \| 'checking' \| 'available' \| 'downloading' \| 'downloaded' \| 'error' \| 'unsupported';/.test(
      flatIpc,
    ) &&
      /export interface UpdateState \{/.test(flatIpc) &&
      /canAutoUpdate: boolean;/.test(flatIpc) &&
      /releasesUrl: string;/.test(flatIpc) &&
      /checkForUpdates: \(\) => Promise<UpdateState>;/.test(flatIpc) &&
      /downloadUpdate: \(\) => Promise<UpdateState>;/.test(flatIpc) &&
      /installUpdate: \(\) => Promise<boolean>;/.test(flatIpc) &&
      /onUpdateState: \(handler: \(state: UpdateState\) => void\) => \(\) => void;/.test(flatIpc),
  );
  check(
    '自动更新：autoCheckUpdates 在契约与 DEFAULTS 两处一致（默认开）',
    /autoCheckUpdates: boolean;/.test(flatIpc) && DEFAULTS.autoCheckUpdates === true,
    `DEFAULTS.autoCheckUpdates=${JSON.stringify(DEFAULTS.autoCheckUpdates)}`,
  );

  const updaterSource = fs.readFileSync(path.join(repoRoot, 'src', 'main', 'updater.ts'), 'utf8');
  // 只看代码不看注释：文件头与行内注释为了解释原因会反复提到这些名字，当真值去查会误报
  const updaterCode = updaterSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check(
    '自动更新：不会偷偷下载 / 偷偷安装（autoDownload 与 autoInstallOnAppQuit 都写死 false）',
    /autoDownload = false/.test(updaterCode) && /autoInstallOnAppQuit = false/.test(updaterCode),
  );
  check(
    '自动更新：macOS 分支存在（ad-hoc 签名 → 能查、不能自动装，引导去下载页）',
    /process\.platform === 'darwin'/.test(updaterCode) &&
      /ad-hoc 签名/.test(updaterCode) &&
      /canAutoUpdate: false/.test(updaterCode) &&
      /canCheck: true/.test(updaterCode) &&
      /releasesUrl/.test(updaterCode),
  );
  check(
    '自动更新：未打包时不加载 electron-updater（没有顶层 import，只按需 require）',
    /!app\.isPackaged/.test(updaterCode) &&
      /开发态不检查更新/.test(updaterCode) &&
      /createRequire/.test(updaterCode) &&
      !/^import\s*\{[^}]*\}\s*from\s*'electron-updater'/m.test(updaterSource),
  );

  // 关闭询问改成渲染层自己画的卡片（shell/CloseDialog.vue）之后，多了两处**只会静默坏掉**的点：
  //   1. 渲染层没接住时必须退回原生弹窗 —— 不然渲染层一卡，窗口就再也关不掉了。
  //      注意**只给握手设时限**：卡片显示出来之后就不能再计时，否则用户多想两秒都会被判成
  //      "卡住"，系统弹窗自己冒出来（第一版就是这么错的）；
  //   2. 真正退出（托盘菜单 / 自动更新的 quitAndInstall / 系统关机）都走 before-quit，
  //      那里**先**置 isQuitting，close 处理器才敢放行 —— 不置位的话「收起」会把退出一起拦下来。
  // 两条都是"只有用户撞上才发现"的类型，所以在这里钉住（同 7.19 的说明）。
  const mainCloseCode = fs
    .readFileSync(path.join(repoRoot, 'src', 'main', 'main.ts'), 'utf8')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  check(
    '关闭询问：只给"卡片显示出来"设时限（用户想多久都行），且真正退出不被拦',
    /const CLOSE_ACK_TIMEOUT_MS = \d+;/.test(mainCloseCode) &&
      /ack: \(\) => clearTimeout\(handshake\)/.test(mainCloseCode) &&
      /sendToRenderer\('app:close-request', null\);/.test(mainCloseCode) &&
      /askCloseActionNative\(\);/.test(mainCloseCode) &&
      /app\.on\('before-quit'[\s\S]{0,200}?isQuitting = true;/.test(mainCloseCode),
  );

  // ---------------------------------------------------------- 10a-2. 外链
  //   真机弹过「DSH Console 出错了（未处理的 Promise 拒绝）：Error: No application found to open URL」：
  //   在内嵌的 DSH 界面里点一个文件引用（`dsh-resource://…`），guest 的 window open handler 把**任何**
  //   URL 都丢给 `shell.openExternal`，而它的返回值被 `void` 丢掉 —— 一次 reject 就顶成全局未处理拒绝。
  //   钉两件事：三处入口（主窗口、内嵌页、渲染层 IPC）共用一个 helper，不再有裸调用；
  //   且 helper 自己既守 scheme 白名单、又接住失败。
  check(
    '外链：三处入口共用一个 helper（scheme 白名单 + 接住 openExternal 的失败）',
    (mainCloseCode.match(/openExternalSafely\(/g) || []).length === 4 && // 定义 1 + 调用 3
      !/void shell\.openExternal\(/.test(mainCloseCode) &&
      !/await shell\.openExternal\(target\)/.test(mainCloseCode) &&
      /const EXTERNAL_URL_SCHEMES = new Set\(\['http:', 'https:', 'mailto:'\]\)/.test(
        mainCloseCode,
      ) &&
      /await shell\.openExternal\(url\);[\s\S]{0,120}?catch/.test(mainCloseCode),
  );

  // ---------------------------------------------------------- 10b. 启动早期：日志与兜底
  //    §7.24 的由来：真机上"双击没反应、过一会系统报崩溃"，而日志里一行都没有 —— 分不清
  //    "进程没起来"和"起来了但没到 ready"。所以钉四件事：ready 之前就落一行启动记录、
  //    拿不到单实例锁时**同步**记一行并立刻退出、未捕获异常落盘并弹带日志路径的框、
  //    以及那个"立刻落盘"的原语真的是同步的（缓冲流那份会被 app.exit 丢掉）。
  //    四条都是静态检查：真机行为要在打包后跑一次（见 §7.24「哪条自检守着」）。
  check(
    '启动早期：ready 之前就落一行启动记录（版本 / 平台 / 是否打包 / userData）',
    /fileLog\.writeLine\(/.test(mainCloseCode) &&
      // 位置即语义：必须在 whenReady 之前
      mainCloseCode.indexOf('fileLog.writeLine(') < mainCloseCode.indexOf('app.whenReady()') &&
      /app\.getVersion\(\)/.test(mainCloseCode) &&
      /process\.platform/.test(mainCloseCode) &&
      /process\.versions\.electron/.test(mainCloseCode),
  );
  check(
    '启动早期：拿不到单实例锁时同步记一行、并立刻 exit（不再留一个没窗口的进程）',
    /if \(!gotLock\) \{[\s\S]{0,400}?fileLog\.writeLine\(/.test(mainCloseCode) &&
      /if \(!gotLock\) \{[\s\S]{0,700}?app\.exit\(0\);/.test(mainCloseCode) &&
      // 这一条正是修掉的那个坑：ready 之前 quit 不保证真的退（会变成"没有响应"）。
      // 窗口收紧到 300：再往后就是 window-all-closed 里那个**正当**的 app.quit()
      !/if \(!gotLock\) \{[\s\S]{0,300}?app\.quit\(\)/.test(mainCloseCode),
  );
  check(
    '启动早期：未捕获异常 / 未处理的 Promise 拒绝都落盘，并弹带日志路径的框',
    /process\.on\('uncaughtException'/.test(mainCloseCode) &&
      /process\.on\('unhandledRejection'/.test(mainCloseCode) &&
      // showErrorBox 是官方文档写明"可以在 ready 之前安全调用"的那个 API
      /dialog\.showErrorBox\([\s\S]{0,120}?describeValue\(value\)/.test(mainCloseCode) &&
      /日志文件（把下面这段内容发出来就能定位）/.test(mainCloseCode) &&
      // 记录之后不退出（与 Electron 默认行为一致：硬退会把"还能用一半"变成"完全不能用"）
      !/uncaughtException'[\s\S]{0,500}?process\.exit\(/.test(mainCloseCode),
  );
  const loggerCode = fs
    .readFileSync(path.join(repoRoot, 'src', 'main', 'logger.ts'), 'utf8')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  check(
    '启动早期：writeLine 是同步落盘、没文件时仍打到终端，且日志流出错不带走主进程',
    /writeLine: \(line: string\) => void;/.test(loggerCode) &&
      /appendFileSync\(file/.test(loggerCode) &&
      // 日志文件没建成时不能静默：至少保持"这一行看得见"
      /file: '', writeLine: \(line: string\) => console\.log\(line\)/.test(loggerCode) &&
      // WriteStream 的 error 没人接 = 未捕获异常（实测：删掉日志目录，整个 node 进程当场退出）
      /stream\.on\('error'/.test(loggerCode) &&
      /streamAlive = false;/.test(loggerCode) &&
      /if \(!streamAlive\) return;/.test(loggerCode),
  );

  // ---------------------------------------------------------- 11. 产物命名与更新源
  //    electron-updater 按 latest.yml / latest-mac.yml 里的文件名去 Releases 下载。名字一旦对不上
  //    就是"能检查到新版本、下载 404"。而 productName 里带空格时三个阶段会各改一次（磁盘保留空格、
  //    yml 变 -、GitHub 资产变 .），所以在 build 配置里给每个 target 写死 artifactName 是硬约定。
  const buildConfig = (
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      build: Record<string, { artifactName?: string }>;
    }
  ).build;
  const artifactNames = ['nsis', 'portable', 'mac', 'dmg'].map(
    (target) => buildConfig[target]?.artifactName ?? '',
  );
  check(
    '产物命名：四个 target 都写死了 artifactName，且里面没有空格',
    artifactNames.every((name) => name.length > 0 && !/\s/.test(name)),
    artifactNames.join(' | '),
  );
  check(
    '产物命名：macOS 的 dmg 与 zip 同名基底（同一个 mac.artifactName / dmg.artifactName 模板）',
    buildConfig.dmg?.artifactName === buildConfig.mac?.artifactName,
    `dmg=${buildConfig.dmg?.artifactName} mac=${buildConfig.mac?.artifactName}`,
  );

  // ---------------------------------------------------------- 12. 自动全屏的前提
  //    应用内全屏是"为内嵌 DSH 界面让出整屏"。外部实例拿不到令牌时这一页只有一段说明，
  //    为它收起左栏与底栏没有意义 —— 用户点开 Harness 页莫名全屏就是这个问题。
  const storeSource = fs.readFileSync(path.join(rendererDir, 'lib', 'store.ts'), 'utf8');
  const codeOf = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  const uiPaneCode = codeOf(uiPaneSource);
  const storeCode = codeOf(storeSource);
  const appCode = codeOf(rendererJs);

  check(
    '自动全屏：store 用 uiLoadable 表达"内嵌界面可用或即将可用"（令牌在或本应用启动）',
    /export const uiLoadable = computed\(\(\) => Boolean\(dsh\.value\?\.uiUrl\) \|\| owned\.value\)/.test(
      storeCode,
    ),
  );
  check(
    '自动全屏：切到 Harness 页时先看界面能不能用，再看设置（外部实例没令牌不自动全屏）',
    /function maybeAutoFullscreen\(\)[\s\S]*?!uiLoadable\.value && !pastedUrl\.value[\s\S]*?return/.test(
      uiPaneCode,
    ) && /settings\.value\.uiFullscreenOnStart/.test(uiPaneCode),
  );
  check(
    '自动全屏：启动时自动打开那条路同样要求 uiLoadable',
    /settings\.value\.uiFullscreenOnStart && uiLoadable\.value/.test(appCode),
  );

  // ---------------------------------------------------------- 13. macOS 的版本检查
  //    macOS 装不了自动更新（ad-hoc 签名），但**照样要知道有没有新版本** —— 主进程直接取
  //    `releases/latest/download/latest-mac.yml` 比版本号，不碰 Squirrel。这几条钉住：
  //    契约里有 canCheck、macOS 分支会去查、比较函数正确、更新源地址与 build.publish 一致。
  const publishConfig = (
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      build?: { publish?: { owner?: string; repo?: string }[] };
    }
  ).build?.publish?.[0];

  check(
    'macOS 更新：契约里有 canCheck（"能不能查"与"能不能装"分开）',
    /canCheck: boolean;/.test(flatIpc) && /canCheck: true/.test(updaterSource),
  );
  check(
    'macOS 更新：darwin 分支会去查 latest-mac.yml（不加载 electron-updater）',
    /process\.platform === 'darwin'/.test(updaterSource) &&
      /checkFeedVersion/.test(updaterSource) &&
      /latest\/download\/latest-mac\.yml/.test(ipcSource) &&
      /compareVersions\(latest, current\) > 0/.test(updaterSource),
  );
  check(
    'macOS 更新：更新源地址与 package.json 的 build.publish 是同一个人/仓库',
    Boolean(publishConfig?.owner) &&
      RELEASES_URL.includes(`github.com/${publishConfig?.owner}/${publishConfig?.repo}`) &&
      UPDATE_MAC_FEED_URL.includes(`github.com/${publishConfig?.owner}/${publishConfig?.repo}`),
    `${publishConfig?.owner}/${publishConfig?.repo}`,
  );
  const { compareVersions, parseFeedVersion } = await import('../src/main/updater.js');
  check(
    'macOS 更新：版本比较与 yml 解析都对（0.4.2 > 0.4.1、后缀按同版本、坏数据返回 null）',
    compareVersions('0.4.2', '0.4.1') > 0 &&
      compareVersions('0.4.1', '0.4.1') === 0 &&
      compareVersions('0.10.0', '0.9.9') > 0 &&
      compareVersions('0.4.1-beta.1', '0.4.1') === 0 &&
      parseFeedVersion('version: 0.4.2\nfiles:\n') === '0.4.2' &&
      parseFeedVersion('files:\n') === null,
  );

  // ---------------------------------------------------------- 14. 依赖归属与包体积
  //    渲染层依赖（vue / @xterm / @fontsource）会被 Vite 打进 dist/renderer；如果它们还挂在
  //    dependencies 里，electron-builder 会**再拷一份**进 app.asar —— 实测让 asar 从 2.1 MB 涨到
  //    20.2 MB、未压缩的 .app 从 289 MB 涨到 306 MB。规则：dependencies 只放主进程运行时真的要
  //    require 的包（现在是 node-pty 与 electron-updater），其余一律 devDependencies。
  const pkgAll = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const prodDeps = Object.keys(pkgAll.dependencies ?? {});
  const devDeps = pkgAll.devDependencies ?? {};
  /** 主进程/preload 的源码（含 shared：它只放类型，但一起查没坏处） */
  const mainSideCode = [
    ...fs
      .readdirSync(path.join(repoRoot, 'src', 'main'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => fs.readFileSync(path.join(repoRoot, 'src', 'main', file), 'utf8')),
    fs.readFileSync(path.join(repoRoot, 'src', 'preload', 'preload.ts'), 'utf8'),
  ]
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*/gm, '');
  const usedByMain = (name: string): boolean =>
    mainSideCode.includes(`from '${name}'`) ||
    mainSideCode.includes(`require('${name}')`) ||
    mainSideCode.includes(`import('${name}')`);

  check(
    '打包：每个生产依赖都真的被主进程 require（不然它会白白多进一份到 app.asar）',
    prodDeps.length > 0 && prodDeps.every(usedByMain),
    prodDeps.map((name) => `${name}${usedByMain(name) ? '' : '（主进程没用到）'}`).join(' / '),
  );
  check(
    '打包：渲染层依赖在 devDependencies 而不是 dependencies（Vite 已经把它们打进 dist）',
    ['vue', '@xterm/xterm', '@fontsource/ibm-plex-sans', '@fontsource/ibm-plex-mono'].every(
      (name) => name in devDeps && !prodDeps.includes(name),
    ),
    prodDeps.join(' / '),
  );

  // ---------------------------------------------------------- 15. 更新卡片的"分平台"契约
  //    只钉**结构**：说明行必须由 canAutoUpdate 分支决定（Windows 才承诺下载/安装，macOS 上
  //    根本没这两件事 —— 写死成 Windows 那套时用户看截图指出了这个错）。
  //
  //    具体的措辞与排版**不在这里钉**：那是外观，改动频繁，钉字面量只会让"润色一句话就得改断言"
  //    （判据见 AGENTS「为什么这些检查放在自检里」）。渲染出来的每个相位的文案由本地冒烟脚本
  //    打印出来给人看，那里也会量"按钮在标题行里"这类布局。
  const settingsSource = fs.readFileSync(
    path.join(rendererDir, 'panes', 'SettingsPane.vue'),
    'utf8',
  );
  check(
    '更新卡片：说明行由 canAutoUpdate 分支决定（Windows 才承诺下载/安装）',
    /const updateNote = computed[\s\S]{0,400}?update\.value\.canAutoUpdate/.test(settingsSource),
  );
  check(
    '设置页：保存被主进程拒了会说出来（不能显示"已保存"）',
    /catch \(cause\)[\s\S]{0,300}?flash\(/.test(settingsSource),
  );
  check(
    '设置页：表单字段都在设置契约里（键名写错只会静默不生效，看不出来）',
    (() => {
      const block = /const form = reactive\(\{([\s\S]*?)\n\}\)/.exec(settingsSource)?.[1] ?? '';
      const keys = [...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
      return keys.length >= 15 && keys.every((key) => key in DEFAULTS);
    })(),
  );

  // ---------------------------------------------------------- 16. 插件装配层（只读）
  //    这一层全靠"别人写的文件 + 别人打印的文本"：profile 的 package.json 与
  //    `dsh web --dump-config` 的 stdout/stderr。夹具是**真实输出**（本机 web profile），
  //    所以上游改格式时这里第一时间变红，而不是等到用户发现层栈是空的。
  //
  //    钉的都是"回退了会静默坏掉"的东西：
  //      - 空输出被当成成功（旧 Node 上 dsh 就是退出码 0 + 零输出）→ 会显示成"没有插件"；
  //      - 未匹配的 patch 行来自 stderr（不在 dump 里）→ 漏读就等于丢掉唯一的告警；
  //      - 层归因（`patched by`）解析错 → 用户会以为自己的层生效了；
  //      - 把 profile 写成 desktop（CLI 保留给 Electron，直接报错）。
  const pluginSource = fs.readFileSync(path.join(srcDir, 'main', 'plugin-manager.ts'), 'utf8');
  const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

  const realDump = fixture('dump-config-web.txt');
  const dumpLayers = pluginManager.parseDump(realDump);
  const dumpedEntries = dumpLayers.reduce((sum, layer) => sum + layer.entries.length, 0);
  const patchedEntries = dumpLayers
    .filter((layer) => layer.patchedBy !== null)
    .reduce((sum, layer) => sum + layer.entries.length, 0);
  check(
    '插件：真实 dump 解析出层归因与全部条目（patched by 要拆开）',
    dumpedEntries === 152 &&
      patchedEntries === 25 &&
      dumpLayers.some((layer) => layer.source === '@deepseek-ai/dsh-base') &&
      dumpLayers.some((layer) => layer.patchedBy === '@deepseek-ai/dsh-web-app'),
    `${dumpedEntries} 条 / 被覆盖 ${patchedEntries} 条 / ${dumpLayers.length} 个层段`,
  );
  check(
    '插件：同一条目被覆盖时能看出是"被禁用"还是"config 被替换"',
    (() => {
      const patched = dumpLayers
        .filter((layer) => layer.patchedBy !== null)
        .flatMap((layer) => layer.entries);
      const disabled = patched.filter((entry) => entry.disabled).length;
      const withConfig = patched.filter((entry) => entry.hasConfig).length;
      // 真实数据：25 条被覆盖里 23 条是"关掉"，12 条替换了 config（有重叠）
      return disabled === 23 && withConfig === 12;
    })(),
  );
  check(
    '插件：未匹配的 patch 行只在 stderr 上，解析成 unmatched-patch 并带出条目 id',
    (() => {
      const problems = pluginManager.parseProblems(fixture('unmatched-patch.stderr.txt'));
      const hit = problems.find((item) => item.kind === 'unmatched-patch');
      return (
        Boolean(hit) &&
        hit?.entryId === '这个条目不存在' &&
        Boolean(hit?.file?.endsWith('cordis.patch.yml'))
      );
    })(),
  );
  check(
    '插件：巡检里"指向了不存在的 id"只有本页能改的那份层才给动作（机器级那层不给）',
    (() => {
      const text = fixture('unmatched-patch.stderr.txt');
      // 夹具里 dsh 打的就是它自己那份 profile 层的真实全路径 —— 拿它当 ownPatchFile，
      // 应当判成"能改"（这条同时钉住路径比较不被真机上的绝对路径绕过去）
      const own = /\[(.+?)\]/.exec(text)?.[1] ?? '';
      const mine = pluginManager.parseProblems(text, own)[0];
      // 同一个文件名、但在别的目录（机器级的 $DSH_HOME/cordis.patch.yml 就是这种）
      const elsewhere = pluginManager.parseProblems(
        text,
        path.join('/tmp', 'other-home', 'profiles', 'web', 'cordis.patch.yml'),
      )[0];
      // 老调用方不传 ownPatchFile：一律不给动作，绝不能默认成"能改"
      const none = pluginManager.parseProblems(text)[0];
      return (
        own.endsWith('cordis.patch.yml') &&
        mine?.kind === 'unmatched-patch' &&
        mine?.entryId === '这个条目不存在' &&
        mine?.editable === true &&
        elsewhere?.editable === false &&
        none?.editable === false
      );
    })(),
  );
  check(
    '插件：patch 解析失败也来自 stderr，归到 parse-error 并点名文件',
    (() => {
      const problems = pluginManager.parseProblems(fixture('broken-patch.stderr.txt'));
      const hit = problems.find((item) => item.kind === 'parse-error');
      return Boolean(hit) && /YAMLException|unexpected end/.test(hit?.detail || '');
    })(),
  );
  check(
    '插件：空输出不算成功；失败时给的是诊断行而不是 Node 的堆栈首行',
    pluginManager.checkDumpResult(0, '', '') !== null &&
      pluginManager.checkDumpResult(0, realDump, '') === null &&
      (() => {
        const why = pluginManager.checkDumpResult(1, '', fixture('broken-patch.stderr.txt'));
        return (
          Boolean(why) && why?.includes('cordis.patch.yml') === true && !why?.includes('file://')
        );
      })(),
  );
  check(
    '插件：真实 profile manifest 读得出 bundles 顺序与 patchReload',
    (() => {
      const manifest = pluginManager.readProfileManifest(
        path.join(__dirname, 'fixtures', 'profile'),
      );
      return (
        manifest.name === 'dsh-profile-web' &&
        manifest.bundles.length === 2 &&
        manifest.bundles[0] === '@deepseek-ai/dsh-base' &&
        manifest.patchReload === 'live' &&
        Object.keys(manifest.dependencies).length === 0
      );
    })(),
  );
  check(
    '插件：装进来却没形成层的依赖、以及什么都没贡献的 bundle 都会被列出来（普通依赖带包名）',
    (() => {
      const plain = pluginManager.plainDependencies(
        {
          name: null,
          dependencies: { 'some-lib': 'link:../lib' },
          bundles: ['@deepseek-ai/dsh-base'],
          patchReload: null,
        },
        path.join(sandbox, '没有这个目录'),
      );
      const missing = pluginManager.missingLayers(
        {
          name: null,
          dependencies: {},
          bundles: ['@deepseek-ai/dsh-base', 'ghost-bundle'],
          patchReload: null,
        },
        dumpLayers,
      );
      return (
        plain.length === 1 &&
        plain[0].kind === 'plain-dependency' &&
        // 包名要单独带出来：界面靠它给「卸掉它」，不解析那句人话
        plain[0].packageName === 'some-lib' &&
        missing.length === 1 &&
        missing[0].kind === 'missing-layer'
      );
    })(),
  );
  // 「临时停用」之后回不去，是因为它掉进了"不形成层"这一档、而那一档只给「卸掉它」。
  // 分档的唯一依据是**包自己有没有声明 dsh.bundle**（读 profile 的 node_modules）：
  // 声明过 = 它本来该形成层、是被人从 bundles 里摘掉的 → 给「放回层里」。
  check(
    '插件：声明过 dsh.bundle 却不在列表里 = 「掉出了层列表」（能放回）；真·普通依赖只能卸',
    (() => {
      const dir = path.join(sandbox, 'plain-deps');
      fs.rmSync(dir, { recursive: true, force: true });
      const writeManifest = (name: string, raw: unknown) => {
        const packageDir = path.join(dir, 'node_modules', name);
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(raw), 'utf8');
      };
      writeManifest('@yozica/dsh-plugin-paths', {
        name: '@yozica/dsh-plugin-paths',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      });
      writeManifest('some-lib', { name: 'some-lib', dsh: { profile: { bundles: [] } } });
      const problems = pluginManager.plainDependencies(
        {
          name: null,
          dependencies: {
            '@yozica/dsh-plugin-paths': 'link:../paths',
            'some-lib': 'link:../lib',
            读不到的包: '^1.0.0',
          },
          bundles: ['@deepseek-ai/dsh-base'],
          patchReload: null,
        },
        dir,
      );
      const suspended = problems.find((item) => item.packageName === '@yozica/dsh-plugin-paths');
      const plain = problems.find((item) => item.packageName === 'some-lib');
      const unreadable = problems.find((item) => item.packageName === '读不到的包');
      return (
        problems.length === 3 &&
        suspended?.kind === 'suspended-bundle' &&
        plain?.kind === 'plain-dependency' &&
        // 没装到 / 读不到 package.json：按"本来就不是 bundle"处理，绝不当成能放回的
        unreadable?.kind === 'plain-dependency' &&
        pluginManager.bundleDeclared({ dsh: { bundle: './cordis.patch.yml' } }) &&
        !pluginManager.bundleDeclared({ dsh: { profile: {} } }) &&
        !pluginManager.bundleDeclared(null)
      );
    })(),
  );
  // 运行中清单：走 dsh 自己的接口（令牌换 cookie → /api/pluginInventory/list）。
  // 这是 rc 版本的内部协议，所以两道保险：真实应答当夹具钉住形状 + 纯函数钉住解析。
  const liveRaw = fixture('plugin-inventory.json');
  const liveValue = pluginManager.unwrapLiveValue(liveRaw);
  const live = pluginManager.summarizeLive(liveValue);
  check(
    '插件：真实应答能解出运行中的条目与预设行数',
    live.entries.length >= 150 &&
      live.presets.find((preset) => preset.id === 'standard')?.rows === 28 &&
      live.counts.total === live.entries.length &&
      live.counts.active > 0 &&
      live.counts.idle > 0,
    `${live.counts.total} 条 · active ${live.counts.active} · 未挂载 ${live.counts.idle} · 预设 ${live.presets.length} 个`,
  );
  check(
    '插件：运行中的 id 带 include: 前缀，剥掉才和配置里的 id 对得上',
    live.entries.some((entry) => entry.entryId.startsWith('include:')) &&
      pluginManager.stripIncludePrefix('include:llm') === 'llm' &&
      pluginManager.stripIncludePrefix('llm') === 'llm' &&
      // 启动时挂的行没有 include: 前缀，id 还是生成的哈希
      live.entries.some((entry) => /^[0-9a-f]{8}$/.test(entry.entryId)) &&
      live.entries.some((entry) => entry.entryId === 'include'),
  );
  check(
    '插件：令牌地址解析（没有令牌、地址不是 URL、空值都要老实返回 null）',
    (() => {
      const ok = pluginManager.parseTokenUrl('http://127.0.0.1:3080/?token=abc123');
      return (
        ok?.origin === 'http://127.0.0.1:3080' &&
        ok?.token === 'abc123' &&
        pluginManager.parseTokenUrl('http://127.0.0.1:3080/') === null &&
        pluginManager.parseTokenUrl('不是 URL') === null &&
        pluginManager.parseTokenUrl('') === null &&
        pluginManager.parseTokenUrl(null) === null
      );
    })(),
  );
  check(
    '插件：调用信封与应答解包（ok:false / 非 JSON / 不是 server-response 都算失败）',
    (() => {
      const envelope = JSON.parse(pluginManager.unaryEnvelope('pluginInventory/list', 'probe')) as {
        type?: string;
        method?: string;
        payload?: { args?: unknown };
      };
      return (
        envelope.type === 'client-request' &&
        envelope.method === 'pluginInventory/list' &&
        envelope.payload?.args !== undefined &&
        pluginManager.unwrapLiveValue(liveRaw) !== null &&
        pluginManager.unwrapLiveValue('{"type":"server-response","result":{"ok":false}}') ===
          null &&
        pluginManager.unwrapLiveValue('不是 JSON') === null &&
        pluginManager.unwrapLiveValue('{"type":"other"}') === null
      );
    })(),
  );

  check(
    '快捷键：TAB_ORDER 与左栏顺序一致（不一致就会"按 7 打开别的页"）',
    (() => {
      const appTs = fs.readFileSync(path.join(rendererDir, 'app.ts'), 'utf8');
      const railVue = fs.readFileSync(path.join(rendererDir, 'shell', 'RailNav.vue'), 'utf8');
      const orderBlock = /TAB_ORDER: TabId\[\] = \[([\s\S]*?)\]/.exec(appTs)?.[1] ?? '';
      const order = [...orderBlock.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
      const rail = [...railVue.matchAll(/\{ id: '([a-z]+)'/g)].map((match) => match[1]);
      // 不比"至少 8 项"：页面数会随左栏增删（t45 就是 9 → 7），"两边逐项一致"才是契约
      return order.length > 0 && order.join() === rail.join();
    })(),
    '左栏顺序 = 快捷键 1..N',
  );

  /**
   * 取 `startPattern` 命中的那个 `<div>` **自己的整段**（按 div 开闭标签配对）。
   * 用来断言"某个东西真的套在这个 div 里"，而不是靠前后顺序猜 —— 纯粹的
   * indexOf 顺序检查抓不到"它跑到那个 div 后面并排站着了"这种错。
   */
  function divBlock(source: string, startPattern: RegExp): string {
    const start = startPattern.exec(source);
    if (!start) return '';
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = start.index;
    let depth = 0;
    for (let match = tags.exec(source); match; match = tags.exec(source)) {
      depth += match[0] === '</div>' ? -1 : 1;
      if (depth === 0) return source.slice(start.index, match.index + match[0].length);
    }
    return '';
  }

  // ── t45：左栏 9 → 7（终端合并、环境自检挪进设置）。四条钉子盯住"合并之后不许两头都在"。
  const railSource = fs.readFileSync(path.join(rendererDir, 'shell', 'RailNav.vue'), 'utf8');
  const railStoreSource = fs.readFileSync(path.join(rendererDir, 'lib', 'store.ts'), 'utf8');
  const appSource = fs.readFileSync(path.join(rendererDir, 'app.ts'), 'utf8');
  const mergedTermSource = fs.readFileSync(
    path.join(rendererDir, 'panes', 'TerminalPane.vue'),
    'utf8',
  );
  const railSettingsSource = fs.readFileSync(
    path.join(rendererDir, 'panes', 'SettingsPane.vue'),
    'utf8',
  );
  const envLayerSource = fs.readFileSync(path.join(rendererDir, 'lib', 'env-layer.ts'), 'utf8');
  const htmlCode = html.replace(/<!--[\s\S]*?-->/g, '');
  const tabIdUnion = /export type TabId =([\s\S]*?);/.exec(railStoreSource)?.[1] ?? '';
  const tabIds = [...tabIdUnion.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
  check(
    '渲染层：左栏七项（TabId 里没有 shell / env，页面容器也没有 pane-shell）',
    tabIds.length === 7 &&
      !tabIds.includes('shell') &&
      !tabIds.includes('env') &&
      !/\{ id: 'shell'/.test(railSource) &&
      !/\{ id: 'env'/.test(railSource) &&
      !/id="pane-shell"/.test(htmlCode) &&
      // 快捷键顺序里也不许再出现这两个 id（不再是"至少 8 项"，这一轮就是 7 项）
      !/TAB_ORDER[\s\S]{0,220}?'(shell|env)'/.test(appSource) &&
      // 快捷键正则也不能再放行 8 / 9
      /\^\[1-7\]\$/.test(fs.readFileSync(path.join(rendererDir, 'lib', 'xterm.ts'), 'utf8')),
    `TabId = ${tabIds.join(', ')}`,
  );
  check(
    '渲染层：环境自检是设置里的详情层（不是页面）',
    /id="env-detail-layer"/.test(htmlCode) &&
      /id="env-root"/.test(htmlCode) &&
      /export function openEnvDetail\(\): void \{/.test(envLayerSource) &&
      /export function closeEnvDetail\(\): void \{/.test(envLayerSource) &&
      /export function closeEnvDetailOnTabChange\(\): void \{/.test(envLayerSource) &&
      // 四个入口都改成打开详情层了，谁都不许再切到 'env'
      !/currentTab\.value = 'env'/.test(rendererCode) &&
      (rendererCode.match(/openEnvDetail\(\)/g) ?? []).length >= 4 &&
      // 切页要收掉这一层，免得盖住用户刚点的那一页
      /closeEnvDetailOnTabChange\(\);/.test(railSource),
  );
  // 详情层必须挂在 <main> 里面：main 是 position: relative，它的 inset: 0 正好是"页面区"。
  // 挂在 .app 外面（body 下）时 inset: 0 是整个窗口 —— 左栏与顶栏一起被吃掉
  // （真机上出现过：点「查看详情」之后左栏整条不见了，EnvPane 自己的步骤栏占着左栏的位置，
  // 看着像左栏变成了向导；只看 open 类的检查全是绿的，因为它确实"打开了"）。
  const mainBlock = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(htmlCode)?.[1] ?? '';
  check(
    '渲染层：环境自检详情层盖的是工作区（挂在 <main> 里，不吃掉左栏与顶栏）',
    /id="env-detail-layer"/.test(mainBlock) &&
      /id="env-root"/.test(mainBlock) &&
      // 类名必须是这一层独有的：`.env-detail` 是 EnvPane 里每行结论下面那串说明文字用的
      // （带 margin 3px 与那套行高），撞上会让整层跟着偏移并继承文字样式（踩过）
      /<div class="env-detail-layer" id="env-detail-layer">/.test(mainBlock) &&
      /\.env-detail-layer \{[^}]*position: absolute/.test(cssText) &&
      /\.env-detail-layer \{[^}]*inset: 0/.test(cssText) &&
      /\.env-detail-layer\.open \{[^}]*display: flex/.test(cssText) &&
      // 前提：左栏与顶栏本来就在 <main> 外面（所以"留在外面"是结构保证的，不靠 z-index 让位）
      /id="rail-root"/.test(htmlCode) &&
      /id="topbar-root"/.test(htmlCode) &&
      !/id="rail-root"/.test(mainBlock) &&
      !/id="topbar-root"/.test(mainBlock) &&
      // 出现且只出现一次（别为了"盖住工作区"再复制一层出来）
      (htmlCode.match(/id="env-detail-layer"/g) ?? []).length === 1,
    mainBlock ? `main 那段 ${mainBlock.split('\n').length} 行` : '找不到 <main>',
  );
  check(
    '渲染层：终端页的会话条第一项固定是 dsh 终端、新建按钮镂空（两路终端在一个页面里）',
    /id="tab-dsh-term"/.test(mergedTermSource) &&
      /activate\(DSH_ID\)/.test(mergedTermSource) &&
      /const DSH_ID = 'dsh';/.test(mergedTermSource) &&
      /<DshTerminal \/>/.test(mergedTermSource) &&
      // 关掉最后一个本地 Shell 要回到 dsh 那一路，不能停在"没有会话"的空屏上
      /activeId\.value = DSH_ID;/.test(mergedTermSource) &&
      // dsh 那一路是子组件：不在挂载清单里，但必须被宿主 import（上面那条通用检查盯着）
      !mountJs.includes("from './panes/DshTerminal.vue'") &&
      // 会话条上的动作是**镂空**的（.btn.outline），实心只留给"当前在看的那一路"：
      // 之前它用 .btn.primary（实心 accent），比选中的标签还抢眼，看不出选中了谁
      /id="btn-new-shell"[\s\S]{0,80}class="btn small outline"/.test(mergedTermSource) &&
      /\.btn\.outline \{[^}]*background: transparent/.test(cssText) &&
      /\.shell-tab\.active \{[^}]*background: var\(--accent-soft\)/.test(cssText),
  );
  // 两路终端都得套在 .term-body 里：它的 inset:0 才是对"会话条下面那块区域"算的。
  // 少了这一层，dsh 那一路会去对整个 .pane 定位 —— 它的状态条（清空显示 / 显示历史 /
  // Ctrl+C）就与会话条叠在同一行（真机上出现过，会话条上的标签和按钮糊成一片）。
  // 而 `.term-host` 的**基础**规则必须留着 relative + flex：dsh 那一路的子组件
  // DshTerminal 自己也用这个类（那是它 `.bar` 下面的 flex 子项）；把基础规则改成绝对
  // 定位，它会铺满整个 `.term-view`、把状态条整行盖掉（踩过 —— 而且 rect 量出来一切
  // 正常，因为元素确实"在"。只有本地 Shell 那一路，直接挂在 `.term-body` 下的那个，
  // 才用 `.term-body > .term-host` 改绝对定位铺满）。
  // 最后两条同样来自踩坑：本地 Shell 那一块是**不透明**的、又排在 .term-view 后面
  // （两者 z-index 都是 auto），dsh 那一路在的时候必须靠 `active` 把它藏起来；
  // 否则它是"遮挡"而不是"重叠"，连重叠面积都量不出来（只有带 z-index 的空状态
  // 能穿出来，看着像状态条凭空消失了）。而"藏"的写法只能是给**不在看的那一路**写
  // hidden —— visibility 会继承，给"在看的那一路"写 visible 就会连 `.pane` 的隐藏
  // 一起穿掉（用户抓图：切到 Harness 页，本地 Shell 的终端还画在上面）。
  const termBodyBlock = divBlock(mergedTermSource, /<div class="term-body">/);
  check(
    '渲染层：两路终端共用 .term-body（dsh 那一路的定位基准不是整个页面）',
    /class="term-view"/.test(termBodyBlock) &&
      /<div class="term-host" :class="\{ active: !dshActive \}" ref="host">/.test(termBodyBlock) &&
      /\.term-body \{[^}]*position: relative/.test(cssText) &&
      /\.term-host \{[^}]*position: relative/.test(cssText) &&
      /\.term-host \{[^}]*flex: 1 1 auto/.test(cssText) &&
      /\.term-body > \.term-host \{[^}]*position: absolute/.test(cssText) &&
      // 只给"不在看的那一路"写 hidden；**不许**给"在看的那一路"写 visible ——
      // visibility 是继承属性，显式 visible 会从 `.pane` 的隐藏里穿出来
      // （踩过：切到别的 tab，本地 Shell 的终端照样画在那一页上面）
      /\.term-body > \.term-host:not\(\.active\) \{[^}]*visibility: hidden/.test(cssText) &&
      !/\.term-body > \.term-host\.active[^{]*\{[^}]*visibility: visible/.test(cssText),
    termBodyBlock
      ? `term-body 套着 ${termBodyBlock.split('\n').length} 行`
      : 'term-body 里没套住两路',
  );
  check(
    '设置页：「运行环境」卡是简化展示 + 「查看详情」打开详情层',
    /<h3>运行环境<\/h3>/.test(railSettingsSource) &&
      /id="btn-env-detail"/.test(railSettingsSource) &&
      /@click="openEnvDetail"/.test(railSettingsSource) &&
      /id="btn-env-recheck"/.test(railSettingsSource) &&
      /loadEnvReport\(true\)/.test(railSettingsSource),
  );

  // 装 / 卸 / 升级：spec 只用于"确认文案与提示"，命令原样透传给 pnpm；错误归纳要认出常见失败。
  check(
    '插件安装：spec 分得清 npm / 本地 / tarball / git，并认得出 git 有没有固定 sha',
    (() => {
      const npm = pluginManager.parsePluginSpec('dsh-hello-plugin');
      const scoped = pluginManager.parsePluginSpec('@scope/name@1.2.3');
      const local = pluginManager.parsePluginSpec('./hello-plugin');
      const tarball = pluginManager.parsePluginSpec('./hello-0.1.0.tgz');
      const pinned = pluginManager.parsePluginSpec('github:you/hello#a1b2c3d4');
      const floating = pluginManager.parsePluginSpec('github:you/hello');
      return (
        npm?.kind === 'npm' &&
        scoped?.kind === 'npm' &&
        local?.kind === 'local' &&
        tarball?.kind === 'tarball' &&
        pinned?.kind === 'git' &&
        pinned.pinned === true &&
        floating?.kind === 'git' &&
        floating.pinned === false &&
        pluginManager.parsePluginSpec('   ') === null
      );
    })(),
  );
  check(
    '插件安装：常见失败各归纳成一句人话，认不出来返回 null（不编原因）',
    (() => {
      const notFound = pluginManager.summarizePluginFailure(
        'dsh: pnpm not found on PATH — install pnpm to manage profile plugins',
      );
      const git = pluginManager.summarizePluginFailure(
        'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED  Ignored build scripts: dsh-x',
      );
      const missing = pluginManager.summarizePluginFailure(
        'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/x: Not Found',
      );
      const denied = pluginManager.summarizePluginFailure('Error: EPERM: operation not permitted');
      return (
        Boolean(notFound && git && missing && denied) &&
        pluginManager.summarizePluginFailure('Done in 1.4s') === null
      );
    })(),
  );
  check(
    '插件安装：从 spec 里取得出包名（带版本/标签也要取对）',
    pluginManager.packageNameOf('@scope/name@1.2.3') === '@scope/name' &&
      pluginManager.packageNameOf('@scope/name') === '@scope/name' &&
      pluginManager.packageNameOf('plain-name@latest') === 'plain-name' &&
      pluginManager.packageNameOf('plain-name') === 'plain-name',
  );
  check(
    '插件安装：链到已停服的淘宝镜像要单独说，别笼统说"包不存在"（并把失败的主机名带出来）',
    (() => {
      const taobao = pluginManager.summarizePluginFailure(
        'ERR_PNPM_FETCH_404  GET https://registry.npm.taobao.org/@deepseek-ai%2Fdsh-type-meta: Not Found - 404',
      );
      const other = pluginManager.summarizePluginFailure(
        'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@x%2Fy: Not Found - 404',
      );
      return (
        Boolean(taobao?.includes('npmmirror')) &&
        Boolean(other?.includes('registry.npmjs.org')) &&
        !other?.includes('npmmirror')
      );
    })(),
  );
  check(
    '插件安装：404 缺的是依赖、不是你要的那个包时，要指名道姓（夹具是真实输出）',
    (() => {
      const real = fixture('pnpm-missing-dep.stderr.txt');
      const hint = pluginManager.summarizePluginFailure(real, '@deepseek-ai/dsh-time-context');
      return (
        Boolean(hint?.includes('@deepseek-ai/dsh-type-meta')) &&
        Boolean(hint?.includes('@deepseek-ai/dsh-time-context')) &&
        !hint?.includes('名字或版本可能不对')
      );
    })(),
  );
  check(
    '插件安装：缺的正是你要的那个包时，仍按"包不存在"说（并把主机名带出来）',
    (() => {
      const real = fixture('pnpm-missing-dep.stderr.txt');
      const hint = pluginManager.summarizePluginFailure(real, '@deepseek-ai/dsh-type-meta');
      return Boolean(hint?.includes('registry.example.com')) && !hint?.includes('依赖');
    })(),
  );
  check(
    '插件安装：安装源留空 / 写错都退回系统配置，填了才覆盖（只认 http(s)，末尾斜杠去掉）',
    (() => {
      const env = pluginManager.pluginRegistryEnv;
      const effective = env(' https://registry.npmmirror.com/ ');
      return (
        env('').npm_config_registry === undefined &&
        env('   ').npm_config_registry === undefined &&
        // 裸主机名 / 非 http(s) 都当没填：写错的代价是"装不上"，不如退回系统配置
        env('registry.npmjs.org').npm_config_registry === undefined &&
        env('ftp://mirror.example.com').npm_config_registry === undefined &&
        effective.npm_config_registry === 'https://registry.npmmirror.com' &&
        env('http://127.0.0.1:4873').npm_config_registry === 'http://127.0.0.1:4873'
      );
    })(),
  );
  check(
    '插件安装：补 PATH 时保留系统原有的键名（Windows 上叫 `Path`，不能造出两个只差大小写的键）',
    (() => {
      const win = processUtils.envWithKnownBins({ Path: 'C:\\Windows\\System32', FOO: '1' });
      const posix = processUtils.envWithKnownBins({ PATH: '/usr/bin', FOO: '1' });
      const bare = processUtils.envWithKnownBins({});
      const pathKeys = (env: NodeJS.ProcessEnv) =>
        Object.keys(env).filter((key) => key.toLowerCase() === 'path');
      return (
        // 只有一个 path 键，而且键名原样（`Path` 还是 `Path`）
        pathKeys(win).length === 1 &&
        pathKeys(win)[0] === 'Path' &&
        // 原有值还在末尾（前面补的是 node / pnpm 的目录），别的变量没动
        String(win.Path).endsWith('C:\\Windows\\System32') &&
        win.FOO === '1' &&
        String(win.Path) !== 'C:\\Windows\\System32' &&
        pathKeys(posix).length === 1 &&
        pathKeys(posix)[0] === 'PATH' &&
        String(posix.PATH).endsWith('/usr/bin') &&
        pathKeys(bare).length === 1 &&
        pathKeys(bare)[0] === 'PATH'
      );
    })(),
  );
  check(
    '插件安装：Windows 上找 pnpm / node 不写死 .cmd（独立安装包是 pnpm.exe），并有已知目录兜底',
    (() => {
      const source = fs.readFileSync('src/main/process-utils.ts', 'utf8');
      // 写死 `pnpm.cmd` 会漏掉 pnpm 官方安装包装的 `pnpm.exe`；交给 whichSync 按 PATHEXT 展开
      const viaPathext = /whichSync\('pnpm'\)/.test(source) && /whichSync\('node'\)/.test(source);
      // 键名大小写不统一（LocalAppData / LOCALAPPDATA 都见过），按小写索引后两种写法都要认
      const upper = processUtils.windowsBinCandidates(
        {
          PNPM_HOME: 'C:\\pnpm-home',
          APPDATA: 'C:\\AppData',
          LOCALAPPDATA: 'C:\\LocalAppData',
          ProgramFiles: 'C:\\Program Files',
          NVM_SYMLINK: 'C:\\Program Files\\nodejs',
        },
        'C:\\Users\\x',
      );
      const mixed = processUtils.windowsBinCandidates(
        { Pnpm_Home: 'C:\\pnpm-home', AppData: 'C:\\AppData', LocalAppData: 'C:\\LocalAppData' },
        'C:\\Users\\x',
      );
      const empty = processUtils.windowsBinCandidates({}, 'C:\\Users\\x');
      return (
        viaPathext &&
        upper.includes('C:\\pnpm-home') &&
        upper.includes('C:\\AppData\\npm') &&
        upper.includes('C:\\LocalAppData\\pnpm') &&
        upper.includes('C:\\Program Files\\nodejs') &&
        upper.includes('C:\\Users\\x\\.volta\\bin') &&
        // 大小写不同的同一组变量 → 同一组目录，顺序也一样
        mixed.slice(0, 3).join('|') === upper.slice(0, 3).join('|') &&
        // 一个变量都没有时也不炸（只留 volta 那条固定路径）
        empty.length === 1 &&
        empty[0] === 'C:\\Users\\x\\.volta\\bin'
      );
    })(),
  );
  check(
    '插件安装：安装源走子进程环境变量，不写用户的 .npmrc',
    /pluginRegistry: string;/.test(flatIpc) &&
      DEFAULTS.pluginRegistry === '' &&
      /npm_config_registry/.test(pluginSource) &&
      /pluginRegistryEnv\(this\.settings\.all\(\)\.pluginRegistry\)/.test(pluginSource) &&
      // 只注入环境；一旦有人改成往磁盘写 .npmrc，就会动到用户全局配置
      !/\.npmrc/.test(pluginSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  );
  check(
    '插件安装：没装 pnpm 时在起子进程之前拦下（`dsh plugin` 只会退出码 127，还会白建一遍 profile）',
    (() => {
      const guard = pluginSource.indexOf('if (findPnpm() === null)');
      const spawn = pluginSource.indexOf('const first = await this.spawnOnce');
      return guard !== -1 && spawn !== -1 && guard < spawn;
    })(),
  );
  check(
    '插件安装：patch 层里"已经插入了某个包"看得出来（注释里提到的不算）',
    (() => {
      const real = fixture('profile-cordis.patch.yml');
      return (
        pluginManager.patchLayerInserts(real, '@deepseek-ai/dsh-time-context') &&
        !pluginManager.patchLayerInserts(real, '@deepseek-ai/dsh-other') &&
        // 只在注释里出现的名字不算：真机上用户会以为"我明明装过了"
        !pluginManager.patchLayerInserts(
          '# 提到过 @deepseek-ai/dsh-base，但没有插入它\n[]',
          '@deepseek-ai/dsh-base',
        )
      );
    })(),
  );
  check(
    '插件安装：内置包要分清"还没启用"与"你已经启用了"（两种话说得不一样）',
    /profilePatchEnables\(name\)/.test(pluginSource) && /needsEnable/.test(pluginSource),
  );

  // ---------------------------------------------------------- 补丁层：改你自己的覆盖
  //    这是唯一会**写用户文件**的地方，所以钉三件事：只动匹配到的那一段（往返一致）、
  //    找不齐就不写（不猜）、写盘前先备份。夹具是那台机器上真实的 cordis.patch.yml。
  const realPatch = fixture('profile-cordis.patch.yml');
  check(
    '补丁层：禁用 / 启用只动匹配到的那一段（往返之后与原文一字不差）',
    (() => {
      const disabled = patchLayer.disableEntry(realPatch, 'time-context');
      const back = patchLayer.enableEntry(disabled.text, 'time-context');
      return (
        disabled.changed &&
        /^\s+disabled: true$/m.test(disabled.text) &&
        // 注释与缩进都不能被改没
        disabled.text.includes('# 想恢复成"什么都不改"') &&
        disabled.text.includes("name: '@deepseek-ai/dsh-time-context'") &&
        back.changed &&
        back.text === realPatch
      );
    })(),
  );
  check(
    '补丁层：层里没有那条时，禁用 = 加一条覆盖，启用 = 把它整条删掉（回到原样）',
    (() => {
      const disabled = patchLayer.disableEntry(realPatch, 'timer');
      const back = patchLayer.enableEntry(disabled.text, 'timer');
      // 另一头：条目是被**下面某一层**关掉的（base 把 hmr 关了）时，启用 = 写一条 disabled: false 盖住它
      const turnedOn = patchLayer.enableEntry(realPatch, 'hmr');
      const turnedOff = patchLayer.disableEntry(turnedOn.text, 'hmr');
      return (
        disabled.changed &&
        disabled.text.includes('- id: timer\n  disabled: true') &&
        back.changed &&
        // 只为禁用而存在的那条要整条消失，不能留下一条空的 `- id: timer`
        !back.text.includes('- id: timer') &&
        back.text === realPatch &&
        turnedOn.changed &&
        turnedOn.text.includes('- id: hmr\n  disabled: false') &&
        turnedOff.changed &&
        turnedOff.text.includes('- id: hmr\n  disabled: true') &&
        // 不能因此插出第二条
        turnedOff.text.split('- id: hmr').length === 2
      );
    })(),
  );
  check(
    '补丁层：插入不重复；移除只对自己插入的条目开放（覆盖条目不动它）',
    (() => {
      const once = patchLayer.insertPlugin(realPatch, 'hello', 'dsh-hello-plugin');
      const twice = patchLayer.insertPlugin(once.text, 'hello', 'dsh-hello-plugin');
      const removed = patchLayer.removeInsert(once.text, 'hello');
      const refused = patchLayer.removeInsert(
        patchLayer.disableEntry(realPatch, 'timer').text,
        'timer',
      );
      return (
        once.changed &&
        !twice.changed &&
        removed.changed &&
        removed.text === realPatch &&
        // 只为禁用而写的 `- id: timer` 不是 insert，这个动作不碰它
        !refused.changed &&
        refused.text.includes('- id: timer')
      );
    })(),
  );
  check(
    '补丁层：巡检给的"删掉这一行"只删那一条（覆盖条目 / insert 块里的都认，删完仍留顶层数组）',
    (() => {
      // 覆盖/禁用形状的条目（`- id: ghost` 那一层）——removeInsert 不碰它，dropEntry 要能删
      const ghostOverride = `${realPatch}- id: ghost\n  disabled: true\n`;
      const dropped = patchLayer.dropEntry(ghostOverride, 'ghost');
      // 嵌套形状的：insert 块里只剩它一条 → 连块一起删，不能留一个空的 `- insert:`
      const onlyNested = "# 注释\n- insert:\n    - id: ghost\n      name: 'dsh-ghost'\n";
      const droppedNested = patchLayer.dropEntry(onlyNested, 'ghost');
      // 块里还有别的条目时，只删那一条
      const siblings = `${onlyNested}    - id: keep\n      name: 'dsh-keep'\n`;
      const droppedOne = patchLayer.dropEntry(siblings, 'ghost');
      const missing = patchLayer.dropEntry(realPatch, '没有这条');
      return (
        dropped.changed &&
        !dropped.text.includes('ghost') &&
        // 别动夹具里原有的注释与那条 time-context
        dropped.text.includes('# 想恢复成"什么都不改"') &&
        dropped.text.includes("name: '@deepseek-ai/dsh-time-context'") &&
        droppedNested.changed &&
        !droppedNested.text.includes('- insert:') &&
        // 只剩注释时必须补 `[]`，dsh 否则读不出来
        /^\[\]$/m.test(droppedNested.text) &&
        droppedOne.changed &&
        !droppedOne.text.includes('ghost') &&
        droppedOne.text.includes('- id: keep') &&
        // 找不到就一个字节都不写
        !missing.changed &&
        missing.text === realPatch
      );
    })(),
  );
  check(
    '补丁层：删完最后一条要留下一个顶层数组（只剩注释 dsh 会直接报错）',
    (() => {
      // 真机事故：移除最后一条 insert 之后文件只剩注释，dsh 判它不是顶层数组，
      // 整个插件页读不出来（overlay … must be a top-level YAML array of loader patch entries）。
      const only = "- insert:\n    - id: hello\n      name: 'dsh-hello-plugin'\n";
      const removed = patchLayer.removeInsert(only, 'hello');
      const inserted = patchLayer.insertPlugin('# 只有注释\n', 'hello', 'dsh-hello-plugin');
      return (
        removed.changed &&
        /^\[\]$/m.test(removed.text) &&
        !/^- /m.test(removed.text) &&
        // 从"只有注释"的文件开始插入，也要是合法数组（注释 + 条目，不需要 []）
        inserted.changed &&
        /^- insert:/m.test(inserted.text) &&
        !/^\[\]$/m.test(inserted.text)
      );
    })(),
  );
  check(
    '补丁层：写完回读验证，只有失败点名到这份 overlay 时才回滚',
    /await runDump\(this\.settings\.all\(\)\)/.test(pluginSource) &&
      /rollbackEdit\(result\)/.test(pluginSource) &&
      /top-level YAML array\|overlay/.test(pluginSource) &&
      /message\.includes\(result\.file\)/.test(pluginSource),
  );
  check(
    '补丁层：写盘前先备份、原子写；id 不合法就一个字节都不写',
    (() => {
      const dir = path.join(sandbox, 'patch-layer');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'cordis.patch.yml');
      fs.writeFileSync(file, realPatch, 'utf8');

      const inserted = patchLayer.applyPatchEdit(dir, {
        action: 'insert',
        id: 'hello',
        name: 'dsh-hello-plugin',
      });
      const after = fs.readFileSync(file, 'utf8');
      const backup = inserted.backup ? fs.readFileSync(inserted.backup, 'utf8') : '';
      const bad = patchLayer.applyPatchEdit(dir, { action: 'disable', id: 'bad id!' });

      return (
        inserted.ok &&
        inserted.changed === true &&
        Boolean(
          inserted.backup && path.basename(inserted.backup).startsWith('cordis.patch.yml.bak-'),
        ) &&
        after.includes('- id: hello') &&
        // 备份里必须是改动前的原文
        backup === realPatch &&
        bad.ok === false &&
        fs.readFileSync(file, 'utf8') === after
      );
    })(),
  );
  check(
    '插件页：条目上有禁用 / 启用，内置包被拦下时给「插进我的层」',
    /editLayer\(entry\.disabled \? 'enable' : 'disable', entry\.id\)/.test(vueSource) &&
      /editLayer\('remove-insert', entry\.id\)/.test(vueSource) &&
      /opNeedsEnable/.test(vueSource) &&
      /pluginEditLayer/.test(flatIpc),
  );
  // ---------------------------------------------------------- 救援（P2）
  //    dsh 因为插件起不来、或配置被改坏时，这一页要能把人捞出来。两条出路：
  //    「只看内置层」（配置坏掉时它照样能成）与「临时停用某个 bundle」（改 package.json，
  //    恢复时插回原位置 —— 层序就是覆盖顺序，追加到末尾会把"恢复"变成"挪到最后"）。
  const realManifest = fixture('profile/package.json');
  check(
    '救援：临时停用 / 恢复 bundle 记住原位置（恢复之后与原文一字不差）',
    (() => {
      const suspended = profileBundles.suspendBundle(realManifest, '@deepseek-ai/dsh-web-app');
      const restored = profileBundles.restoreBundle(
        suspended.text,
        '@deepseek-ai/dsh-web-app',
        suspended.index,
      );
      const again = profileBundles.suspendBundle(realManifest, '不在列表里');
      return (
        suspended.changed &&
        suspended.index === 1 &&
        !suspended.text.includes('dsh-web-app') &&
        // 其余键原样保留
        suspended.text.includes('patchReload') &&
        suspended.text.includes('"dependencies": {}') &&
        restored.changed &&
        restored.text === realManifest &&
        !again.changed
      );
    })(),
  );
  // 界面重开之后内存里那条"刚停用"的记录就没了 —— 恢复不能因此插错位置（层序就是覆盖顺序）。
  // 出路是读改动前的备份：最近的一份里就写着它当时在第几位。
  check(
    '救援：没带位置也能从改动前的备份里找回它原来在第几位（找不到就放末尾、并说实话）',
    (() => {
      const dir = path.join(sandbox, 'bundle-recover');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'package.json');
      // 备份 = 改动前的样子（`@deepseek-ai/dsh-web-app` 在第 2 位）
      fs.writeFileSync(path.join(dir, 'package.json.bak-20260925-101010'), realManifest, 'utf8');
      fs.writeFileSync(
        file,
        profileBundles.suspendBundle(realManifest, '@deepseek-ai/dsh-web-app').text,
        'utf8',
      );

      const restored = profileBundles.applyBundleEdit(dir, 'restore', '@deepseek-ai/dsh-web-app');
      const after = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        dsh: { profile: { bundles: string[] } };
      };
      return (
        restored.ok === true &&
        restored.index === 1 &&
        after.dsh.profile.bundles[1] === '@deepseek-ai/dsh-web-app' &&
        // 位置是从哪份备份里找回来的，要说出来（人才能核对）
        /package\.json\.bak-20260925-101010/.test(restored.detail ?? '') &&
        // 没有那份记录时：不假装知道，老实追加到末尾
        profileBundles.recoverBundleIndex(dir, '从来没在列表里过') === null
      );
    })(),
  );
  check(
    '救援：只剩注释的补丁层能补成空数组；有内容的文件它不动',
    (() => {
      const broken = '# 只剩注释\n# 还是没有数组\n';
      const fixed = patchLayer.repairEmptyArray(broken);
      const untouched = patchLayer.repairEmptyArray(realPatch);
      const empty = patchLayer.repairEmptyArray('');
      return (
        fixed.changed &&
        /^\[\]$/m.test(fixed.text) &&
        // 注释保住，只在后面补 []
        fixed.text.includes('# 只剩注释') &&
        !untouched.changed &&
        untouched.text === realPatch &&
        empty.changed &&
        /^\[\]$/m.test(empty.text)
      );
    })(),
  );
  check(
    '救援：备份按时间倒序列出；恢复只认这份 profile 里的 .bak-（递来的路径不可信）',
    (() => {
      const dir = path.join(sandbox, 'patch-rescue');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'cordis.patch.yml');
      fs.writeFileSync(file, '# 坏掉的\n', 'utf8');
      fs.writeFileSync(
        path.join(dir, 'cordis.patch.yml.bak-20260101-000000'),
        '# 旧备份\n',
        'utf8',
      );
      fs.utimesSync(
        path.join(dir, 'cordis.patch.yml.bak-20260101-000000'),
        new Date(1000),
        new Date(1000),
      );
      fs.writeFileSync(
        path.join(dir, 'cordis.patch.yml.bak-20260102-000000'),
        '- id: from-backup\n',
        'utf8',
      );
      const list = patchLayer.listPatchBackups(dir);
      const refused = patchLayer.restorePatchBackup(dir, '/etc/passwd');
      const restored = patchLayer.restorePatchBackup(dir, list[0]?.path ?? '');
      const after = fs.readFileSync(file, 'utf8');
      const savedCurrent = restored.backup ? fs.readFileSync(restored.backup, 'utf8') : '';
      return (
        list.length === 2 &&
        // 最近的在前
        list[0].name === 'cordis.patch.yml.bak-20260102-000000' &&
        refused.ok === false &&
        restored.ok === true &&
        after === '- id: from-backup\n' &&
        // 恢复之前那份"坏掉的"也被备份了 —— 这一步同样可逆
        savedCurrent === '# 坏掉的\n'
      );
    })(),
  );
  check(
    '救援：dump 读不出来时也带上 bundle 清单，且只有非内置的才给「临时停用」',
    /bundles\?: \{ name: string; inBox: boolean \}\[\]/.test(flatIpc) &&
      /inBox: dshRoot !== null/.test(pluginSource) &&
      // 失败时提前返回也要带着它（否则"bundle 解析不到"这种救援场景无从下手）
      /bundles,\n\s*\};/.test(pluginSource) &&
      /!item\.inBox && line\.includes\(item\.name\)/.test(vueSource),
  );
  check(
    '救援：界面上有「修成空配置」与「从备份恢复」，契约里有 pluginRescue',
    /repairLayer/.test(vueSource) &&
      /restoreBackup/.test(vueSource) &&
      /loadBackups/.test(vueSource) &&
      /pluginRescue/.test(vueSource) &&
      /pluginRescue/.test(flatIpc),
  );
  check(
    '救援：配置坏掉时「只看内置层」这条路还在（--dump-default-config，不解析你的层）',
    /--dump-default-config/.test(pluginSource) &&
      /baseline: true/.test(pluginSource) &&
      /pluginDefaultConfig/.test(flatIpc) &&
      /pluginBundleEdit/.test(flatIpc),
  );
  check(
    '救援：基线视图不会被「读不出来」的空态挡住（否则点了按钮什么也看不到）',
    /error && !baseline/.test(vueSource) && /data && !baseline/.test(vueSource),
  );
  check(
    '救援：基线视图里不给作用于真实配置的动作（条目上的、以及巡检那块的两个按钮）',
    // 条目上的动作
    /v-if="!baseline"/.test(vueSource) &&
      // 巡检那块整块藏掉：它说的都是真实配置，而这一屏明说"不是你现在生效的配置"
      /problems\.length && !baseline/.test(vueSource),
  );
  check(
    '救援：界面有救援条与两个出口，而不是只显示一句错误',
    /loadBaseline/.test(vueSource) &&
      /plugin-rescue/.test(vueSource) &&
      /editBundle\('suspend'/.test(vueSource) &&
      /editBundle\('restore'/.test(vueSource) &&
      /showRescue/.test(vueSource),
  );
  // 停用**不是单向门**。原来「恢复」只长在救援条里，而救援条只在 dsh 起不来时出现 ——
  // 在层栈详情里点「临时停用」的人，dsh 明明好好的，于是界面上再也找不到"放回去"。
  check(
    '救援：「放回层里」不依赖救援条 —— 巡检那行里也有，黄条上也有（停用之后回得去）',
    /if \(kind === 'suspended-bundle'\) return '掉出了层列表'/.test(vueSource) &&
      /function canRestore\(item: PluginProblem\): boolean/.test(vueSource) &&
      /restoreProblem\(item\)/.test(vueSource) &&
      /放回层里/.test(vueSource) &&
      /id="btn-plugin-restore-bundle"/.test(vueSource) &&
      /editBundle\('restore', suspended\.name, suspended\.index\)/.test(vueSource) &&
      // 两种"不形成层"都能卸；只有被摘掉的那种能放回
      /item\.kind === 'plain-dependency' \|\| item\.kind === 'suspended-bundle'/.test(vueSource),
  );
  check(
    '插件安装：spec 是一个 argv（不拼 shell）、PATH 补过 pnpm、输出双向都收',
    // 起的是**包装器算好的 spec**（不是裸 file/args），并且必须把 verbatim 传下去：
    // Windows 上 shim / npx / 自定义 shim 走 cmd.exe，漏了这个标志就报 not recognized
    /spawn\(spec\.file, spec\.args,/.test(pluginSource) &&
      /windowsVerbatimArguments: spec\.windowsVerbatimArguments/.test(pluginSource) &&
      // 补 PATH 走 envWithKnownBins（保留系统原有的键名，见下一条）
      /envWithKnownBins\(process\.env\)/.test(pluginSource) &&
      /stdio: \['ignore', 'pipe', 'pipe'\]/.test(pluginSource) &&
      // 相对路径按 cwd 解析，cwd 不能继承（Electron 的启动目录不可预测）
      /cwd: homeDir\(\)/.test(pluginSource) &&
      !/shell:\s*true/.test(pluginSource) &&
      /child\.stderr\?\.on\('data', collect\)/.test(pluginSource),
  );
  check(
    '插件安装：pnpm 说"这是 workspace root"时用 -w 重试一次（dsh 模板缺 ignore-workspace-root-check）',
    /ADDING_TO_ROOT\|workspace root/.test(pluginSource) &&
      /specFor\(\['-w'\]\)/.test(pluginSource) &&
      // 第一次调用不带 -w（只有在 pnpm 明确要求时才加）
      /specFor\(\[\]\), env, onOutput\)/.test(pluginSource),
  );
  // 「启动 dsh」这条路的三种回退 launcher（process-utils 的 shim / npx / 自定义 shim 分支）：
  // 它们给的都是 cmd.exe + `/d /s /c`，所以包装后的 spec 必须是「单个 /c 字符串 + 外层引号 +
  // verbatim」。钉「形状 + 标志位」两样，不只看 argv 文本（F1 当初就是因为只钉文本而漏掉标志位）。
  const envDshFallbacks: { kind: string; launcher: processUtils.DshLauncher }[] = [
    {
      kind: 'shim',
      launcher: {
        file: processUtils.COMSPEC,
        prefixArgs: ['/d', '/s', '/c', '"D:\\Node\\nodejs\\dsh.cmd"'],
        viaCmd: true,
        display: 'D:\\Node\\nodejs\\dsh.cmd',
        kind: 'shim',
      },
    },
    {
      kind: 'npx',
      launcher: {
        file: processUtils.COMSPEC,
        prefixArgs: ['/d', '/s', '/c', '"D:\\Node\\nodejs\\npx.cmd"', '-y', '@deepseek-ai/dsh'],
        viaCmd: true,
        display: 'D:\\Node\\nodejs\\npx.cmd -y @deepseek-ai/dsh',
        kind: 'npx',
      },
    },
    {
      kind: 'custom-shim',
      launcher: {
        file: processUtils.COMSPEC,
        prefixArgs: ['/d', '/s', '/c', '"C:\\Program Files\\my tools\\dsh.cmd"'],
        viaCmd: true,
        display: '"C:\\Program Files\\my tools\\dsh.cmd"',
        kind: 'custom-shim',
      },
    },
  ];
  const envDshSpecs = envDshFallbacks.map((item) => ({
    kind: item.kind,
    spec: processUtils.dshLaunchSpec(item.launcher, ['web', '--no-open'], 'win32'),
  }));
  check(
    '环境自检：启动 dsh 的回退 launcher（shim / npx / 自定义 shim）在 Windows 上真的起得来',
    envDshSpecs.every(
      ({ spec }) =>
        spec.file === processUtils.COMSPEC &&
        processUtils.isRunnablePath(spec.file, 'win32') &&
        spec.windowsVerbatimArguments === true &&
        // /d /s /c + **整条命令拼成一个参数**（这样 cmd 的 /s 剥掉最外层引号后才是真命令行）
        spec.args.length === 4 &&
        spec.args[0] === '/d' &&
        spec.args[1] === '/s' &&
        spec.args[2] === '/c' &&
        spec.args[3].startsWith('""') &&
        spec.args[3].endsWith('"') &&
        // 子命令（`web --no-open`）在同一个字符串里，没有被拆成独立 argv
        / web --no-open"$/.test(spec.args[3]),
    ),
    envDshSpecs.map(({ kind, spec }) => `${kind}: ${spec.file} ${spec.args.join(' ')}`).join(' | '),
  );
  if (!IS_WINDOWS) {
    skip(
      '环境自检：回退 launcher 是**从 PATH 真解析出来**的（而不是手工构造的夹具）',
      '那三条回退分支（shim / npx）只在 Windows 上生效',
    );
  } else {
    // 真解析一遍：把 PATH 指向只放着 `dsh.cmd`（或 `npx.cmd`）的夹具目录，
    // resolveDshLauncher 就会落到对应的回退分支上 —— 离线、不起任何子进程。
    const fallbackDir = path.join(sandbox, 'dsh-fallback');
    fs.mkdirSync(fallbackDir, { recursive: true });
    const pathBefore = process.env.PATH;
    const resolved: string[] = [];
    try {
      // 1) shim：PATH 里只有 dsh.cmd，且没有 node → 解析器落到 shim 分支
      const shimDir = path.join(fallbackDir, 'shim');
      fs.mkdirSync(shimDir, { recursive: true });
      fs.writeFileSync(path.join(shimDir, 'dsh.cmd'), '@echo off\r\n');
      process.env.PATH = shimDir;
      const shimLauncher = processUtils.resolveDshLauncher({ ...settings.all(), dshCommand: '' });
      const shimSpec = processUtils.dshLaunchSpec(shimLauncher, ['web'], 'win32');
      resolved.push(`shim=${shimLauncher.kind}`);
      check(
        '环境自检：PATH 里只有 dsh.cmd 时解析成 shim，且包装后的 spec 带 verbatim',
        shimLauncher.kind === 'shim' &&
          shimSpec.file === processUtils.COMSPEC &&
          shimSpec.windowsVerbatimArguments === true &&
          /dsh\.cmd" web"$/.test(shimSpec.args[3]),
      );
      // 2) npx：PATH 里只有 npx.cmd（没有 dsh shim、没有 node）
      const npxDir = path.join(fallbackDir, 'npx');
      fs.mkdirSync(npxDir, { recursive: true });
      fs.writeFileSync(path.join(npxDir, 'npx.cmd'), '@echo off\r\n');
      process.env.PATH = npxDir;
      const npxLauncher = processUtils.resolveDshLauncher({ ...settings.all(), dshCommand: '' });
      const npxSpec = processUtils.dshLaunchSpec(npxLauncher, ['web'], 'win32');
      resolved.push(`npx=${npxLauncher.kind}`);
      check(
        '环境自检：PATH 里只有 npx.cmd 时解析成 npx，且包装后的 spec 带 verbatim',
        npxLauncher.kind === 'npx' &&
          npxSpec.file === processUtils.COMSPEC &&
          npxSpec.windowsVerbatimArguments === true &&
          /npx\.cmd" -y @deepseek-ai\/dsh web"$/.test(npxSpec.args[3]),
      );
      // 3) custom-shim：设置里写死的 .cmd（不需要改 PATH）
      const customLauncher = processUtils.resolveDshLauncher({
        ...settings.all(),
        dshCommand: path.join(fallbackDir, 'shim', 'dsh.cmd'),
      });
      const customSpec = processUtils.dshLaunchSpec(customLauncher, ['web'], 'win32');
      resolved.push(`custom=${customLauncher.kind}`);
      check(
        '环境自检：自定义命令写 .cmd 时解析成 custom-shim，且包装后的 spec 带 verbatim',
        customLauncher.kind === 'custom-shim' &&
          customSpec.file === processUtils.COMSPEC &&
          customSpec.windowsVerbatimArguments === true,
      );
    } finally {
      process.env.PATH = pathBefore;
    }
  }
  check(
    '插件安装：契约里有 3 个 API 与操作结果类型',
    (() => {
      const ipc = fs.readFileSync(path.join(srcDir, 'shared', 'ipc.ts'), 'utf8');
      return (
        /pluginRun: \(request: \{ action: PluginOpAction; spec: string \}\) => Promise<PluginOpResult>/.test(
          ipc,
        ) &&
        /pluginCancel: \(\) => Promise<boolean>/.test(ipc) &&
        /onPluginOutput:/.test(ipc) &&
        /export type PluginOpAction = 'add' \| 'remove' \| 'update'/.test(ipc)
      );
    })(),
  );

  check(
    '插件：只碰 web profile（desktop 是 CLI 保留给 Electron 的，传进去直接报错）',
    pluginManager.PLUGIN_PROFILE === 'web' &&
      /PLUGIN_PROFILE/.test(pluginSource) &&
      !/'--profile',\s*'desktop'/.test(pluginSource) &&
      !/"--profile",\s*"desktop"/.test(pluginSource),
  );

  // ---------------------------------------------------------- 16. 运行环境自检
  //    这一页的价值是「把机器的现状说清楚」，所以最怕两件事：判定里混进 IO（只能在真机上验）、
  //    以及"不满足却没给出路"。下面全部是纯函数夹具 + 静态文本检查：不装 pnpm、不起任何进程。
  const envSource = fs.readFileSync(path.join(srcDir, 'main', 'env-doctor.ts'), 'utf8');
  /** 按大括号配平切出一段代码块（给定锚点，取它后面的第一个 `{`） */
  const blockOf = (source: string, anchor: string): string => {
    const start = source.indexOf(anchor);
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
  /** `export function xxx(` 那个函数体（类方法 / 局部函数用 blockOf） */
  const functionBodyOf = (source: string, name: string): string =>
    blockOf(source, `export function ${name}(`);
  /**
   * 类方法整段（含签名）：按**下一个类成员**为界切。
   *
   * 为什么不复用 `blockOf`：它从锚点之后第一个 `{` 起的配对花括号，而带返回类型注解的方法
   * （`): Promise<{ kind: ... }> {`）第一个 `{` 落在**类型里**，切出来只有类型那一小段。
   */
  const methodSliceOf = (source: string, anchor: string): string => {
    const start = source.indexOf(anchor);
    if (start < 0) return '';
    const rest = source.slice(start + anchor.length);
    const next = /\n {2}(?:private|public|static|readonly|async|[a-zA-Z]+\()/.exec(rest);
    return rest.slice(0, next ? next.index : rest.length);
  };
  const stripComments = (text: string): string =>
    text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const envCode = stripComments(envSource);
  const envJudgeBody = stripComments(functionBodyOf(envSource, 'judgeEnvironment'));
  /**
   * 只留代码、去掉字符串字面量的内容：judgeEnvironment 的 detail 是**给人看的人话**，
   * 里面会提到 `spawn("pnpm")` 这类实现细节（那恰恰是用户要看到的原因），
   * 但"提到"不等于"做了"。模板串里的 `${…}` 是代码，保留下来（别把 IO 一起藏掉）。
   */
  const stripStrings = (text: string): string =>
    text.replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, (whole: string, quote: string) => {
      if (quote !== '`') return `${quote}${quote}`;
      const exprs = [...whole.matchAll(/\$\{([\s\S]*?)\}/g)].map((match) => match[1]);
      return `\`${exprs.join(' ; ')}\``;
    });
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

  // 夹具：一份"什么都好"的原始事实，各条断言按需覆盖一两项。
  // 判定是纯函数，所以这里不需要任何真实环境（这正是把它做成纯函数的理由）。
  const envVersionProbe = (over: Partial<envDoctor.VersionProbe> = {}): envDoctor.VersionProbe => ({
    path: '/opt/homebrew/bin/node',
    version: 'v24.19.0',
    exitCode: 0,
    error: null,
    ...over,
  });
  const envDshProbe = (over: Partial<envDoctor.DshProbe> = {}): envDoctor.DshProbe => ({
    kind: 'node-bin',
    display: '/opt/homebrew/bin/node /usr/local/lib/bin.js',
    runs: true,
    version: '0.5.3',
    exitCode: 0,
    error: null,
    resolveError: null,
    ...over,
  });
  const envProbe = (over: Partial<envDoctor.EnvProbeRaw> = {}): envDoctor.EnvProbeRaw => ({
    checkedAt: 0,
    platform: 'darwin',
    packaged: true,
    bundled: { electron: '44.3.0', node: '24.19.0', chrome: '140.0.0' },
    node: envVersionProbe(),
    npm: envVersionProbe({ path: '/opt/homebrew/bin/npm', version: '10.9.0' }),
    pnpm: envVersionProbe({ path: '/opt/homebrew/bin/pnpm', version: '9.15.0' }),
    dsh: envDshProbe(),
    shell: { file: '/bin/zsh', exists: true },
    error: null,
    ...over,
  });
  const envCheckOf = (report: EnvDoctorReport, id: EnvCheckId) =>
    report.checks.find((item) => item.id === id) ?? {
      id,
      status: 'missing' as const,
      detail: '',
      fixHint: null,
      fixAction: null,
    };

  const envAllOk = envDoctor.judgeEnvironment(envProbe());
  const envIds: EnvCheckId[] = [
    'node',
    'node-version',
    'npm',
    'pnpm',
    'dsh',
    'dsh-run',
    'bundled-runtime',
    'shell',
  ];
  /** 三个引导步骤（与主进程的 `WIZARD_STEP_IDS` 同一份顺序） */
  const envWizardStepIds: EnvWizardStepId[] = ['node', 'pnpm', 'dsh'];
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
  const envNoNode = envProbe({
    node: envVersionProbe({ path: null, version: null, exitCode: null }),
  });
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
      const source = fs.readFileSync(
        path.join(repoRoot, 'src', 'main', 'process-utils.ts'),
        'utf8',
      );
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
  const envNoNodeReport = envDoctor.judgeEnvironment(envNoNode);
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

  const envMainCode = stripComments(
    fs.readFileSync(path.join(repoRoot, 'src', 'main', 'main.ts'), 'utf8'),
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
  const envPaneCode = stripComments(
    fs.readFileSync(path.join(rendererDir, 'panes', 'EnvPane.vue'), 'utf8'),
  );
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
      const utils = fs.readFileSync(path.join(srcDir, 'main', 'process-utils.ts'), 'utf8');
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
      const utils = fs.readFileSync(path.join(srcDir, 'main', 'process-utils.ts'), 'utf8');
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

  // ---------------------------------------------------------- 17. 首启环境向导（门禁）
  //    冻结文档 §3.8 里归"契约与编排"的那些断言。判定是纯函数，所以全部是夹具 + 静态文本检查：
  //    不装 Node、不起任何进程、不碰网络。
  const wizardSource = stripComments(
    fs.readFileSync(path.join(rendererDir, 'lib', 'env-wizard.ts'), 'utf8'),
  );
  const bootLockSource = stripComments(
    fs.readFileSync(path.join(rendererDir, 'lib', 'boot-lock.ts'), 'utf8'),
  );
  const preloadCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'preload', 'preload.ts'), 'utf8'),
  );
  const appTsCode = stripComments(fs.readFileSync(path.join(rendererDir, 'app.ts'), 'utf8'));

  // ---------------------------------------------------------- 17b. VM-07 的渲染层半边（t31）
  //    修完（复检报告随 `env:fix-state` 落进 `envFix`）之后，**门禁的步骤状态**是另一条读法
  //    （`env:wizard`）。少了这一步，用户装完 pnpm 之后第二步仍然停在「待办」上，只能重开应用。
  check(
    '环境自检（VM-07）：复检报告一到，渲染层就重拉一次门禁结论（不必重开应用）',
    // 盯的是共享状态 `envFix`（由 lib/env-doctor.ts 那一个订阅者写），而不是自己再订一次 IPC
    /watch\(envFix, \(state\) => \{[\s\S]{0,200}?if \(!state\.report\) return;[\s\S]{0,120}?void loadWizard\(\);/.test(
      wizardSource,
    ) &&
      /function watchFixReports\(\): void \{/.test(wizardSource) &&
      // 并且真的在接线时调用了它（幂等位里）
      /wired = true;[\s\S]{0,400}?watchFixReports\(\);/.test(wizardSource) &&
      // 只"再拉一次结论"：不 refresh（主进程缓存刚被复检刷新过）、不加启动锁、不改判定
      !/watch\(envFix,[\s\S]{0,200}?refresh: true/.test(wizardSource),
  );

  /**
   * 手写一份报告：门禁判定只看 `checks` 的 id / status、`plans` 与 `error`，
   * 其余字段按 §3 的形状补占位值。用它才能摆出"某一项是 warn"这类
   * `judgeEnvironment` 在当前实现里不会产出的组合（受限环境下 warn 行是存在的）。
   */
  const wizardReport = (
    statuses: Partial<Record<EnvCheckId, EnvCheckStatus>>,
    over: Partial<EnvDoctorReport> = {},
  ): EnvDoctorReport => ({
    checkedAt: 0,
    checks: envIds.map((id) => ({
      id,
      status: statuses[id] ?? 'ok',
      detail: `${id}：这一轮的事实`,
      fixHint: null,
      fixAction: null,
    })),
    counts: { ok: 8, warn: 0, missing: 0 },
    firstProblemId: null,
    nodeRange: envDoctor.NODE_RANGE,
    plans: [],
    error: null,
    // t29：归属是**采集侧给的事实**（判定只搬运）。门禁判定不看它，所以这里是占位值
    nodeOwner: 'unknown',
    nodeOwnerEvidence: [],
    ...over,
  });
  const wizardSkips = (...ids: string[]): EnvWizardStepId[] =>
    ids.filter((id): id is EnvWizardStepId => envWizardStepIds.some((known) => known === id));

  // 契约增量：新联合的成员、7 个新 API、两个设置项、ipc.ts 仍然零 import
  check(
    '环境向导：契约增量都在（新联合成员 / 7 个 API / 两个设置项 / ipc.ts 仍然零 import）',
    (() => {
      const wizardApiNames = [
        'envWizard',
        'envWizardSkip',
        'envNodePlan',
        'envNodeInstall',
        'envNodeStop',
        'onEnvInstallState',
        'onEnvInstallOutput',
      ];
      const installPhaseUnion = /export type EnvInstallPhase =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      const stepUnion = /export type EnvWizardStepId =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      const statusUnion = /export type EnvStepStatus =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      const gateUnion = /export type EnvGateState =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      /** 数联合类型的成员：按引号里的名字数，别按 `|` 切（多行写法会让分隔符本身也被数进去） */
      const membersOf = (union: string): string[] =>
        [...union.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      return (
        // 契约零 import：只放类型与纯常量（渲染层要读这些类型，拖进 fs/path 就会被卷进包里）
        !/^\s*import\s/m.test(ipcSource) &&
        membersOf(stepUnion).length === 3 &&
        ['node', 'pnpm', 'dsh'].every((id) => stepUnion.includes(`'${id}'`)) &&
        membersOf(statusUnion).length === 4 &&
        ['done', 'todo', 'skipped', 'unknown'].every((s) => statusUnion.includes(`'${s}'`)) &&
        membersOf(gateUnion).length === 3 &&
        ['open', 'blocked', 'unknown'].every((s) => gateUnion.includes(`'${s}'`)) &&
        // 10 个安装相位：三个终态（done / cancelled / error）必须在
        membersOf(installPhaseUnion).length === 10 &&
        [
          'idle',
          'preparing',
          'downloading',
          'verifying',
          'installing',
          'waiting',
          'rechecking',
        ].every((phase) => installPhaseUnion.includes(`'${phase}'`)) &&
        ['done', 'cancelled', 'error'].every((phase) => installPhaseUnion.includes(`'${phase}'`)) &&
        /export interface EnvWizardState \{/.test(ipcSource) &&
        /currentStepId: EnvWizardStepId \| null;/.test(ipcSource) &&
        /gateReason: string \| null;/.test(ipcSource) &&
        /fixAction: EnvFixAction \| null;/.test(ipcSource) &&
        /export interface EnvInstallState \{/.test(ipcSource) &&
        /detached: boolean;/.test(ipcSource) &&
        /cancellable: boolean;/.test(ipcSource) &&
        /envSkips: EnvWizardStepId\[\];/.test(ipcSource) &&
        /envNodeSource: string;/.test(ipcSource) &&
        // 签名自述（冻结 §3.2 的逐字块）：它是**发布元数据**的说法，用具名类型与 `signer` 分开。
        // `signer === null` 只表示"还没读"，不许当成"未签名"；计划阶段的那次确认只认 'unsigned'。
        /export type EnvReleaseSigning = 'signed' \| 'unsigned' \| 'unknown';/.test(ipcSource) &&
        (() => {
          const planBody =
            /\nexport interface EnvNodePlan \{([\s\S]*?)\n\}/.exec(ipcSource)?.[1] ?? '';
          return (
            /releaseSigning: EnvReleaseSigning;/.test(planBody) &&
            /signer: string \| null;/.test(planBody) &&
            !/signer: string;/.test(planBody)
          );
        })() &&
        wizardApiNames.every((name) => new RegExp(`\\n\\s{2}${name}:`).test(ipcSource)) &&
        // EnvFixAction 仍是两个成员（Node 不走它，见冻结 §3.5）
        (() => {
          const actionUnion = /export type EnvFixAction =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
          return (
            membersOf(actionUnion).length === 2 &&
            actionUnion.includes("'install-pnpm'") &&
            actionUnion.includes("'install-dsh'")
          );
        })()
      );
    })(),
  );

  const wizardHealthy = envDoctor.judgeWizard(envAllOk, []);
  const wizardNoNode = envDoctor.judgeWizard(envNoNodeReport, []);
  const wizardStepOf = (state: EnvWizardState, id: EnvWizardStepId) =>
    state.steps.find((step) => step.id === id) ?? {
      id,
      status: 'unknown' as const,
      detail: '',
      checkIds: [],
      skippable: false,
      fixAction: null,
    };
  check(
    '环境向导：八项全好时直接放行（open、无当前步骤、无理由、三步都完成）',
    wizardHealthy.gate === 'open' &&
      wizardHealthy.currentStepId === null &&
      wizardHealthy.gateReason === null &&
      wizardHealthy.steps.length === 3 &&
      wizardHealthy.steps.every((step) => step.status === 'done') &&
      wizardHealthy.steps.every((step) => step.detail.length > 0 && step.checkIds.length > 0) &&
      wizardStepOf(wizardHealthy, 'node').fixAction === null &&
      wizardStepOf(wizardHealthy, 'pnpm').fixAction === 'install-pnpm' &&
      wizardStepOf(wizardHealthy, 'dsh').fixAction === 'install-dsh' &&
      wizardStepOf(wizardHealthy, 'node').skippable === false &&
      wizardStepOf(wizardHealthy, 'pnpm').skippable === true &&
      wizardStepOf(wizardHealthy, 'dsh').skippable === false &&
      wizardHealthy.report === envAllOk,
  );
  check(
    '环境向导：缺 Node 时挡住（blocked，当前步骤是 node，理由非空）',
    wizardNoNode.gate === 'blocked' &&
      wizardNoNode.currentStepId === 'node' &&
      Boolean(wizardNoNode.gateReason) &&
      wizardStepOf(wizardNoNode, 'node').status === 'todo' &&
      /Node/.test(String(wizardNoNode.gateReason)),
  );
  // 判据表（冻结 §2.2 第一步）：只有判据行是 missing 才算"缺东西"

  const wizardVersionWarn = envDoctor.judgeWizard(
    envDoctor.judgeEnvironment(envProbe({ node: envVersionProbe({ version: 'v20.9.0' }) })),
    [],
  );
  const wizardNpxDsh = envDoctor.judgeWizard(
    envDoctor.judgeEnvironment(envProbe({ dsh: envDshProbe({ kind: 'npx' }) })),
    [],
  );
  const wizardDeadDsh = envDoctor.judgeWizard(
    envDoctor.judgeEnvironment(
      envProbe({
        dsh: envDshProbe({ kind: 'node-bin', runs: false, version: null, exitCode: null }),
      }),
    ),
    [],
  );
  check(
    '环境向导：三步骤判据与 §2.2 一致（版本 warn / npx warn 都算完成；跑不动 dsh 才是待办）',
    // node-version 只是解释原因，不参与判据：它 warn 也照样算这一步完成
    wizardVersionWarn.gate === 'open' &&
      wizardStepOf(wizardVersionWarn, 'node').status === 'done' &&
      // dsh 走 npx 是 warn（能用但每次联网），实测跑得动 → 这一步完成
      wizardNpxDsh.gate === 'open' &&
      wizardStepOf(wizardNpxDsh, 'dsh').status === 'done' &&
      wizardStepOf(wizardNpxDsh, 'pnpm').status === 'done' &&
      // 定位得到但实测跑不动（退出码 0 + 零输出）→ 这一步是待办，门禁挡住
      wizardDeadDsh.gate === 'blocked' &&
      wizardStepOf(wizardDeadDsh, 'dsh').status === 'todo' &&
      wizardDeadDsh.currentStepId === 'dsh',
  );
  // warn 不当成缺失：没有 missing 证据时**不挡人**（需求 §4.3）。
  // 注意 §2.2 的判据是"那一项不是 missing 就算满足"，所以只有 warn 行时步骤可以是 done；
  // 冻结 §3.8 第 4 条"三步骤全 warn → 三步 unknown"只在报告整体出错（error 非空）时成立，
  // 见下一条（文档这两处在字面上互相矛盾，实现以 §2.2 的判据表为准）。
  const wizardAllWarn = wizardReport({
    node: 'warn',
    'node-version': 'warn',
    npm: 'warn',
    pnpm: 'warn',
    dsh: 'warn',
    'dsh-run': 'warn',
  });
  const wizardAllWarnState = envDoctor.judgeWizard(wizardAllWarn, []);
  check(
    '环境向导：warn 不当成缺失（只有 warn 行 → 门禁不是 blocked，没有任何 todo）',
    wizardAllWarnState.gate !== 'blocked' &&
      wizardAllWarnState.steps.every((step) => step.status !== 'todo') &&
      wizardAllWarnState.steps.filter((step) => step.status === 'done').length === 3,
  );
  // 报告整体出错（error 非空）：没有 missing 证据的步骤记 unknown（不宣称"好了"），有证据仍是 todo
  const wizardErrorOnly = envDoctor.judgeWizard(
    wizardReport(
      { 'node-version': 'warn', npm: 'warn', pnpm: 'warn', dsh: 'warn', 'dsh-run': 'warn' },
      { error: '这一轮没测全：解析本地 Shell 失败' },
    ),
    [],
  );
  const wizardErrorWithMissing = envDoctor.judgeWizard(
    wizardReport({ pnpm: 'missing' }, { error: '这一轮没测全：解析本地 Shell 失败' }),
    [],
  );
  check(
    '环境向导：报告整体出错时没有 missing 证据的步骤记 unknown，有证据的仍然 blocked',
    wizardErrorOnly.gate === 'unknown' &&
      wizardErrorOnly.steps.every((step) => step.status === 'unknown') &&
      wizardErrorOnly.currentStepId === 'node' &&
      Boolean(wizardErrorOnly.gateReason) &&
      wizardErrorWithMissing.gate === 'blocked' &&
      wizardStepOf(wizardErrorWithMissing, 'pnpm').status === 'todo' &&
      wizardStepOf(wizardErrorWithMissing, 'node').status === 'unknown' &&
      wizardErrorWithMissing.currentStepId === 'pnpm',
  );
  const wizardUnknownOnly = envDoctor.judgeWizard(
    wizardReport({ pnpm: 'warn', dsh: 'warn', 'dsh-run': 'warn' }, { error: '这一轮没测全' }),
    [],
  );
  check(
    '环境向导：currentStepId 取第一个 todo、否则第一个 unknown、否则 null',
    envDoctor.judgeWizard(wizardReport({ pnpm: 'missing', dsh: 'missing' }), []).currentStepId ===
      'pnpm' &&
      wizardUnknownOnly.currentStepId === 'node' &&
      wizardHealthy.currentStepId === null &&
      // 推论：blocked 时当前步骤一定是 todo（界面上永远有可做的动作）
      [wizardNoNode, wizardErrorWithMissing].every((state) => {
        if (state.gate !== 'blocked') return false;
        const current = state.steps.find((step) => step.id === state.currentStepId);
        return current !== undefined && current.status === 'todo';
      }),
  );
  check(
    '环境向导：不可跳过的步骤跳过无效（node / dsh 仍 blocked、仍是 todo），未知 id 被忽略',
    (() => {
      const blocked = wizardReport({ node: 'missing', dsh: 'missing', pnpm: 'missing' });
      const withIgnored = envDoctor.judgeWizard(
        blocked,
        wizardSkips('node', 'dsh', 'shell', 'node'),
      );
      const withPnpm = envDoctor.judgeWizard(blocked, wizardSkips('pnpm'));
      return (
        withIgnored.gate === 'blocked' &&
        wizardStepOf(withIgnored, 'node').status === 'todo' &&
        wizardStepOf(withIgnored, 'dsh').status === 'todo' &&
        withIgnored.skips.length === 0 &&
        withPnpm.gate === 'blocked' &&
        wizardStepOf(withPnpm, 'pnpm').status === 'skipped' &&
        withPnpm.skips.length === 1 &&
        withPnpm.skips[0] === 'pnpm' &&
        // 跳过一个只剩 warn 证据的步骤也照样生效（那是可跳过的）
        envDoctor.judgeWizard(wizardReport({ pnpm: 'warn' }), wizardSkips('pnpm')).skips[0] ===
          'pnpm'
      );
    })(),
  );
  check(
    '环境向导：skipped 项判 warn 不是 missing（五个子进程项各一条夹具）',
    (() => {
      const skippedProbe = (over: Partial<envDoctor.EnvProbeRaw>): envDoctor.EnvProbeRaw =>
        envProbe(over);
      const fixtures: [EnvCheckId, envDoctor.EnvProbeRaw][] = [
        [
          'node-version',
          skippedProbe({ node: envVersionProbe({ version: null, exitCode: null, skipped: true }) }),
        ],
        [
          'npm',
          skippedProbe({ npm: envVersionProbe({ version: null, exitCode: null, skipped: true }) }),
        ],
        [
          'pnpm',
          skippedProbe({ pnpm: envVersionProbe({ version: null, exitCode: null, skipped: true }) }),
        ],
        [
          'dsh',
          skippedProbe({
            dsh: envDshProbe({ kind: null, display: null, runs: false, skipped: true }),
          }),
        ],
        [
          'dsh-run',
          skippedProbe({
            dsh: envDshProbe({ kind: null, display: null, runs: false, skipped: true }),
          }),
        ],
      ];
      return fixtures.every(([id, raw]) => {
        const row = envCheckOf(envDoctor.judgeEnvironment(raw), id);
        return row.status === 'warn' && /这一轮没测/.test(row.detail);
      });
    })(),
  );
  const wizardQuickProbe = envDoctor.collectBootProbe(settings.all(), {
    platform: process.platform,
    packaged: false,
    bundled: { electron: '44.3.0', node: '24.19.0', chrome: '140.0.0' },
  });
  const wizardQuickReport = envDoctor.judgeEnvironment(wizardQuickProbe);
  check(
    '环境向导：快速探测把"要起子进程才知道的项"标成 skipped（判定给 warn，实测结果为空）',
    wizardQuickProbe.node.skipped === true &&
      wizardQuickProbe.npm.skipped === true &&
      wizardQuickProbe.pnpm.skipped === true &&
      wizardQuickProbe.dsh.skipped === true &&
      wizardQuickProbe.node.version === null &&
      wizardQuickProbe.npm.version === null &&
      wizardQuickProbe.pnpm.version === null &&
      wizardQuickProbe.dsh.runs === false &&
      wizardQuickProbe.dsh.kind === null &&
      wizardQuickProbe.checkedAt > 0 &&
      typeof wizardQuickProbe.shell.exists === 'boolean' &&
      ['node-version', 'npm', 'pnpm', 'dsh', 'dsh-run'].every(
        (id) => envCheckOf(wizardQuickReport, id as EnvCheckId).status === 'warn',
      ) &&
      // 路径是**真实证据**：找到了就是 ok，没找到就是 missing（快速探测的判据全在文件系统上）
      envCheckOf(wizardQuickReport, 'node').status ===
        (wizardQuickProbe.node.path ? 'ok' : 'missing') &&
      // 而且它能被同一个判定函数消费（纯净机器 → blocked → 不自动启动）
      typeof envDoctor.judgeWizard(wizardQuickReport, []).gate === 'string',
  );
  const wizardBootBody = stripStrings(stripComments(functionBodyOf(envSource, 'collectBootProbe')));
  check(
    '环境向导：collectBootProbe 只读文件系统（没有 spawn / launchSpec / execFile，复用既有三个查找函数）',
    wizardBootBody.length > 200 &&
      !/\bspawn|\bexecFile|\bexecSync|\bspawnSync|\blaunchSpec/.test(wizardBootBody) &&
      !/process\.env/.test(wizardBootBody) &&
      !/collectEnvProbe\(/.test(wizardBootBody) &&
      /findNodePath\(\)/.test(wizardBootBody) &&
      /findNpm\(\)/.test(wizardBootBody) &&
      /findPnpmPath\(\)/.test(wizardBootBody),
    `${wizardBootBody.length} 字符`,
  );
  const wizardJudgeBody = stripStrings(stripComments(functionBodyOf(envSource, 'judgeWizard')));
  check(
    '环境向导：judgeWizard 是纯函数（没有 fs / 子进程 / process.* / 时钟；入参不被修改）',
    wizardJudgeBody.length > 200 &&
      !/\bfs\./.test(wizardJudgeBody) &&
      !/\bspawn|\bexecFile|\bexecSync|\bspawnSync/.test(wizardJudgeBody) &&
      !/process\.env|process\.platform|process\.versions/.test(wizardJudgeBody) &&
      !/Date\.now|\bnew Date\b/.test(wizardJudgeBody) &&
      (() => {
        const report = wizardReport({ node: 'missing' });
        const skips = wizardSkips('node', 'pnpm');
        const before = JSON.stringify(report);
        const beforeSkips = JSON.stringify(skips);
        envDoctor.judgeWizard(report, skips);
        return JSON.stringify(report) === before && JSON.stringify(skips) === beforeSkips;
      })(),
    `${wizardJudgeBody.length} 字符`,
  );

  // 渲染层的判定面：唯一来源、门禁与启动锁互斥、逃生口不经过任何安装动作
  check(
    '环境向导：gateVisible 读 bootLockVisible（门禁与启动锁互斥的唯一落点）',
    /export const gateVisible[\s\S]{0,600}?bootLockVisible\.value/.test(wizardSource) &&
      /export const bootLockVisible: Ref<boolean> = ref\(false\)/.test(bootLockSource) &&
      /export function setBootLockVisible\(on: boolean\): void \{[\s\S]{0,120}?bootLockVisible\.value = Boolean\(on\);/.test(
        bootLockSource,
      ) &&
      // 写它的人只有一个：app.ts 的 setBootLock（上锁与解锁都要写）
      /function setBootLock\(on: boolean\): void \{[\s\S]{0,300}?setBootLockVisible\(on\);/.test(
        appTsCode,
      ) &&
      (rendererCode.match(/setBootLockVisible\(on\)/g) ?? []).length === 1,
  );
  const wizardEscapeBody = blockOf(wizardSource, 'export function escapeGate(');
  check(
    '环境向导：逃生口不经过任何安装动作（只改内存相位：不发 IPC、不写盘、不看安装状态）',
    wizardEscapeBody.length > 40 &&
      /gatePhase\.value = 'escaped';/.test(wizardEscapeBody) &&
      !/api\./.test(wizardEscapeBody) &&
      !/patchSettings/.test(wizardEscapeBody) &&
      !/envWizardSkip|skipStep/.test(wizardEscapeBody) &&
      !/await|install\.value/.test(wizardEscapeBody) &&
      // 门禁的「进入界面 / 重新打开向导」同样不写盘
      /export function enterMainUi\(\): void \{[\s\S]{0,200}?gatePhase\.value = 'entered';/.test(
        wizardSource,
      ) &&
      !/patchSettings/.test(wizardSource),
  );
  check(
    '环境向导：preload 暴露 7 个新成员，且通道名与主进程 handler 一一对应',
    (() => {
      const wizardApiNames = [
        'envWizard',
        'envWizardSkip',
        'envNodePlan',
        'envNodeInstall',
        'envNodeStop',
        'onEnvInstallState',
        'onEnvInstallOutput',
      ];
      const channels = [
        'env:wizard',
        'env:wizard-skip',
        'env:node-plan',
        'env:node-install',
        'env:node-stop',
      ];
      const events = ['env:install-state', 'env:install-output'];
      return (
        wizardApiNames.every((name) => new RegExp(`\\n\\s{2}${name}:`).test(preloadCode)) &&
        channels.every(
          (channel) =>
            preloadCode.includes(`ipcRenderer.invoke('${channel}'`) &&
            envMainCode.includes(`'${channel}'`),
        ) &&
        events.every(
          (channel) =>
            preloadCode.includes(`subscribe('${channel}'`) &&
            envMainCode.includes(`sendToRenderer('${channel}'`),
        ) &&
        // 渲染层不许绕开 preload：lib/** 与 app.ts 里没有 ipcRenderer
        !/ipcRenderer/.test(rendererCode)
      );
    })(),
  );
  check(
    '环境向导：全局互斥（env:fix 与 env:node-install 读同一个忙位，两个动作不同时改机器）',
    /function anyoneBusy\(\): boolean \{[\s\S]{0,120}?return envFixRunner\.busy \|\| nodeInstaller\.busy\(\);/.test(
      envMainCode,
    ) &&
      (envMainCode.match(/envFixRunner\.busy \|\| nodeInstaller\.busy\(\)/g) ?? []).length === 1 &&
      /if \(anyoneBusy\(\)\) \{[\s\S]{0,160}?phase: 'error', message: BUSY_MESSAGE/.test(
        envMainCode,
      ) &&
      (envMainCode.match(/if \(anyoneBusy\(\)\)/g) ?? []).length === 2 &&
      /const BUSY_MESSAGE = '正在执行上一步的操作，完成后按钮会自动恢复';/.test(envMainCode),
  );
  check(
    '环境向导：渲染层只递选择（env:node-install 只取 method / mode / channel，地址与校验值由主进程现算）',
    /function parseNodeRequest\([\s\S]{0,700}?method !== 'direct' && method !== 'nvm'/.test(
      envMainCode,
    ) &&
      /mode !== 'install' && mode !== 'update'/.test(envMainCode) &&
      /channel !== undefined && channel !== 'lts' && channel !== 'current'/.test(envMainCode) &&
      /const parsed = parseNodeRequest\(request\);/.test(envMainCode) &&
      /return await nodeInstaller\.run\(parsed\);/.test(envMainCode) &&
      /return await nodeInstaller\.plan\(parsed\);/.test(envMainCode) &&
      // 渲染层递回来的 URL / sha256 / argv 一概不采信
      !/request\??\.(url|sha256|file|args)\b/.test(envMainCode) &&
      !/\.sha256\b/.test(envMainCode) &&
      // 渲染层只递三个字段：lib 里没有把计划里的地址再发回去的路径
      !/api\.envNodeInstall\(\{[^}]*url/.test(wizardSource) &&
      !/sha256/.test(wizardSource),
  );
  check(
    '环境向导：「更新 pnpm」就是既有的 install-pnpm（全局 npm 安装 argv 全仓库只有一处）',
    (() => {
      const tsFiles: string[] = [];
      const collect = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) collect(full);
          else if (entry.name.endsWith('.ts')) tsFiles.push(full);
        }
      };
      collect(srcDir);
      // 全局 npm 安装的 argv 只有一处：`['i', '-g', <spec>]`。`<spec>` 现在由 `pnpmInstallSpec()`
      // 按"有没有 VC++ 运行库"现算（VM-09），所以这里认 `'i', '-g'` 这一对字面量，
      // 再单独钉住"pnpm 那一档不是写死的版本、而是走 pnpmInstallSpec()"。
      const owners = tsFiles.filter((file) =>
        /['"]i['"],\s*['"]-g['"]/.test(fs.readFileSync(file, 'utf8')),
      );
      const envDoctorSource = fs.readFileSync(path.join(srcDir, 'main', 'env-doctor.ts'), 'utf8');
      return (
        owners.length === 1 &&
        owners[0] === path.join(srcDir, 'main', 'env-doctor.ts') &&
        // 版本策略只有一处落点（不许在别处又拼一遍 argv）
        /['"]i['"],\s*['"]-g['"],\s*pnpmInstallSpec\(/.test(envDoctorSource) &&
        // 更新入口走的是既有的 envFix（渲染层只递 action），没有第二条路
        /envFixAction|envFix/.test(preloadCode) &&
        !/install-pnpm/.test(wizardSource)
      );
    })(),
  );
  check(
    '环境向导：每个编排相位都有终态（请求失败也回 error 状态，不留一个转圈的"正在安装"）',
    // 主进程：两个入口的失败都表达成状态里的 error，而不是抛出去让渲染层干等
    /catch \(error\) \{[\s\S]{0,400}?return refusedInstallState\(message\);/.test(envMainCode) &&
      /if \(!parsed\)[\s\S]{0,40}?return refusedInstallState\(/.test(envMainCode) &&
      /refusedInstallState\(\s*'不认识的操作/.test(envMainCode) &&
      // 渲染层：IPC 自己失败时也要落一个终态（不能停在 preparing/downloading 的转圈里）
      /install\.value = \{[\s\S]{0,80}?\.\.\.EMPTY_INSTALL,[\s\S]{0,120}?phase: 'error'/.test(
        wizardSource,
      ) &&
      // 停止是同步、不抛，而且返回完整状态（安装 / 等待之后它只把 detached 置真）
      /ipcMain\.handle\([\s\S]{0,30}'env:node-stop'[\s\S]{0,80}?nodeInstaller\.stop\(\)/.test(
        envMainCode,
      ) &&
      /export async function stopNodeInstall\(\): Promise<void>/.test(wizardSource) &&
      // 相位机每一步都有下一步：逃生的下一步是 entered/done 这类收尾，不是留在 checking
      ['escaped', 'entered', 'done'].every((phase) => wizardSource.includes(`'${phase}'`)),
  );

  // ---------------------------------------------------------- 17b. t8 独立验证的三条缺陷（F-01 / F-02）
  /**
   * F-01：`judgeWizard` 必须满足冻结 §2.1「任何输入都不抛」。
   *
   * **行为断言**（不是纯静态）：真的把畸形输入喂进去，看它有没有抛、有没有给出门禁三态。
   * 可达路径是"用户手改 settings.json 成 `"envSkips": null`"，所以 `skips` 的守卫最要紧。
   */
  const asReport = (value: unknown): EnvDoctorReport => value as EnvDoctorReport;
  const asSkips = (value: unknown): EnvWizardStepId[] => value as EnvWizardStepId[];
  check(
    '环境向导（F-01）：judgeWizard 对任何输入都不抛，且总给出门禁三态 + 三步',
    (() => {
      const malformed: [string, unknown, unknown][] = [
        ['(null, null)', null, null],
        ['(undefined, undefined)', undefined, undefined],
        ['({}, undefined)', {}, undefined],
        ['({checks:"x",plans:5}, ["bogus"])', { checks: 'x', plans: 5, error: null }, ['bogus']],
        [
          '({checks:null,plans:null,error:"x"}, null)',
          { checks: null, plans: null, error: 'x' },
          null,
        ],
        ['([], [])', [], []],
        ['({error:{}}, "x")', { error: {} }, 'x'],
        ['({checks:[null,42]}, [null])', { checks: [null, 42] }, [null]],
      ];
      return malformed.every(([, report, skips]) => {
        try {
          const state = envDoctor.judgeWizard(asReport(report), asSkips(skips));
          return (
            ['open', 'blocked', 'unknown'].includes(state.gate) &&
            state.steps.length === 3 &&
            Array.isArray(state.skips) &&
            (state.currentStepId === null || envWizardStepIds.includes(state.currentStepId))
          );
        } catch {
          return false;
        }
      });
    })(),
    '8 组畸形输入（null / undefined / 字段类型全错 / checks 里混进非对象）都不抛',
  );
  /**
   * F-01 的可达路径：设置文件是用户手改得动的，`"envSkips": null` 真的会出现。
   * 主进程只允许在 `wizardSkips()` 里读它，而那个函数只用数组、其它一律当空数组 ——
   * 于是 `env:wizard` 不会 reject，向导不会永远停在"检查中 + 错误"。
   */
  check(
    '环境向导（F-01 可达路径）：设置里的 envSkips 被手改成 null 也拿得到结论',
    (() => {
      const guardBody = blockOf(envMainCode, 'function wizardSkips(): EnvWizardStepId[]');
      return (
        guardBody.length > 40 &&
        /Array\.isArray\(value\) \? \(value as EnvWizardStepId\[\]\) : \[\]/.test(guardBody) &&
        // 只有这一处读设置里的 envSkips（别的调用点都得过这道守卫）
        (envMainCode.match(/settings\.get\('envSkips'\)/g) ?? []).length === 1 &&
        (envMainCode.match(/wizardSkips\(\)/g) ?? []).length >= 3
      );
    })(),
  );
  /**
   * F-02：从主界面横幅点「重新检测」**不得**把全屏门禁层拉出来（R-08 ② / §3.8 #15）。
   * 根因是当初用"是不是一次 refresh"代替了"这一轮属不属于门禁层"——
   * 这里把那条规则钉住：`checking` 的可见性 = 第一轮 / 用户重开 / 层本来就在屏幕上。
   * （**行为面**由验证者的独立用例 `scripts/env-wizard-cases.mjs` 的 K11 用可控 Promise 桩
   *  在"等待期间"取样证明，那份脚本由本门禁自动收录，不归我改。）
   */
  check(
    '首启门禁（F-02）：横幅触发的 checking 不显示门禁层（判据是"这一轮属不属于门禁层"，不是 refresh）',
    /const belongsToGateLayer = !started \|\| reopenRequested \|\| layerWasVisible;/.test(
      wizardSource,
    ) &&
      /checkingVisible = belongsToGateLayer;/.test(wizardSource) &&
      // 改之前那种写法（用 refresh 当判据 / 用上一轮的可见性推下一轮）必须已经消失
      !/checkingVisible = showChecking/.test(wizardSource) &&
      !/visibleAfterRound/.test(wizardSource) &&
      // 取样必须在改相位之前（否则读到的是刚写进去的 checking）
      wizardSource.indexOf('const layerWasVisible = gateVisible.value;') <
        wizardSource.indexOf("gatePhase.value = 'checking';"),
  );
  /**
   * F-03：`src/shared/ipc.ts` 与冻结文档 §3.1~§3.4 的"逐字可贴"块必须完全一致
   *（船长已核实是**契约文件错、不是文档错**）。断言直接拿文档里的代码块来比对 ——
   * 以后任何"顺手改一个字"都会红；`signer` 的语义也必须写着"尚未读取"（不是"未签名"）。
   */
  check(
    '契约（F-03）：ipc.ts 与冻结 §3.1~§3.4 的逐字块完全一致（具名 EnvReleaseSigning + signer = 尚未读取）',
    (() => {
      const freezeDoc = fs.readFileSync(
        path.join(repoRoot, 'docs', 'env-wizard-freeze.md'),
        'utf8',
      );
      const blockAfter = (heading: string): string => {
        const start = freezeDoc.indexOf(heading);
        if (start < 0) return '';
        const open = freezeDoc.indexOf('```ts\n', start);
        const close = freezeDoc.indexOf('\n```', open + 6);
        return open >= 0 && close > open ? freezeDoc.slice(open + 6, close) : '';
      };
      const headings = [
        '### 3.1 门禁与步骤',
        '### 3.2 Node 安装 / 更新通道',
        '### 3.3 `DshConsoleApi` 的增量',
        '### 3.4 设置项增量',
      ];
      const blocks = headings.map(blockAfter);
      const planBody = /\nexport interface EnvNodePlan \{([\s\S]*?)\n\}/.exec(ipcSource)?.[1] ?? '';
      return (
        blocks.every((block) => block.length > 200 && ipcSource.includes(block)) &&
        // 具名类型（不是内联联合）
        /export type EnvReleaseSigning = 'signed' \| 'unsigned' \| 'unknown';/.test(blocks[1]) &&
        /releaseSigning: EnvReleaseSigning;/.test(planBody) &&
        // signer 只有一个含义：计划阶段恒为 null = "尚未读取"，绝不是"未签名"

        /计划阶段恒为 null，语义是"尚未读取"/.test(planBody) &&
        !/未签名 \/ 读不到时为 null/.test(planBody) &&
        // R-25 / R-26 / R-27 同步过的三处注释都在（后来者照着旧注释就会把未签名确认加回计划阶段）
        /1\.2\.x 的资产 digest 是 none/.test(planBody) &&
        /校验清单取不到（网络类）/.test(planBody) &&
        /发布元数据的\*\*签名自述（R-27）/.test(planBody)
      );
    })(),
  );

  // ---------------------------------------------------------- 17c. VM 实测（VM-03 / VM-04）
  /** VM 那台机器的探测形状：版本管理器目录里有 node.exe，但 `node --version` 出不来结果 */
  const vmProbeRaw = (over: Partial<envDoctor.EnvProbeRaw> = {}): envDoctor.EnvProbeRaw =>
    envProbe({
      node: envVersionProbe({
        path: 'C:\\Users\\vm\\AppData\\Roaming\\nvm\\node.exe',
        version: null,
        exitCode: 0,
        error: null,
      }),
      ...over,
    });
  /**
   * VM-03：完成判据必须回到"真的能跑"这条线上。
   *
   * VM 实测现场：第一步显示「已完成」，而下一步的 npm 立刻报
   * "No active Node.js version is configured"。旧判据只看"文件在不在"，
   * 而阶段一 `canRunDsh` 早就定下同一条纪律：**有输出才算可用**。
   */
  const vmDeadNodeReport = envDoctor.judgeEnvironment(vmProbeRaw());
  const vmDeadNodeState = envDoctor.judgeWizard(vmDeadNodeReport, []);
  check(
    '环境自检（VM-03）：Node 的文件在、但跑不出结果 → 这一项判「不可用」（missing），不是黄灯',
    envCheckOf(vmDeadNodeReport, 'node').status === 'ok' &&
      envCheckOf(vmDeadNodeReport, 'node-version').status === 'missing' &&
      /没有任何输出/.test(envCheckOf(vmDeadNodeReport, 'node-version').detail) &&
      Boolean(envCheckOf(vmDeadNodeReport, 'node-version').fixHint),
  );
  check(
    '环境向导（VM-03）：第一步只在"真的能跑"时才算完成（VM 上它曾经显示「已完成」）',
    wizardStepOf(vmDeadNodeState, 'node').status === 'todo' &&
      vmDeadNodeState.gate === 'blocked' &&
      vmDeadNodeState.currentStepId === 'node' &&
      vmDeadNodeState.steps.length === 3,
  );
  const vmSilentNpm = envDoctor.judgeEnvironment(
    envProbe({ npm: envVersionProbe({ version: null, exitCode: 1, error: null }) }),
  );
  const vmSilentPnpm = envDoctor.judgeEnvironment(
    envProbe({ pnpm: envVersionProbe({ version: null, exitCode: 0, error: null }) }),
  );
  const vmBlockedNode = envDoctor.judgeEnvironment(
    envProbe({
      node: envVersionProbe({
        path: '/usr/bin/node',
        version: null,
        exitCode: null,
        error: 'spawnSync EPERM',
      }),
    }),
  );
  check(
    '环境自检（VM-03）：黄灯只留给"这个运行环境不允许起子进程"（EPERM 一类），其余跑不起来＝不可用',
    envCheckOf(vmBlockedNode, 'node-version').status === 'warn' &&
      envCheckOf(vmSilentNpm, 'npm').status === 'missing' &&
      envCheckOf(vmSilentPnpm, 'pnpm').status === 'missing',
  );

  /** 冻结 §3.8 #22 的词表（界面文案里不许出现的内部术语） */
  const VM_FORBIDDEN = [
    'PATH',
    'dsh.cmd',
    'npx',
    'COMSPEC',
    'verbatim',
    'SHA256',
    'SHASUMS256',
    'NVM_SYMLINK',
    'NVM_HOME',
  ];
  const vmForbiddenIn = (text: string): string[] =>
    VM_FORBIDDEN.filter((word) =>
      new RegExp(
        `(?<![\\w.$])${word.replace('.', '\\.')}(?![\\w$])`,
        word === 'verbatim' ? 'i' : '',
      ).test(text),
    );
  check(
    '首启门禁（VM-04）：主进程产出的用户可见文案里不出现内部术语（拿 VM 那台的夹具真跑一遍）',
    (() => {
      // 夹具里刻意带上 VM 现场那句原始报错（它含 PATH / dsh.cmd / npx）——
      // 旧代码把它原样贴进 detail，界面上就出现了内部术语；这条断言必须对那种写法变红。
      const report = envDoctor.judgeEnvironment(
        vmProbeRaw({
          npm: envVersionProbe({
            path: 'C:\\Program Files\\nodejs\\npm.cmd',
            version: null,
            exitCode: 1,
            error: 'No active version',
          }),
          pnpm: envVersionProbe({ path: null, version: null, exitCode: null }),
          dsh: envDshProbe({
            kind: null,
            display: null,
            runs: false,
            resolveError: '找不到 dsh: PATH 里没有 dsh.cmd，也没有 npx。请在设置里指定启动命令。',
          }),
        }),
      );
      const texts: string[] = [];
      for (const item of report.checks) texts.push(item.detail, item.fixHint ?? '');
      for (const plan of report.plans) texts.push(plan.note, plan.display);
      return texts.length >= 10 && texts.every((text) => vmForbiddenIn(text).length === 0);
    })(),
  );
  check(
    '首启门禁（VM-04）：主进程源码里的用户可见文案也不出现内部术语（覆盖面补到"主进程产出"）',
    (() => {
      /** 抠一段代码里的字符串字面量（注释已剥） */
      const literalsOf = (code: string): string[] =>
        [...code.matchAll(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g)].map((match) => match[0]);
      /** 与探测内部取值比较用的字面量（`raw.dsh.kind === 'npx'`）不是界面文案 */
      const comparedLiterals = (code: string): Set<string> =>
        new Set(
          [...code.matchAll(/(?:===|!==)\s*((['"`])(?:\\.|(?!\2)[^\\])*\2)/g)].map(
            (match) => match[1],
          ),
        );
      const copyLiteralsOf = (code: string): string[] => {
        const compared = comparedLiterals(code);
        return literalsOf(code).filter((literal) => !compared.has(literal));
      };
      const envDoctorCopy = copyLiteralsOf(
        stripComments(fs.readFileSync(path.join(srcDir, 'main', 'env-doctor.ts'), 'utf8')),
      );
      const wizardCopy = copyLiteralsOf(
        stripComments(fs.readFileSync(path.join(rendererDir, 'lib', 'env-wizard.ts'), 'utf8')),
      );
      // 安装引擎那边只算"界面会显示的字段"里的值：`NVM_HOME` / `SHASUMS256.txt` 这类
      // 环境变量键名与 URL 不上界面（它们出现在别的语句里，不该被这条断言误伤）
      const installerFields = [
        ...stripComments(
          fs.readFileSync(path.join(srcDir, 'main', 'node-installer.ts'), 'utf8'),
        ).matchAll(
          /(?:detail|fixHint|note|message|refuseReason|evidence|summary|display|target)\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g,
        ),
      ].map((match) => match[0]);
      const groups = [envDoctorCopy, wizardCopy, installerFields];
      const violations = groups.flatMap((group) =>
        group.filter((text) => vmForbiddenIn(text).length > 0),
      );
      return (
        groups.every((group) => group.length > 0) &&
        violations.length === 0 &&
        // 反过来证明这条断言真的看得见东西：把 VM 现场那句话塞进同一套规则里，必须命中
        vmForbiddenIn('找不到 dsh: PATH 里没有 dsh.cmd，也没有 npx。').length === 3
      );
    })(),
  );

  // ---------------------------------------------------------- 17e. VM-13：不许把应用能做的事推给用户
  //    与 VM-04 的词表规则并列：一个不许把**内部记号**暴露给用户，一个不许把**活**推给用户。
  //    F-05 的现场：门禁第一步的事实行（env-doctor 的 node-version detail）写着「…（先在终端里选一个
  //    版本，或重装官方 Node）」，而它就显示在两条一键安装路的并列位置上 —— 一边给「安装」按钮，
  //    一边让用户自己去终端里选。上一轮只扫了 `installerCode`（引擎侧），漏了这里。
  /** 把人打发的表述（出现即红）。`你自己有权限的终端` 那种**真的只能用户做**的情形不在此列，见下 */
  const PUNTING_PHRASES = [
    '先在终端',
    '先在命令行',
    '到终端里去',
    '自己打开终端',
    '自己去终端',
    '自己到终端',
    '自行在终端',
    '手动到终端',
    '手动在终端',
    '你自己去敲',
  ];
  check(
    '环境自检（VM-13）：门禁事实行不再把用户打发去终端，且「管理器在、零版本」说的是那一种状态',
    (() => {
      // 客机状态：node.exe 在版本管理器的目录里，但跑不出结果（零版本）
      const fixture = envProbe({
        node: envVersionProbe({
          path: 'C:\\Users\\tester\\AppData\\Local\\Software\\nvm\\nodejs\\node.exe',
          version: null,
          exitCode: 0,
          error: null,
        }),
        nodeFromVersionManager: true,
      });
      const report = envDoctor.judgeEnvironment(fixture);
      const texts: string[] = [];
      for (const item of report.checks) texts.push(item.detail, item.fixHint ?? '');
      for (const plan of report.plans) texts.push(plan.note, plan.display);
      const dynamicHits = texts.filter((text) =>
        PUNTING_PHRASES.some((phrase) => text.includes(phrase)),
      );
      const versionRow = report.checks.find((item) => item.id === 'node-version');
      // 静态：env-doctor 里所有字符串字面量（注释已剥）—— 与 VM-04 那两条同一套做法
      const literals = [...stripComments(envSource).matchAll(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g)].map(
        (match) => match[0],
      );
      const staticHits = literals.filter((literal) =>
        PUNTING_PHRASES.some((phrase) => literal.includes(phrase)),
      );
      return (
        // ① 行为：这一状态必须说中它（版本管理器在、零版本），出路指向应用内那条路
        versionRow?.status === 'missing' &&
        /版本管理器/.test(versionRow.detail) &&
        /安装/.test(versionRow.fixHint ?? '') &&
        // ② 两种扫法都不许命中"打发用户"的表述
        dynamicHits.length === 0 &&
        staticHits.length === 0 &&
        // ③ 自证：同一套规则对**修之前那句**必须命中（变异实验的断言版）
        PUNTING_PHRASES.some((phrase) =>
          '版本管理器还没选中一个版本时也是这个样子（先在终端里选一个版本，或重装官方 Node）'.includes(
            phrase,
          ),
        )
      );
    })(),
  );
  check(
    '环境自检（VM-13）：「这一轮没测」（快速探测）的出路不是"去终端跑一次"',
    (() => {
      // skipped 的项只是**我们**还没测（1.5 秒后完整检测就来），没有任何东西坏掉
      const skipped = envProbe({
        node: envVersionProbe({ version: null, exitCode: null, skipped: true }),
        npm: envVersionProbe({ path: '/opt/npm', version: null, exitCode: null, skipped: true }),
        pnpm: envVersionProbe({ path: '/opt/pnpm', version: null, exitCode: null, skipped: true }),
        dsh: envDshProbe({
          kind: null,
          display: null,
          runs: false,
          version: null,
          resolveError: null,
          skipped: true,
        }),
      });
      const report = envDoctor.judgeEnvironment(skipped);
      const hints = report.checks
        .filter((item) => /这一轮没测/.test(item.detail))
        .map((item) => item.fixHint ?? '');
      return (
        hints.length >= 5 &&
        hints.every((hint) => /完整检测/.test(hint)) &&
        hints.every((hint) => !PUNTING_PHRASES.some((phrase) => hint.includes(phrase))) &&
        // 「这个运行环境不允许起子进程」是**真的只能用户做**：那里保留"手工确认"，并先让用户点重新检测
        /重新检测/.test(
          envCheckOf(
            envDoctor.judgeEnvironment(
              envProbe({
                node: envVersionProbe({
                  path: '/usr/bin/node',
                  version: null,
                  exitCode: null,
                  error: 'spawnSync EPERM',
                }),
              }),
            ),
            'node-version',
          ).fixHint ?? '',
        )
      );
    })(),
  );

  // ---------------------------------------------------------- 17d. 原始错误进日志（VM-04 的另一半）
  //    裁定②是成对的：「细节留日志、结论给人话」。17c 钉住了「界面里找不到」，
  //    这一节钉住另一半 —— 被撤下去的那句原文必须**真的落到日志里**（`EnvDoctorHooks.log`），
  //    否则它既不在界面上、也不在日志里，下次真机排查就只能靠猜。
  /** VM 现场那句原始报错：含 PATH / dsh.cmd / npx，界面上一律不许出现 */
  const vmResolveError = '找不到 dsh: PATH 里没有 dsh.cmd，也没有 npx。请在设置里指定启动命令。';
  const vmLogRaw = vmProbeRaw({
    npm: envVersionProbe({
      path: 'C:\\Program Files\\nodejs\\npm.cmd',
      version: null,
      exitCode: 1,
      error: null,
      // VM 上那句原因**只在 stderr 上**（error 是 null）：界面不许显示它，日志必须留下它
      stderr: 'No active Node.js version is configured',
    }),
    pnpm: envVersionProbe({ path: null, version: null, exitCode: null }),
    dsh: envDshProbe({ kind: null, display: null, runs: false, resolveError: vmResolveError }),
  });
  const vmLogReport = envDoctor.judgeEnvironment(vmLogRaw);
  const vmLogLines = envDoctor.probeTroubleLines(vmLogRaw, vmLogReport);
  const vmLogText = vmLogLines.join('\n');
  /** 报告里所有"用户看得见"的字符串（界面文案的取值面，与 17c 同一套口径） */
  const vmVisibleTexts = (report: EnvDoctorReport): string[] => {
    const texts: string[] = [];
    for (const item of report.checks) texts.push(item.detail, item.fixHint ?? '');
    for (const plan of report.plans) texts.push(plan.note, plan.display);
    return texts;
  };
  check(
    '首启门禁（VM-04 的另一半）：被界面撤下去的原始错误落进日志（子进程错误串 / stderr / dsh 定位原文）',
    vmLogLines.length >= 3 &&
      vmLogText.includes(vmResolveError) &&
      /node --version[\s\S]*退出码 0/.test(vmLogText) &&
      // 这句只可能来自 stderr（`error` 是 null）：stderr 没接进日志的话这条就红
      /stderr：No active Node.js version is configured/.test(vmLogText) &&
      vmLogLines.every((line) => line.length > 0),
  );
  check(
    '首启门禁（VM-04 的另一半）：同一份夹具，界面文案里仍然找不到这些内部术语（词表不放松）',
    (() => {
      const visible = vmVisibleTexts(vmLogReport);
      // 成对判据：日志里**有**这些词（它记的就是原文），界面文案里一个都不许有
      return (
        visible.length >= 10 &&
        vmForbiddenIn(vmLogText).length >= 3 &&
        visible.every((text) => vmForbiddenIn(text).length === 0)
      );
    })(),
  );
  const vmBlockedRaw = envProbe({
    node: envVersionProbe({
      path: '/usr/bin/node',
      version: null,
      exitCode: null,
      error: 'spawnSync EPERM',
    }),
  });
  const vmBlockedReport = envDoctor.judgeEnvironment(vmBlockedRaw);
  const vmBlockedLines = envDoctor.probeTroubleLines(vmBlockedRaw, vmBlockedReport);
  check(
    '首启门禁（VM-04 的另一半）：黄灯（这个环境不允许起子进程）也把原文记下来 —— 日志里有，界面上没有',
    envCheckOf(vmBlockedReport, 'node-version').status === 'warn' &&
      vmBlockedLines.some((line) => line.includes('spawnSync EPERM')) &&
      // 没写 stderr 的夹具不会长出 `stderr：undefined`（可选字段要干净地缺席）
      !vmBlockedLines.join('\n').includes('stderr') &&
      vmVisibleTexts(vmBlockedReport).every((text) => !/EPERM/.test(text)),
  );
  /** 快速探测的形状（`collectBootProbe`）：这一轮**不起子进程**，所以没有任何原文可记 */
  const envSkippedProbe = envProbe({
    node: envVersionProbe({ version: null, exitCode: null, skipped: true }),
    npm: envVersionProbe({
      path: '/opt/homebrew/bin/npm',
      version: null,
      exitCode: null,
      skipped: true,
    }),
    pnpm: envVersionProbe({
      path: '/opt/homebrew/bin/pnpm',
      version: null,
      exitCode: null,
      skipped: true,
    }),
    dsh: envDshProbe({
      kind: null,
      display: null,
      runs: false,
      version: null,
      resolveError: null,
      skipped: true,
    }),
  });
  check(
    '环境自检：日志不刷屏 —— 正常的机器一条都不记，快速探测（没起子进程）没有原文可记',
    envDoctor.probeTroubleLines(envProbe(), envAllOk).length === 0 &&
      envDoctor.judgeEnvironment(envSkippedProbe).counts.warn >= 3 &&
      envDoctor.probeTroubleLines(envSkippedProbe, envDoctor.judgeEnvironment(envSkippedProbe))
        .length === 0,
  );
  check(
    '环境自检：日志行是纯函数算出来的（自检直接喂夹具；模块自己不碰 console / logger）',
    (() => {
      const body = stripStrings(blockOf(envSource, 'export function probeTroubleLines('));
      return (
        body.length > 200 &&
        !/\bfs\./.test(body) &&
        !/\bspawn|execFile|execSync|spawnSync/.test(body) &&
        !/process\.(env|platform|versions)/.test(body) &&
        !/Date\.now|new Date\b/.test(body) &&
        !/console\./.test(envCode)
      );
    })(),
  );
  check(
    '环境自检：stderr 只走日志这条路（判定不读它；不写它的旧夹具也照常跑）',
    /stderrTail\(stderr\)/.test(envCode) &&
      /let stderr = '';/.test(envCode) &&
      /stderr: run\.stderr,/.test(envCode) &&
      /export const STDERR_TAIL_CHARS = \d+;/.test(envSource) &&
      // 判定不看 stderr：结论仍然只由「有输出才算可用」那条线决定
      !/stderr/.test(envJudgeBody) &&
      /stderr/.test(blockOf(envSource, 'export function probeTroubleLines(')),
  );
  check(
    '环境自检：日志钩子是可选的（不传也照常跑），main.ts 接的是既有 logger、不另造通道',
    (() => {
      const hooksBody = blockOf(envSource, 'export interface EnvDoctorHooks {');
      const mainEnvBlock = blockOf(envMainCode, 'new EnvDoctor(settings, {');
      const envLogLine = /log: \(line\) =>[^\n]*/.exec(mainEnvBlock)?.[0] ?? '';
      return (
        // `log?`：既有调用方一个字都不改也能编译、也能跑
        /\blog\?:\s*\(line: string\) => void;/.test(hooksBody) &&
        // 主进程把它接进 console —— logger.ts 早把 console 落盘成 <userData>/logs/console.log
        /console\.log\(/.test(envLogLine) &&
        /\[env\]/.test(envLogLine) &&
        // 原文不进事件日志：那是用户看得见的界面，正是它不该出现的地方
        !/dshManager/.test(envLogLine) &&
        /installFileLogging\(path\.join\(app\.getPath\('userData'\), 'logs'\)\)/.test(
          envMainCode,
        ) &&
        // 记日志只经过可选的 `hooks.log`（模块自己不起一套日志通道）
        /this\.hooks\.log/.test(envSource)
      );
    })(),
  );

  // ---------------------------------------------------------- 18. 门禁界面与安装引擎
  //    冻结文档 §3.8 里"由渲染层 / 安装引擎提清单、由契约与编排落地"的那几条
  //    （第 12~14、16、19、20、22、23 条）。`test/selftest.ts` 只由契约与编排改（§5.3）。
  const gateCode = stripComments(
    fs.readFileSync(path.join(rendererDir, 'shell', 'EnvGate.vue'), 'utf8'),
  );
  const gateRaw = fs.readFileSync(path.join(rendererDir, 'shell', 'EnvGate.vue'), 'utf8');
  const topBarCode = stripComments(
    fs.readFileSync(path.join(rendererDir, 'shell', 'TopBar.vue'), 'utf8'),
  );
  const installerCode = stripComments(
    fs.readFileSync(path.join(srcDir, 'main', 'node-installer.ts'), 'utf8'),
  );
  const escapeButtonTag = /<button[^>]*@click="escape"[^>]*>/.exec(gateRaw)?.[0] ?? '';
  const gateEscapeBody = blockOf(gateCode, 'function escape(): void');
  check(
    '首启门禁：逃生口不写盘、不依赖任何安装动作（组件里没有 patchSettings / envWizardSkip）',
    gateCode.length > 500 &&
      !/patchSettings/.test(gateCode) &&
      !/envWizardSkip/.test(gateCode) &&
      gateEscapeBody.length > 10 &&
      /escapeGate\(\);/.test(gateEscapeBody) &&
      !/api\.|await|install\.value/.test(gateEscapeBody) &&
      // 逃生按钮那一行不带 `:disabled` / `v-if` / `v-show`：忙位与相位都拦不住它
      escapeButtonTag.length > 40 &&
      !/:disabled|v-if|v-show/.test(escapeButtonTag) &&
      /v-if="screen !== 'released'"[\s\S]{0,200}?@click="escape"/.test(gateRaw),
  );
  check(
    '首启门禁：跳过 / 恢复只走 envWizardSkip（渲染层那两处都不碰 patchSettings）',
    (() => {
      const confirmSkipBody = blockOf(gateCode, 'async function confirmSkip(): Promise<void>');
      const restoreStepBody = blockOf(envPaneCode, 'async function restoreStep(');
      return (
        confirmSkipBody.length > 20 &&
        /skipStep\('pnpm', true\)/.test(confirmSkipBody) &&
        !/patchSettings/.test(confirmSkipBody) &&
        restoreStepBody.length > 20 &&
        /skipStep\(step, false\)/.test(restoreStepBody) &&
        !/patchSettings/.test(restoreStepBody)
      );
    })(),
  );
  const tabOrderBody = /const TAB_ORDER: TabId\[\] = \[([\s\S]*?)\];/.exec(appTsCode)?.[1] ?? '';
  check(
    '首启门禁：门禁层不是页面（TAB_ORDER 与 panes 清单里都没有它，容器与启动锁同级）',
    tabOrderBody.length > 0 &&
      !/gate/i.test(tabOrderBody) &&
      !/panes\/[\w]*Gate/i.test(mountJs) &&
      !/id="pane-gate"/.test(html) &&
      /from '\.\/shell\/EnvGate\.vue'/.test(mountJs) &&
      /from '\.\/shell\/GateBanner\.vue'/.test(mountJs) &&
      /id="gate-root"/.test(html) &&
      /id="boot-lock"/.test(html) &&
      // 同一层：门禁容器在启动锁之前，两者都在九页容器之外
      html.indexOf('id="gate-root"') < html.indexOf('id="boot-lock"'),
  );
  check(
    '首启门禁：顶栏的标题与"右侧控件收起"读同一个 gateVisible（R-03）',
    (topBarCode.match(/gateVisible/g) ?? []).length >= 3 &&
      // 标题里的门禁分支只由 gateVisible 决定（t45 起前面还有一条"详情层面包屑"，所以是 if 而不是三元）
      /if \(gateVisible\.value\) return '运行环境准备';/.test(topBarCode) &&
      /v-if="!gateVisible"/.test(topBarCode) &&
      // 顶栏不许自己去读判定结果（两套显示条件就会漂）
      !/wizard\.value|gatePhase|judgeWizard/.test(topBarCode),
  );
  /**
   * 评审 T11-B：键盘捷径的改道判据必须是「门禁层**接管着**界面」，不是 `gateVisible`。
   *
   * 两者在收尾相位上都会是 false —— 但那是「不该显示」，不是「正在显示」。靠"恰好"成立的东西
   * 会被下一次无关改动打破（谁给某个收尾相位加一种显示，Ctrl+R 就又会被吃掉），而交互 §2.5
   * 写的是「逃生口点了之后恢复」。所以这里钉住两件事：收尾相位**显式放行**，且键盘那一段读的
   * 是这个判据本身。
   */
  const gateDiversionBody = blockOf(appTsCode, 'const gateDiversion = computed(');
  const shortcutBody = blockOf(appTsCode, 'function wireShortcuts(): void');
  check(
    '首启门禁：逃生 / 放行 / 收尾之后键盘捷径恢复（改道判据不是 gateVisible 自己）',
    gateDiversionBody.length > 100 &&
      ['escaped', 'entered', 'done', 'unknown'].every((phase) =>
        gateDiversionBody.includes(`'${phase}'`),
      ) &&
      /if \(gateDiversion\.value\)/.test(shortcutBody) &&
      !/gateVisible\.value/.test(shortcutBody),
  );
  check(
    '安装引擎：不拼 shell（spawn 数组 + launchSpec + 补过 PATH + stdio 数组 + 没有 shell: true）',
    /spawn\(file, args, \{/.test(installerCode) &&
      /envWithKnownBins\(process\.env\)/.test(installerCode) &&
      /stdio: \['ignore', 'pipe', 'pipe'\]/.test(installerCode) &&
      !/shell:\s*true/.test(installerCode) &&
      /launchSpec\(/.test(installerCode) &&
      !/spawn\(\s*'[^']*\.cmd'/.test(installerCode),
  );
  const detachBody = blockOf(installerCode, 'detachOnQuit(): void');
  check(
    '安装引擎：退出时不杀安装器（只有下载 / 校验那一支被取消，安装 / 等待不碰 child）',
    detachBody.length > 40 &&
      !/\.kill\(/.test(detachBody) &&
      ['preparing', 'downloading', 'verifying'].every((phase) =>
        detachBody.includes(`'${phase}'`),
      ) &&
      !/'installing'|'waiting'/.test(detachBody),
  );
  // 计划里那句 `note` 是确认区的风险说明：它**不许**替发布方断言"没有数字签名"
  const installerPlanNotes = [
    ...installerCode.matchAll(/note:\s*(?:'([^']*)'|`([^`]*)`|\[([\s\S]{0,400}?)\])/g),
  ].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
  check(
    '安装引擎：未签名的结论只在读到之后说（计划阶段的 signer === null 不推出未签名）',
    installerCode.length > 1000 &&
      installerPlanNotes.length >= 3 &&
      installerPlanNotes.every((note) => !/没有数字签名|未签名/.test(note)) &&
      // 发布自述来自一个可离线测的纯函数（三档都认），官方直装恒为 unknown
      /export function parseReleaseSigning\(body: string\): 'signed' \| 'unsigned' \| 'unknown'/.test(
        installerCode,
      ) &&
      (installerCode.match(/releaseSigning: 'unknown'/g) ?? []).length >= 2 &&
      /releaseSigning,/.test(installerCode) &&
      // "读到之后"那条路（安装包真没签名）才读 releaseSigning 决定继续还是中止
      /plan\.releaseSigning === 'unsigned'/.test(installerCode),
    `${installerPlanNotes.length} 处 plan.note`,
  );
  // ---------------------------------------------------------- 18a. 向导的视图相位（t43）
  //    冻结 §0.3 的 R-28 ~ R-31：左轨走过的节点可点（回看）、正文画"正在看哪一步"、
  //    判定前进不推人、用户显式重开的那一轮判成 open 也显示放行页。
  //    纯规则在 `lib/wizard-view.ts`（直接测），接线与"回看卡里没有动作"在 EnvGate.vue / env-wizard.ts。
  const stepOf = (id: EnvWizardStepId, status: EnvStepStatus): EnvWizardStep => ({
    id,
    status,
    detail: `${id} 的判据（带路径与版本）`,
    checkIds: [],
    skippable: id === 'pnpm',
    fixAction: null,
  });
  const viewSteps = [stepOf('node', 'done'), stepOf('pnpm', 'done'), stepOf('dsh', 'todo')];
  check(
    '环境向导：左轨只有走过的步骤能点开看（已完成 / 已跳过可以，当前与没轮到的都不行）',
    wizardView.canViewStep(stepOf('node', 'done'), 'dsh') === true &&
      wizardView.canViewStep(stepOf('pnpm', 'skipped'), null) === true &&
      // 当前步骤不给"可看"：点它的意思是回到当前（调用方把钉住清掉），不是钉住它
      wizardView.canViewStep(stepOf('dsh', 'todo'), 'dsh') === false &&
      // 还没轮到的、以及"我们没测出来"的，都不给点
      wizardView.canViewStep(stepOf('pnpm', 'todo'), 'dsh') === false &&
      wizardView.canViewStep(stepOf('dsh', 'unknown'), null) === false,
  );
  check(
    '环境向导：正文画的是钉住的那一步（那一步不再成立时静默回到当前，不停在一条不成立的回看上）',
    wizardView.resolveViewedStep('dsh', 'node', viewSteps) === 'node' &&
      wizardView.resolveViewedStep('dsh', null, viewSteps) === 'dsh' &&
      // 钉住的那一步已经不是"走过的"了（新报告换了状态）→ 回到当前
      wizardView.resolveViewedStep('dsh', 'node', [
        stepOf('node', 'todo'),
        stepOf('pnpm', 'done'),
        stepOf('dsh', 'todo'),
      ]) === 'dsh' &&
      // 那一步从列表里消失（兜底）→ 回到当前
      wizardView.resolveViewedStep('dsh', 'node', [stepOf('dsh', 'todo')]) === 'dsh' &&
      // 三步都完成（判定给的当前步骤是 null）+ 没钉住 → 正文没有步骤可画
      wizardView.resolveViewedStep(null, null, [stepOf('node', 'done')]) === null,
  );
  check(
    '环境向导：判定前进只出一行提示、不把用户推走（两种前进的文案 + 没前进时不出提示）',
    (() => {
      const titles: Record<EnvWizardStepId, string> = {
        node: '安装 Node.js',
        pnpm: '安装 pnpm',
        dsh: '安装 dsh',
      };
      const title = (id: EnvWizardStepId): string => titles[id];
      const next = wizardView.advanceNotice(
        'pnpm',
        { stepId: 'node', currentAtPin: 'node' },
        title,
      );
      const done = wizardView.advanceNotice(null, { stepId: 'node', currentAtPin: 'node' }, title);
      return (
        // 没钉住（第二个参数 null）→ 没有提示
        wizardView.advanceNotice('node', null, title) === null &&
        // **判定没动**也没有提示：用户只是往回翻看，当前步骤原地没动 ——
        // 真机验证抓到的第一版就是拿"正在看的 ≠ 当前"当判据，于是回看第一步时冒出一句
        // 错的「下一步（安装 dsh）也已经就绪了」（dsh 那时还没好）
        wizardView.advanceNotice('dsh', { stepId: 'node', currentAtPin: 'dsh' }, title) === null &&
        // 从**放行页**点开回看（钉住时本来就没有当前步骤）→ 不能与"没钉住"混为一谈，
        // 判定变成已放行时同样要出「三步都完成了」（真机验证抓到的第二处）
        wizardView.advanceNotice(null, { stepId: 'node', currentAtPin: null }, title) === null &&
        // 第一步在完成、判定前进了
        next?.text === '下一步（安装 pnpm）也已经就绪了' &&
        next.action === '继续' &&
        // 三步全部完成：当前步骤成了 null
        done?.text === '三步都完成了' &&
        done.action === '看看结果'
      );
    })(),
    '两种前进',
  );
  const reviewCard = gateRaw.slice(
    gateRaw.indexOf('<div v-if="reviewStep"'),
    gateRaw.indexOf('<div v-else-if="currentStep"'),
  );
  const railButton =
    /<button[\s\S]{0,400}?class="gate-node-body gate-node-button"[\s\S]{0,400}?↩ 回看这一步/.exec(
      gateRaw,
    )?.[0] ?? '';
  check(
    '环境向导：左轨走过的节点是按钮（进 Tab 顺序、aria-current 标出正在看的那一步）',
    railButton.length > 100 &&
      /:aria-current="item\.viewed \? 'true' : undefined"/.test(railButton) &&
      /@click="viewStepFromRail\(item\.id\)"/.test(railButton) &&
      // 没走到的那一支仍然是纯读数（div，不是按钮；保持 R-01 ② 的原意）
      /<div v-else class="gate-node-body">/.test(gateRaw) &&
      // 可点与否来自纯函数，不在模板里手写状态判断
      /viewable: canViewStep\(step, id\)/.test(gateCode),
  );
  check(
    '环境向导：只读回看卡里没有安装 / 跳过动作（回看时屏上仍然只有一件事可做）',
    reviewCard.length > 200 &&
      /reviewStep\.detail/.test(reviewCard) &&
      /@click="backToCurrent"/.test(reviewCard) &&
      !/openNodeConfirm|openFixConfirm|openSkipConfirm|runNodeInstall|runEnvFix|openNodeSwitch|retryFix|skipStep/.test(
        reviewCard,
      ) &&
      // 两句结论都在卡里（已完成 / 你选择了跳过）
      /这一步已经完成，不用再做什么/.test(reviewCard) &&
      /这一步你选择了跳过/.test(reviewCard),
  );
  check(
    '环境向导：判定前进 / 重开后正文不会被推走（回看优先于放行页、新报告不清钉住）',
    // 回看优先于放行页：钉住期间判定即使已经放行，正文也留在回看卡上，点了「看看结果」才进放行页
    /const screen = computed<'checking' \| 'blocked' \| 'released'>\(\(\) => \{[\s\S]{0,300}?if \(reviewStep\.value\) return 'blocked';/.test(
      gateCode,
    ) &&
      // 提示行是唯一的前进入口（不是自动跳）
      /v-if="notice"[\s\S]{0,260}?@click="backToCurrent"/.test(gateCode) &&
      // 新报告进来时**不许**清钉住 —— 清了就等于把用户推走
      !/pinnedStepId/.test(blockOf(wizardSource, 'function applyWizardState(')) &&
      // 挡住页的表头跟着判定说：回看时不能把"已就绪"说成"还没准备好"
      /wizard\?\.gate === 'open' \? '运行环境已经就绪' : '运行环境还没准备好'/.test(gateCode),
  );
  check(
    '环境向导：用户显式重开的那一轮判成 open 也显示放行页（R-31），离开时把这一轮与钉住都清掉',
    (() => {
      const gateVisibleBody = blockOf(wizardSource, 'export const gateVisible');
      const reopenBody = blockOf(wizardSource, 'export function reopenGate(');
      const selectBody = blockOf(wizardSource, 'export function selectViewedStep(');
      return (
        /if \(phase === 'released'\) return blocking \|\| reopened;/.test(gateVisibleBody) &&
        /reopened = true;/.test(reopenBody) &&
        /pinnedStepId\.value = null;/.test(reopenBody) &&
        // 点当前步骤 / 点一个看不动的步骤 → 回来（不是钉住一个不允许看的步骤）；
        // 同时记下"钉住那一刻判定在哪一步"，判定后来往前挪了才出提示（R-30）
        /const viewable = canViewStep\(step, state\.currentStepId\);/.test(selectBody) &&
        /pinnedStepId\.value = viewable \? stepId : null;/.test(selectBody) &&
        /pinnedAtStepId\.value = viewable \? state\.currentStepId : null;/.test(selectBody) &&
        // 没钉住与"钉住时本来就没有当前步骤"分得开：界面拿到的是对象（`activePin`）而不是可空 id
        /export const activePin: ComputedRef<ViewPin \| null> = computed/.test(wizardSource) &&
        // 两个"离开门禁层"的动作都要把「用户要看的那一轮」清掉
        /reopened = false;/.test(blockOf(wizardSource, 'export function escapeGate(')) &&
        /reopened = false;/.test(blockOf(wizardSource, 'export function enterMainUi('))
      );
    })(),
    'R-31',
  );
  // ---------------------------------------------------------- 18b. 提权那一次（F-02 / F-03）
  //    都是**真调用**纯函数（不是源码正则）：四种结果分开判 + 三种失败各自的文案/出路 +
  //    "装完必须实测可用"的那把尺。行为覆盖的在真机之外能钉到这里为止（UAC 本身只有真机能验）。
  const elevationProbe = (
    over: Partial<nodeInstaller.ElevationProbe>,
  ): nodeInstaller.ElevationProbe => ({
    code: null,
    stdout: '',
    stderr: '',
    error: null,
    timedOut: false,
    ...over,
  });
  check(
    '安装引擎：提权的四种结果分开判（等太久最先判，不与"用户没允许"混）',
    nodeInstaller.classifyElevationOutcome(
      elevationProbe({ code: 0, stdout: '{"ExitCode":0}' }),
    ) === 'ok' &&
      nodeInstaller.classifyElevationOutcome(
        elevationProbe({
          code: 1,
          stderr: 'This operation was canceled by the user.',
        }),
      ) === 'declined' &&
      nodeInstaller.classifyElevationOutcome(elevationProbe({ timedOut: true })) === 'timeout' &&
      nodeInstaller.classifyElevationOutcome(elevationProbe({ code: 1, stdout: 'boom' })) ===
        'failed' &&
      // 超时**优先**于其它信号：先判 timedOut 才不会被"取消/失败"的文本抢走
      nodeInstaller.classifyElevationOutcome(
        elevationProbe({
          timedOut: true,
          code: 1,
          stderr: 'This operation was canceled by the user.',
        }),
      ) === 'timeout',
  );
  check(
    '安装引擎：三种没成功的提权结果各有自己的类别与出路，超时**不**复用"没权限"的文案',
    (() => {
      const timeout = nodeInstaller.elevationFailure('timeout');
      const declined = nodeInstaller.elevationFailure('declined');
      const failed = nodeInstaller.elevationFailure('failed');
      const kinds: string[] = [timeout.kind, declined.kind, failed.kind];
      return (
        timeout.kind === 'elevation-timeout' &&
        timeout.message.includes('权限询问等太久') &&
        timeout.message.includes('可能仍在系统里进行') &&
        Boolean(timeout.hint) &&
        declined.kind === 'elevation-declined' &&
        declined.message.includes('没有允许') &&
        failed.kind === 'elevation-failed' &&
        // 三条互不相同，而且超时那条不许是 symlink（"等太久"≠"没权限"：F-02 第 1 条）
        new Set(kinds).size === 3 &&
        !kinds.includes('symlink') &&
        timeout.message !== declined.message &&
        declined.message !== failed.message
      );
    })(),
  );
  check(
    '安装引擎：等太久之后先按"未确定"发布、再事实复检（复检用 node --version 那把尺）',
    (() => {
      // `blockOf` 取的是"锚点之后第一个 `{` 起的配对块"，而这两个方法的返回类型里也有 `{}`，
      // 所以这里按**下一个类成员**为界切整段（含签名）。
      const methodSlice = (source: string, anchor: string): string => {
        const start = source.indexOf(anchor);
        if (start < 0) return '';
        const rest = source.slice(start + anchor.length);
        const next = /\n {2}(?:private|public|async|readonly|[a-zA-Z]+\()/.exec(rest);
        return rest.slice(0, next ? next.index : rest.length);
      };
      const settleBody = methodSlice(installerCode, 'private async settleElevationTimeout(');
      const recheckBody = methodSlice(installerCode, 'private recheckActiveNodeLanded(): boolean');
      const waitBody = methodSlice(installerCode, 'private async runElevated(');
      return (
        settleBody.length > 200 &&
        // 先发"未确定"（waiting + detached），再复检
        /publish\('waiting'/.test(settleBody) &&
        settleBody.indexOf("publish('waiting'") < settleBody.indexOf('recheckActiveNodeLanded()') &&
        /detached: true/.test(settleBody) &&
        // 复检证明落地 → 改口（按"已经落地"继续）
        /recheckActiveNodeLanded\(\)[\s\S]{0,400}kind: 'ok'/.test(settleBody) &&
        // 进程还在跑 → 保持未确定；进程结束且没建起来 → 才报 timeout
        /this\.child !== null[\s\S]{0,200}kind: 'stopped'/.test(settleBody) &&
        /kind: 'timeout'/.test(settleBody) &&
        // 复检用的是"有没有版本号"这把统一的尺
        /hasNodeVersionOutput\(/.test(recheckBody) &&
        /refreshProcessPathFromSystem\(\)/.test(recheckBody) &&
        // 提权那一步是异步的、且状态先于起进程（F-03）
        waitBody.includes('waitForClose(child, ELEVATED_TIMEOUT_MS') &&
        waitBody.indexOf('publish(') < waitBody.indexOf('spawnSpec(') &&
        !/spawnSync|runProbe\(/.test(waitBody) &&
        /elevate/.test(installerCode)
      );
    })(),
  );
  check(
    '安装引擎："装完必须实测可用"用的是同一把尺（node / npm 的版本号输出）',
    nodeInstaller.hasNodeVersionOutput('v24.21.0\n') &&
      nodeInstaller.hasNodeVersionOutput('24.21.0') &&
      !nodeInstaller.hasNodeVersionOutput('') &&
      // VM 实测那句是在"没有 active version"时出现的 —— 所以**不许**被当成可用。
      !nodeInstaller.hasNodeVersionOutput(
        'No active Node.js version is configured. Run `nvm install <version>` then `nvm use <version>`.',
      ) &&
      // 同一条判据还要能认出来这句话的那一半（v2 的 shim 原文，VM-11 逐字）
      nodeInstaller.isInactiveNodeShimOutput(
        'No active Node.js version is configured. Run `nvm install <version>` then `nvm use <version>`.',
      ) &&
      !nodeInstaller.isInactiveNodeShimOutput('v24.21.0'),
  );
  // ---------------------------------------------------------- 18c. nvm v2 的真实模型（VM-11 / VM-12）
  //    夹具来自客机的**实测环境**（船长用 guestcontrol 取的原文/结构）：
  //    nvm v2.0.0 装在 `…\Local\Author Software\nvm`、shim 模式、`NVM_HOME`/`NVM_SYMLINK` **不存在**。
  //    用户 PATH 里有 `<root>` 和 `<root>\.nodejs`、`nvm list` 是 `No versions installed.`。
  //    那条"界面报的路径" `…\Local\Software\nvm\nodejs\node.exe` 实测不存在（exit 3）。
  //    `nvm env` 的整段是按官方文档的两种真实排版重建的（客机那份是分节版；我们没拿到逐字字节），
  //    所以这里标**重建**，而 npm 原文 / nvm list 原文 / 路径判定都是**逐字**的）。
  const guestRoot = 'C:\\Users\\tester\\AppData\\Local\\Author Software\\nvm';
  const guestPath = [
    'C:\\Users\\tester\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\',
    guestRoot,
    `${guestRoot}\\.nodejs`,
    'C:\\Windows\\system32',
  ].join(';');
  const guestRealFiles = new Set([
    `${guestRoot}\\nvm.exe`,
    `${guestRoot}\\.nodejs\\node.exe`,
    `${guestRoot}\\.nodejs\\npm.cmd`,
    `${guestRoot}\\.nodejs\\npx.cmd`,
  ]);
  const guestEnv = { Path: guestPath, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const guestNvmEnvText = [
    'NVM For Windows',
    'Computer',
    '  Windows            : 11',
    '  Administrator      : No',
    '  Developer Mode     : Disabled',
    'Installation',
    '  Version            : v2.0.0',
    `  Path               : ${guestRoot}`,
    'Version Management',
    '  Status             : on',
    '  Operating Mode     : shim',
    'Installed Versions',
    '  Total              : 0 (0 MB)',
    '  Default            : not set',
    `  Path               : ${guestRoot}\\installs`,
    'Download Sources',
    '  Node.js            : https://nodejs.org/dist',
    '  npm                : https://registry.npmjs.org (unreachable)',
  ].join('\n');
  check(
    '安装引擎：`nvm env` 的两种真实排版都认（分节的客机报告 + 官方样例），两个 Path 不混',
    (() => {
      const sectioned = nodeInstaller.parseNvmEnvOutput(guestNvmEnvText);
      const flat = nodeInstaller.parseNvmEnvOutput(
        [
          'NVM For Windows',
          '├─ Version            : v2.0.0-alpha.1',
          '├─ Status             : on',
          '├─ Operating Mode     : shim',
          '└─ Installed Versions : 4',
        ].join('\n'),
      );
      return (
        sectioned.version === 'v2.0.0' &&
        sectioned.status === 'on' &&
        sectioned.mode === 'shim' &&
        sectioned.versionsTotal === 0 &&
        sectioned.defaultVersion === null &&
        sectioned.installsDir === `${guestRoot}\\installs` &&
        sectioned.programRoot === guestRoot &&
        sectioned.nodeMirror === 'https://nodejs.org/dist' &&
        sectioned.npmMirror === 'https://registry.npmjs.org (unreachable)' &&
        flat.version === 'v2.0.0-alpha.1' &&
        flat.versionsTotal === 4 &&
        // 扁平样例里没有版本目录，不许把别的东西塞进去
        flat.installsDir === null
      );
    })(),
  );
  check(
    '安装引擎：`nvm list` 的 v2 单行形状也认（星号是 active + 空格分开的一串）',
    (() => {
      const v2 = nodeInstaller.parseNvmListOutput('* 24.1.0    (default)  22.14.0  20.19.1');
      const v1 = nodeInstaller.parseNvmListOutput(
        ['      24.21.0', '    * 22.12.0 (Currently using 64-bit executable)'].join('\n'),
      );
      const empty = nodeInstaller.parseNvmListOutput('No versions installed.');
      return (
        JSON.stringify(v2) ===
          JSON.stringify({ versions: ['24.1.0', '22.14.0', '20.19.1'], active: '24.1.0' }) &&
        JSON.stringify(v1) ===
          JSON.stringify({ versions: ['24.21.0', '22.12.0'], active: '22.12.0' }) &&
        JSON.stringify(empty) === JSON.stringify({ versions: [], active: null })
      );
    })(),
  );
  check(
    '安装引擎：v2 的模型从**真实证据**推（不依赖 NVM_HOME / NVM_SYMLINK）',
    (() => {
      const model = nodeInstaller.deriveNvmModel({
        exe: `${guestRoot}\\nvm.exe`,
        env: guestEnv,
        report: nodeInstaller.parseNvmEnvOutput(guestNvmEnvText),
        pathDirs: guestPath.split(';'),
        exists: (file: string) => guestRealFiles.has(file),
      });
      // v1 风格机器：真有 NVM_HOME / NVM_SYMLINK 时按真的那套来（不写死排斥）
      const v1Root = 'D:\\Nvm\\nvm';
      const v1 = nodeInstaller.deriveNvmModel({
        exe: null,
        env: {
          NVM_HOME: v1Root,
          NVM_SYMLINK: 'D:\\Node\\nodejs',
          Path: `${v1Root};D:\\Node\\nodejs`,
        },
        report: null,
        pathDirs: [v1Root, 'D:\\Node\\nodejs'],
        exists: (file: string) =>
          file === `${v1Root}\\nvm.exe` || file === 'D:\\Node\\nodejs\\node.exe',
      });
      const none = nodeInstaller.deriveNvmModel({
        exe: null,
        env: {},
        report: null,
        pathDirs: [],
        exists: () => false,
      });
      return (
        model !== null &&
        model.root === guestRoot &&
        model.mode === 'shim' &&
        model.installsDir === `${guestRoot}\\installs` &&
        model.activeDir === `${guestRoot}\\.nodejs` &&
        // 证据链要留得下来（日志里就是它）
        model.evidence.length >= 3 &&
        v1 !== null &&
        v1.root === v1Root &&
        v1.activeDir === 'D:\\Node\\nodejs' &&
        (v1.mode === 'shim') === false &&
        none === null
      );
    })(),
  );
  check(
    '安装引擎：v2 的注册表偏好（`HKCU\\Software\\<发布商>\\Preferences\\nvm`）按真根目录推键名并解析',
    (() => {
      const key = nodeInstaller.nvmPreferenceKey(guestRoot);
      const parsed = nodeInstaller.parseNvmRegistryPreferences(
        [
          'HKEY_CURRENT_USER\\Software\\Author Software\\Preferences\\nvm',
          '    Enabled              REG_DWORD    0x1',
          '    InstallRoot          REG_SZ       ' + guestRoot + '\\installs',
          '    ActiveVersion        REG_SZ       not set',
          '    OperatingMode        REG_SZ       shim',
        ].join('\r\n'),
      );
      return (
        key === 'HKCU\\Software\\Author Software\\Preferences\\nvm' &&
        parsed.installsDir === `${guestRoot}\\installs` &&
        parsed.mode === 'shim' &&
        parsed.status === 'on' &&
        parsed.defaultVersion === null
      );
    })(),
  );
  check(
    '安装引擎：nvm 的每一步都留证据（命令 / 退出码 / stdout / stderr，空的那路写「（空）」）',
    (() => {
      const installSlice = methodSliceOf(installerCode, 'private async installNodeWithNvm(');
      const runSlice = methodSliceOf(installerCode, 'private async runNvmCommand(');
      return (
        /parseNvmInstallOutput\(installed\.tail\)/.test(installSlice) &&
        // 装完还要回清单核对（"命令跑过了"不算数）
        /readNvmList\(model\.exe, extra\)/.test(installSlice) &&
        /正在进行|正在让它下载并安装 Node\.js/.test(installSlice) &&
        // 每条命令都走 logNvmStep（含 stdout/stderr 分开收）
        /private logNvmStep\(/.test(installerCode) &&
        /stdout：\$\{show\(stdout\)\}；stderr：\$\{show\(stderr\)\}/.test(installerCode) &&
        /outRef\.text = \(outRef\.text \+ text\)/.test(runSlice) &&
        /errRef\.text = \(errRef\.text \+ text\)/.test(runSlice) &&
        /logNvmStep\(name, args, outcome\.code, outRef\.text, errRef\.text\)/.test(runSlice)
      );
    })(),
  );
  check(
    '安装引擎：应用**自己装版本**（选版本 → nvm install → nvm use → 实测），不把用户打发去终端',
    (() => {
      const installSlice = methodSliceOf(installerCode, 'private async installNodeWithNvm(');
      return (
        /if \(!alreadyInstalled\)/.test(installSlice) &&
        /\['install', versionArg\]/.test(installSlice) &&
        /useNvmVersion\(model, versionArg/.test(installSlice) &&
        /verifyActiveNode\(plan, model\)/.test(installSlice) &&
        // 没有"让用户自己去终端"这条路：提示语里不许出现"自己打开终端"
        !/自己打开终端|到终端里去/.test(installerCode)
      );
    })(),
  );
  check(
    '安装引擎：shim 模式（v2）不请求提权（官方说明：shim 无符号链接、不需要管理员）',
    (() => {
      const useSlice = methodSliceOf(installerCode, 'private async useNvmVersion(');
      return (
        /model\.mode === 'shim'/.test(useSlice) &&
        // shim 那条分支必须在 runElevated 之前（先看模式，再决定要不要弹 UAC）
        useSlice.indexOf("model.mode === 'shim'") < useSlice.indexOf('await this.runElevated(') &&
        /不请求提权/.test(useSlice)
      );
    })(),
  );
  // 客机那条"界面报的路径"不在磁盘上 —— 绝不能被返回
  const vmGuessed = 'C:\\Users\\tester\\AppData\\Local\\Software\\nvm\\nodejs\\node.exe';
  const vmFound = envDoctor.findNodePathWindows(guestEnv, 'C:\\Users\\tester', (file) =>
    guestRealFiles.has(file),
  );
  const vmNothing = envDoctor.findNodePathWindows(
    { Path: `C:\\Users\\tester\\AppData\\Local\\Software\\nvm\\nodejs`, PATHEXT: '.EXE' },
    'C:\\Users\\tester',
    (file) => guestRealFiles.has(file),
  );
  // 候选目录里必须包含 v2 的 `.nodejs`（从 PATH 里那个 `…\nvm` 推出来）
  const vmCandidates = processUtils.windowsBinCandidates(guestEnv, 'C:\\Users\\tester');
  const vmFoundText: string = vmFound ?? '';
  check(
    '首启门禁：界面上报的 node 路径一定是探测到的真路径（VM-12）',
    vmFound === `${guestRoot}\\.nodejs\\node.exe` &&
      // 客机那条"界面报的路径"（不存在的推测路径）绝不能被返回
      vmFoundText !== vmGuessed &&
      // 只有一条不存在的 PATH 目录时：返回 null（不是那条路径）
      vmNothing === null &&
      vmCandidates.includes(`${guestRoot}\\.nodejs`) &&
      !vmCandidates.includes(vmGuessed),
    `found=${vmFound} nothing=${vmNothing} candidates=${vmCandidates.join(' | ')}`,
  );
  check(
    '首启门禁：界面词表里不出现内部术语（模板与文案，注释不算）',
    (() => {
      const templateOf = (source: string): string =>
        (/<template>([\s\S]*)<\/template>\s*(?:<script|$)/.exec(source)?.[1] ?? '').replace(
          /<!--[\s\S]*?-->/g,
          '',
        );
      const copy =
        [
          gateRaw,
          fs.readFileSync(path.join(rendererDir, 'shell', 'GateBanner.vue'), 'utf8'),
          fs.readFileSync(path.join(rendererDir, 'shell', 'TopBar.vue'), 'utf8'),
        ]
          .map(templateOf)
          .join('\n') +
        templateOf(fs.readFileSync(path.join(rendererDir, 'panes', 'EnvPane.vue'), 'utf8')) +
        html.replace(/<!--[\s\S]*?-->/g, '');
      const forbidden = [
        'EnvCheckId',
        'EnvFixPlan',
        'judgeEnvironment',
        'probe',
        'verbatim',
        'COMSPEC',
        'NVM_SYMLINK',
        'SHASUMS256',
        'sha256:',
        'PATH',
      ];
      return copy.length > 5000 && forbidden.every((word) => !copy.includes(word));
    })(),
  );
  check(
    '首启门禁：新增 5 个变量全是主题无关的尺度值，门禁样式没有字面色值，浅色四色 == R-04 冻结值',
    (() => {
      const wizardVars: [string, string][] = [
        ['--z-gate', '58'],
        ['--wizard-read', '620px'],
        ['--wizard-card', '760px'],
        ['--wizard-rail-dot', '14px'],
        ['--dur-screen', '220ms'],
      ];
      const rootBody = cssBlock(':root');
      const lightBody = cssBlock(":root[data-theme='light']");
      const gateRules = cssText.match(/\.gate-[\w-]*[^{]*\{[^}]*\}/g) ?? [];
      const gateZ = Number(/--z-gate:\s*(\d+)/.exec(rootBody)?.[1] || 0);
      const bootLockZ = Number(/z-index:\s*(\d+)/.exec(cssBlock('.boot-lock'))?.[1] || 0);
      return (
        wizardVars.every(
          ([name, value]) => rootBody.includes(`${name}: ${value};`) && !lightBody.includes(name),
        ) &&
        ['#047857', '#0369a1', '#be123c', '#92400e'].every((color) => lightBody.includes(color)) &&
        gateRules.length > 20 &&
        gateRules.every((rule) => !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(rule)) &&
        // 门禁层压在启动锁下面（R-08：万一交接的那一帧，也是锁盖住门禁）
        gateZ > 0 &&
        gateZ < bootLockZ
      );
    })(),
  );

  // ---------------------------------------------------------- 18d. t29：归属 → 方法、档位跟随、换档显式（VM-14 / VM-15）
  //    需求 §7.7 / §7.8 / §8.5 的判据全部落在安装引擎的两个**纯函数**上：
  //    `detectNodeOwner`（这份 Node 归谁管）与 `decideNodePlan`（目标方法 + 目标档位 + 是不是换档）。
  //    所以这一节是离线夹具：不装 Node、不起进程、不碰网络（VM-14 与 VM-15 的现场都是真机，
  //    但判据必须能在任何平台上被反例钉住 —— 这正是把它们做成纯函数的理由）。
  const nodeReleaseEntry = (
    version: string,
    lts: string | false,
  ): nodeInstaller.NodeReleaseEntry => ({ version, lts, files: [] });
  /** 一份像真的官方清单（新版本在前）：v26.9.0 与 v25.8.0 是当前版，v24.21.0 是稳定版 */
  const nodeReleaseList = [
    nodeReleaseEntry('v26.9.0', false),
    nodeReleaseEntry('v25.8.0', false),
    nodeReleaseEntry('v24.21.0', 'krypton'),
  ];
  const GUEST_NVM_ROOT = 'C:\\Users\\tester\\AppData\\Local\\Author Software\\nvm';
  const guestNvmModel: nodeInstaller.NvmModel = {
    exe: `${GUEST_NVM_ROOT}\\nvm.exe`,
    root: GUEST_NVM_ROOT,
    mode: 'shim',
    installsDir: `${GUEST_NVM_ROOT}\\installs`,
    activeDir: `${GUEST_NVM_ROOT}\\.nodejs`,
    evidence: [`夹具：模型根目录 ${GUEST_NVM_ROOT}`],
  };
  const nodeOwnerOf = (input: {
    nodePath: string | null;
    env: NodeJS.ProcessEnv;
    model: nodeInstaller.NvmModel | null;
    msiInstallPath: string | null;
  }): { owner: EnvNodeOwner; evidence: string[] } => nodeInstaller.detectNodeOwner(input);
  /** 归属判定的四类输入（§7.7 的判据表）：每一类都必须有确定结论 */
  const ownerNvmShim = nodeOwnerOf({
    nodePath: `${GUEST_NVM_ROOT}\\installs\\v26.9.0\\node.exe`,
    env: {},
    model: guestNvmModel,
    msiInstallPath: null,
  });
  const ownerNvmShimDir = nodeOwnerOf({
    nodePath: `${GUEST_NVM_ROOT}\\.nodejs\\node.exe`,
    env: {},
    model: guestNvmModel,
    msiInstallPath: null,
  });
  const ownerNvmLinkV1 = nodeOwnerOf({
    nodePath: 'D:\\tools\\node-v20\\node.exe',
    env: { NVM_SYMLINK: 'D:\\tools\\node-v20' },
    model: null,
    msiInstallPath: null,
  });
  const ownerNvmFromPathVariable = nodeOwnerOf({
    nodePath: 'C:\\Tools\\Nvm\\v20.11.0\\node.exe',
    env: {},
    model: null,
    msiInstallPath: null,
  });
  const ownerSystemDefaultPlace = nodeOwnerOf({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    env: { ProgramFiles: 'C:\\Program Files' },
    model: null,
    msiInstallPath: null,
  });
  const ownerSystemFromMsiInstallPath = nodeOwnerOf({
    nodePath: 'E:\\custom-nodejs\\node.exe',
    env: { ProgramFiles: 'C:\\Program Files' },
    model: null,
    msiInstallPath: 'E:\\custom-nodejs',
  });
  const ownerUnknownVolta = nodeOwnerOf({
    nodePath: 'C:\\Users\\tester\\.volta\\bin\\node.exe',
    env: {},
    model: null,
    msiInstallPath: null,
  });
  const ownerUnknownNvmTools = nodeOwnerOf({
    // N4c 那条判据继续成立：`nvm-tools` 不是"独立的 nvm 目录名"（VM-14 的机器上就有这个名字）
    nodePath: 'D:\\nvm-tools\\node.exe',
    env: {},
    model: null,
    msiInstallPath: null,
  });
  const ownerUnknownNoNode = nodeOwnerOf({
    nodePath: null,
    env: {},
    model: null,
    msiInstallPath: null,
  });
  check(
    '安装引擎（VM-14）：归属判定四类输入各有一个确定结论（v2 shim / v1 link / 系统直装 / 未知）',
    ownerNvmShim.owner === 'nvm' &&
      ownerNvmShim.evidence.length > 0 &&
      ownerNvmShimDir.owner === 'nvm' &&
      ownerNvmLinkV1.owner === 'nvm' &&
      ownerNvmFromPathVariable.owner === 'nvm' &&
      ownerSystemDefaultPlace.owner === 'system' &&
      ownerSystemFromMsiInstallPath.owner === 'system' &&
      ownerUnknownVolta.owner === 'unknown' &&
      ownerUnknownNvmTools.owner === 'unknown' &&
      ownerUnknownNoNode.owner === 'unknown' &&
      // 证据要能对账（评审看的就是这几行）
      ownerUnknownNvmTools.evidence.length > 0,
  );

  const decide = (
    over: Partial<Parameters<typeof nodeInstaller.decideNodePlan>[0]>,
  ): nodeInstaller.NodePlanDecision =>
    nodeInstaller.decideNodePlan({
      mode: 'install',
      owner: 'unknown',
      nvmPresent: false,
      nodeFound: false,
      currentVersion: null,
      releases: nodeReleaseList,
      elevated: false,
      ...over,
    });
  const decideNvmUpdate = decide({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
  });
  const decideSystemUpdate = decide({
    mode: 'update',
    owner: 'system',
    nvmPresent: false,
    nodeFound: true,
    currentVersion: 'v24.21.0',
  });
  const decideUnknownFound = decide({ mode: 'install', owner: 'unknown', nodeFound: true });
  const decideUnknownNothingWithNvm = decide({
    mode: 'install',
    owner: 'unknown',
    nvmPresent: true,
    nodeFound: false,
  });
  const decideUnknownNothingBare = decide({
    mode: 'install',
    owner: 'unknown',
    nvmPresent: false,
    nodeFound: false,
  });
  check(
    '安装引擎（VM-14）：方法跟随归属（nvm → nvm 且不重装管理器 / system → 官方直装 / 未知不默默直装）',
    decideNvmUpdate.method === 'nvm' &&
      // 「机器上已经有可辨认的版本管理器时不再装它一遍」（冻结 §3.2.1 的 installsManager）
      decideNvmUpdate.installsManager === false &&
      decideSystemUpdate.method === 'direct' &&
      decideSystemUpdate.installsManager === true &&
      // 归属未知 + 找到了一份 Node：**不预选**（界面两条路都列、一条都不选），计划不给「开始」
      decideUnknownFound.needChoice === 'choose-method' &&
      decideUnknownFound.refuse !== null &&
      // 一份都没找到：有事实支撑的默认（有管理器就用它，否则官方直装）—— 但仍要写出方法
      decideUnknownNothingWithNvm.method === 'nvm' &&
      decideUnknownNothingWithNvm.installsManager === false &&
      decideUnknownNothingBare.method === 'direct' &&
      decideUnknownNothingBare.refuse === null,
  );
  const decideCurrentFollow = decide({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
  });
  const decideLtsFollow = decide({
    mode: 'update',
    owner: 'system',
    nvmPresent: false,
    nodeFound: true,
    currentVersion: 'v24.21.0',
  });
  const decideExplicitSwitchToLts = decide({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
    requestChannel: 'lts',
  });
  const decideInstallDefault = decide({
    mode: 'install',
    owner: 'system',
    nvmPresent: false,
    nodeFound: true,
    currentVersion: 'v26.9.0',
  });
  check(
    '安装引擎（VM-15）：更新的目标档位跟随当前档位（current→current、lts→lts），install 才用设计默认',
    // 当前 v26.9.0（清单里 lts: false）→ 当前档 = current，目标也落在 current 那条，且不是降级
    decideCurrentFollow.currentChannel === 'current' &&
      decideCurrentFollow.channel === 'current' &&
      decideCurrentFollow.release?.version === 'v26.9.0' &&
      decideCurrentFollow.switchesChannel === false &&
      decideCurrentFollow.direction !== 'older' &&
      // 当前 v24.21.0（清单里 lts 非 false）→ 稳定档
      decideLtsFollow.currentChannel === 'lts' &&
      decideLtsFollow.channel === 'lts' &&
      decideLtsFollow.release?.version === 'v24.21.0' &&
      decideLtsFollow.switchesChannel === false &&
      // 「换档」只可能由**显式**给的档位产生：current → lts 就是一次降档，必须说得出"这是换档"
      decideExplicitSwitchToLts.channel === 'lts' &&
      decideExplicitSwitchToLts.switchesChannel === true &&
      decideExplicitSwitchToLts.direction === 'older' &&
      // install 的设计默认仍然是「最新稳定版」
      decideInstallDefault.channel === 'lts',
  );
  const decideChannelUnknown = decide({
    mode: 'update',
    owner: 'system',
    nvmPresent: false,
    nodeFound: true,
    // 装了清单里没有的版本 → 档位**判不出来**（不许按版本号大小猜）
    currentVersion: 'v21.0.0',
  });
  const decideOlderFromSwitch = decideExplicitSwitchToLts;
  const decideSameChannel = decideCurrentFollow;
  check(
    '安装引擎（VM-15）：档位判不出来时让用户显式选档；direction=older ⟹ 这是换档（四条约定②）',
    decideChannelUnknown.currentChannel === null &&
      decideChannelUnknown.needChoice === 'choose-channel' &&
      decideChannelUnknown.refuse !== null &&
      // 判不出来时不挑目标版本（没有可以显示成"目标"的东西）
      decideChannelUnknown.release === null &&
      decideChannelUnknown.direction === null &&
      // 约定①：needChoice ⟹ 不给「开始」（计划层的 usable === false）
      [decideUnknownFound, decideChannelUnknown].every(
        (item) => item.needChoice !== null && item.refuse !== null,
      ) &&
      // 约定②：direction === 'older' ⟹ switchesChannel（"更新"永不降级）
      [decideUnknownFound, decideChannelUnknown, decideOlderFromSwitch, decideSameChannel].every(
        (item) => item.direction !== 'older' || item.switchesChannel,
      ),
  );
  /**
   * r2（t9）：`switchesChannel` 现在在**所有**分支上算，并按构造保证
   * `direction === 'older' ⟹ switchesChannel === true`。
   *
   * 为什么必须包含 `install` 的设计默认：装了**当前版**的机器上点「安装 / 换一个 Node」
   * （`mode: 'install'`，设计默认 lts）就是一次跨档 —— 目标是**更低**的稳定版，
   * 界面必须说得出「换成稳定版 / 版本从 vX 降到 vY」。旧实现只在"显式给了 channel"
   * 那条分支上算，于是这条可达路径上 `direction === 'older'` 而 `switchesChannel === false`：
   * 两个界面都拿不到"这是换档"的事实，用户看到的就是一次没有解释的降级（VM-15 的另一半）。
   */
  check(
    '安装引擎（VM-15，r2）：install + 已装 current → switchesChannel=true 且 direction=older（界面据此说得出「降到」）',
    decideInstallDefault.switchesChannel === true &&
      decideInstallDefault.direction === 'older' &&
      decideInstallDefault.currentChannel === 'current' &&
      decideInstallDefault.channel === 'lts' &&
      decideInstallDefault.release?.version === 'v24.21.0' &&
      // 反向：同档跟随与判不出档位都不许被误报成"换档"
      decideCurrentFollow.switchesChannel === false &&
      decideLtsFollow.switchesChannel === false &&
      decideChannelUnknown.switchesChannel === false &&
      // 约定②的无条件形式：枚举一批组合，`older` 必须**总是**伴随"这是换档"
      [
        decideInstallDefault,
        decideExplicitSwitchToLts,
        decideCurrentFollow,
        decideLtsFollow,
        decideChannelUnknown,
        decideUnknownFound,
      ].every((item) => item.direction !== 'older' || item.switchesChannel),
  );
  const decideNvmExplicitDirectNotElevated = decide({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
    requestMethod: 'direct',
  });
  const decideNvmExplicitDirectElevated = decide({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
    requestMethod: 'direct',
    elevated: true,
  });
  const decideSystemExplicitNvm = decide({
    mode: 'update',
    owner: 'system',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v24.21.0',
    requestMethod: 'nvm',
  });
  const decideUnknownExplicitDirect = decide({
    mode: 'install',
    owner: 'unknown',
    nodeFound: true,
    requestMethod: 'direct',
  });
  check(
    '安装引擎（VM-14）：归属已知时另一条路只有 §7.8 的两个例外（显式点名 + 并存风险那句话）',
    // 归属 = nvm 且不是提权态：不许用官方安装包再装一份（那正是 VM-14 的现场）
    decideNvmExplicitDirectNotElevated.refuse !== null &&
      // 一次只问一件事：这次挡住它的是"方法不对"，不该同时再叠一个"去选档位"
      decideNvmExplicitDirectNotElevated.needChoice === null &&
      // 例外③：提权态下 nvm 那条路走不了（R-23）→ 用户显式点名才放行，并带上并存风险
      decideNvmExplicitDirectElevated.refuse === null &&
      decideNvmExplicitDirectElevated.coexistWarning === nodeInstaller.NODE_COEXIST_WARNING &&
      // 例外②：归属 = system 时用户显式改走版本管理器 → 同样带并存风险
      decideSystemExplicitNvm.refuse === null &&
      decideSystemExplicitNvm.coexistWarning === nodeInstaller.NODE_COEXIST_WARNING &&
      // 例外①：归属未知时由用户显式点名 → 带并存风险
      decideUnknownExplicitDirect.coexistWarning === nodeInstaller.NODE_COEXIST_WARNING &&
      // 跟随归属那一路**不带**这句话（只有例外才说两份并存）
      decideNvmUpdate.coexistWarning === null &&
      decideSystemUpdate.coexistWarning === null,
  );

  /**
   * `decideNodePlan` 的函数体：它的参数表里就有一个 `{`（`input: { … }`），
   * 所以不能用 `blockOf`（它取锚点之后第一个 `{`，那会切到**类型**里去）。
   * 从返回类型那一行之后切到下一个顶层 `export`。
   */
  const decidePureCode = (() => {
    const start = installerCode.indexOf('export function decideNodePlan(');
    if (start < 0) return '';
    const rest = installerCode.slice(start);
    const bodyStart = rest.indexOf('): NodePlanDecision {');
    if (bodyStart < 0) return '';
    const end = rest.indexOf('\nexport ', bodyStart);
    return stripStrings(rest.slice(bodyStart, end < 0 ? rest.length : end));
  })();
  check(
    '安装引擎：归属与档位的判定只在两个纯函数里（decideNodePlan 没有 fs / 子进程 / process.* / 时钟）',
    decidePureCode.length > 500 &&
      !/\bfs\./.test(decidePureCode) &&
      !/\bspawn|\bexecFile|\bexecSync|\bspawnSync/.test(decidePureCode) &&
      !/process\.env|process\.platform/.test(decidePureCode) &&
      !/Date\.now|\bnew Date\b/.test(decidePureCode),
    `${decidePureCode.length} 字符`,
  );
  check(
    '安装引擎（VM-14）：归属判据只有一份（采集侧与安装计划调同一个导出，渲染层不自己猜）',
    /export function detectNodeOwner\(/.test(installerCode) &&
      /detectNodeOwner\(/.test(envCode) &&
      /deriveNvmModelFromEnvironment\(/.test(envCode) &&
      !/detectNodeOwner/.test(rendererCode) &&
      // 主进程里没有第二处"路径像不像 nvm"的判断（那会与判据漂移）
      (installerCode.match(/export function detectNodeOwner\(/g) ?? []).length === 1,
  );
  check(
    '安装引擎（VM-15）：主进程不再把 lts 当默认档位（省略档位 = 跟随当前档，只有跨档才算换档）',
    // 旧实现那一行（`request.channel === 'current' ? 'current' : 'lts'`）必须已经消失
    !/request\.channel === 'current' \? 'current' : 'lts'/.test(installerCode) &&
      /decideNodePlan\(\{/.test(installerCode) &&
      /else if \(input\.mode === 'update'\)/.test(installerCode) &&
      /channel = currentChannel;/.test(installerCode) &&
      // r2（t9）：换档在**所有**分支上算，且 `older` 本身就是一次换档（按构造保证约定②）
      /const switchesChannel =\s*\n?\s*direction === 'older' \|\| \(currentChannel !== null && channel !== currentChannel\);/.test(
        installerCode,
      ),
  );
  /**
   * r2（t9）：`stopDshForUpdate()` **全仓库恰好一处**，而且在 `execute()` 里、`mode === 'update'`
   * 时**无条件**执行 —— 「更新会先停掉正在运行的 dsh」是确认区上写着的承诺（§8.3 / 交互 §10.5 第 7 条）。
   *
   * 旧实现把它放在 `installPhase()` 的开头，而"机器上已经有可辨认的版本管理器"
   * （`installsManager === false`）那条路**整个跳过**安装阶段 → 用户点"更新"时那句承诺 quietly 落空。
   * 现在两条路（官方直装 / nvm，含不下载管理器的那条）都在同一个地方停**一次**；
   * 调用点只有这一处，所以"停两次"在结构上不可能。
   *
   * 为什么这条是静态的：真跑一次 `run()` 需要有真 nvm / 真 dsh 在跑（沙箱里没有），
   * 而"恰好一次"在这里正好等价于"只有一个调用点、且两条路都经过它"。
   */
  const executeSlice = methodSliceOf(installerCode, 'private async execute(');
  const installPhaseSlice = methodSliceOf(installerCode, 'private async installPhase(');
  check(
    '安装引擎（r2）：更新前停 dsh 恰好一次（两条路都在 execute 里停，installPhase 不再停）',
    (installerCode.match(/this\.stopDshForUpdate\(\)/g) ?? []).length === 1 &&
      /if \(plan\.mode === 'update'\) await this\.stopDshForUpdate\(\);/.test(executeSlice) &&
      !/stopDshForUpdate/.test(installPhaseSlice) &&
      // 必须在任何系统改动之前：下载 / 校验 / 装管理器 / nvm install 都在它后面
      executeSlice.indexOf('await this.stopDshForUpdate()') <
        executeSlice.indexOf('await this.transferPhase(plan)') &&
      executeSlice.indexOf('await this.stopDshForUpdate()') <
        executeSlice.indexOf('await this.installNodeWithNvm(plan)'),
  );
  check(
    't29 契约增量：EnvNodeOwner 三成员 / 报告与计划与状态的新字段 / 请求 method 可选（ipc.ts 仍然零 import）',
    (() => {
      const ownerUnion = /export type EnvNodeOwner =([\s\S]*?);/.exec(flatIpc)?.[1] ?? '';
      const members = [...ownerUnion.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      return (
        members.length === 3 &&
        ['nvm', 'system', 'unknown'].every((name) => members.includes(name)) &&
        !/^\s*import\s/m.test(ipcSource) &&
        /nodeOwner: EnvNodeOwner;/.test(ipcSource) &&
        /nodeOwnerEvidence: string\[\];/.test(ipcSource) &&
        /export interface EnvNodePlan \{/.test(ipcSource) &&
        [
          /owner: EnvNodeOwner;/,
          /nvmPresent: boolean;/,
          /currentVersion: string \| null;/,
          /currentChannel: EnvNodeChannel \| null;/,
          /switchesChannel: boolean;/,
          /direction: 'newer' \| 'same' \| 'older' \| null;/,
          /needChoice: 'choose-method' \| 'choose-channel' \| null;/,
          /installsManager: boolean;/,
        ].every((pattern) => pattern.test(ipcSource)) &&
        /plan: EnvNodePlan \| null;/.test(ipcSource) &&
        /observedVersion: string \| null;/.test(ipcSource) &&
        // 请求形状：method 变成可选（两处 API 各一次）—— 省略 = 跟随归属
        (ipcSource.match(/method\?: EnvNodeMethod;/g) ?? []).length >= 2 &&
        /export interface EnvNodeRequest \{/.test(ipcSource)
      );
    })(),
  );
  check(
    '环境自检页（VM-14 / VM-15）：更新入口不写死方法，档位不写死字面量（默认跟随、显式才换档）',
    // 船长裁定（t29）：冻结 §3.2.1④ 那句「EnvPane 不许出现 channel:」与
    // 需求 §8.5 第 3 条「当前档位判不出来时要让用户显式选一档」互相矛盾 ——
    // 后者为准：**默认不传档位**（跟随当前档），**只有用户显式选档才传**（那才是换档）。
    // 所以这条断言盯的是"不许写死默认"，不是"不许出现 channel"。
    envPaneCode.length > 1000 &&
      // VM-14 的直接成因：写死 `method: 'direct'`
      !/method:\s*'direct'/.test(envPaneCode) &&
      // 档位不许写死成字面量（跟随当前档 = 参数里根本没有 channel）
      !/channel:\s*'(lts|current)'/.test(envPaneCode) &&
      // 入口还在（别把断言写成"这个文件里什么都搜不到"）
      /loadNodePlan\(/.test(envPaneCode) &&
      /runNodeInstall\(/.test(envPaneCode),
  );
  check(
    '安装引擎（VM-14）：nvm 那条路的机器上不再装管理器（installsManager=false 时跳过下载与校验两段）',
    /if \(!plan\.installsManager\)/.test(installerCode) &&
      // 跳过时连下载与校验两段都不进（"没有任何东西要下载"）
      /这台电脑上已经有可辨认的版本管理器：这次不下载、不校验/.test(installerCode) &&
      // 那条路仍然要做完四步：nvm install → nvm list 核对 → nvm use → 实测（判据复用 verifyActiveNode）
      /if \(plan\.method === 'nvm'\) \{/.test(installerCode) &&
      /verifyActiveNode\(plan, model\)/.test(installerCode) &&
      // 管理器已经在时 `url` 指向发布页（不是我们会去下载的地址），sha256 为 null 是正常的
      /display: `nvm install \$\{versionArg\}`/.test(installerCode),
  );

  // ---------------------------------------------------------- 汇总
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) {
    console.log('失败：' + failed.map((item) => item.name).join('、'));
    // 在 GitHub Actions 里把每条失败**连它打印的实际值**标成注解：PR 页面上直接看得到是哪一条、
    // 值是什么（原来只能翻日志），别的环境保持安静（本地 stdout 已经打得够全了）。
    if (process.env.GITHUB_ACTIONS === 'true') {
      for (const item of failed) {
        const extra = item.extra === undefined ? '' : `  —  ${String(item.extra)}`;
        console.log(`::error::${item.name.replace(/\r?\n/g, ' ')}${extra.replace(/\r?\n/g, ' ')}`);
      }
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('自检异常：', error);
  process.exitCode = 1;
});
