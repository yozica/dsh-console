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
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

import * as processUtils from '../src/main/process-utils';
import { Settings, DEFAULTS } from '../src/main/settings';
import { PtySessions } from '../src/main/pty-sessions';
import { DshManager } from '../src/main/dsh-manager';

const IS_WINDOWS = process.platform === 'win32';

/** package.json 里本文件真正读到的字段（用最小 interface 兜住 JSON.parse 的 any） */
interface PackageJson {
  version: string;
  build?: { mac?: { identity?: string } };
}

interface CheckResult {
  name: string;
  ok: boolean;
}

const results: CheckResult[] = [];
function check(name: string, ok: boolean, extra?: unknown) {
  results.push({ name, ok });
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

  // ---------------------------------------------------------- 6. 渲染层静态检查
  //    渲染层没有类型检查，这里挡掉最容易犯的错：元素 id / class / API 名拼错。
  //    界面正在逐页迁到 Vue 单文件组件，所以**标记与脚本都要把 .vue 一起算进来**
  //    （panes/ 是页面，shell/ 是外壳），否则迁走的部分会悄悄脱离这些检查的覆盖。
  const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
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

  // 每个组件都必须在 mount.ts 的挂载清单里，否则界面上那块永远是空的
  const mountJs = fs.readFileSync(path.join(rendererDir, 'mount.ts'), 'utf8');
  const unmounted = vueFiles
    .filter(({ dir, name }) => {
      const stem = name.replace(/\.vue$/, '');
      const spec = dir === 'panes' ? `./panes/${stem}.vue` : `./shell/${stem}.vue`;
      return !mountJs.includes(`from '${spec}'`);
    })
    .map(({ name }) => name);
  check(
    '渲染层：每个 .vue 组件都在挂载清单里',
    vueFiles.length > 0 && unmounted.length === 0,
    unmounted.length ? `未挂载 ${unmounted.join(', ')}` : `${vueFiles.length} 个组件`,
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
      /api\.onFullscreen\(/.test(rendererCode) &&
      /onFullscreen:/.test(preloadJs) &&
      /documentElement\.dataset\.platform\s*=/.test(platformJs) &&
      /setPlatform\(snapshot\.value\?\.env\?\.platform\)/.test(rendererCode),
    '左栏让位 + 应用内全屏顶栏让位 + 系统全屏撤回 + 非全屏不缩进 + platform/全屏状态都有来源',
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
  check('主题：CSS 定义了亮色变量块', /:root\[data-theme='light'\]\s*\{/.test(css));

  // 深色基础块 + 亮色覆盖块之外不应再出现硬编码颜色，否则亮色下会漏改。
  // 先剥注释：解释性注释里常引用颜色字面量（例如说明"xterm 自带样式写死了 #000"），
  // 那不是样式声明，不该报（这类误报已经出现三次）。
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
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
  const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]));
  const unstyled = [...htmlClasses].filter((name) => !cssClasses.has(name));
  check(
    '样式：标记用到的 class 都有对应样式（HTML + .vue）',
    unstyled.length === 0,
    unstyled.length ? `未定义样式 ${unstyled.join(', ')}` : `${htmlClasses.size} 个 class`,
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

  // ---------------------------------------------------------- 汇总
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) {
    console.log('失败：' + failed.map((item) => item.name).join('、'));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('自检异常：', error);
  process.exitCode = 1;
});
