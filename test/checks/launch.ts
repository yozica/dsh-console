'use strict';

/**
 * 自检第 1~5 组：启动命令解析、ANSI 与横幅、健康探测判据、端口占用解析、DshManager 状态机。
 *
 * 整段从 `test/selftest.ts` 的 `main()` 里搬出来（那里的先后顺序就是执行顺序），
 * 行为一字未改 —— 搬完的证据是自检输出逐行一致（314 条同名、同值、同顺序）。
 */

import fs from 'node:fs';

import { DshManager } from '../../src/main/dsh-manager';
import * as processUtils from '../../src/main/process-utils';
import { PtySessions } from '../../src/main/pty-sessions';

import { canQueryProcessName, canSpawnBinaries, check, skip, IS_WINDOWS } from '../harness';
import type { Repo } from '../repo';

export async function runLaunch(repo: Repo): Promise<void> {
  const settings = repo.settings;

  // ---------------------------------------------------------- 1. 命令解析
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
}
