/**
 * 启动 spec 的公共件：LaunchSpec / launchSpec / dshLaunchSpec / resolveDshInvocation / resolveShell
 *
 * 把"要跑什么"翻译成 spawn 的形状（从 `process-utils.ts` 拆出来的；那个文件现在只做 barrel 再导出，
 * 6 个消费者与两个反例脚本的 import 路径不用改）。
 */
import { dshArgsFor, quoteForCmd, resolveDshLauncher, splitArgs } from './process-dsh';
import { whichSync } from './process-shell';
import type { DshLauncher, InvocationSpec, ShellSpec } from './process-types';
import type { SettingsValues } from './settings';

import { COMSPEC, isWindows } from './process-types';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Windows 上「这个文件真的起得来」的扩展名：`.exe` / `.com` 是 PE，`.cmd` / `.bat` 交给 cmd.exe。
 * 无扩展名的同名文件（Node 安装目录里的 `npm` 是 `#!/usr/bin/env bash`）不在其中 ——
 * `spawn` 它直接 ENOENT（本机实测）。
 */
const WIN_RUNNABLE_EXTS = new Set(['.exe', '.com', '.cmd', '.bat']);

/** 一条真正能交给 `spawn` / `execFile` 的启动描述 */
export interface LaunchSpec {
  file: string;
  args: string[];
  /**
   * true = `args` 已经是我们按 cmd.exe 的规则拼好的**一整条命令行**，Node 不要再加引号。
   *
   * Windows 上必须声明它（调用方要原样传给 `spawn` / `execFile`）：Node 自己的引号规则与 cmd
   * 不一样，`"C:\…\dsh.cmd"` 会被再转义成 `\"C:\…\dsh.cmd\"`，cmd 于是报
   * `'"…dsh.cmd"' is not recognized as an internal or external command`（本机实测）。
   * 这是「.cmd 不能直接 spawn（EINVAL）」之外的第二道坑，两条都在这里收口。
   */
  windowsVerbatimArguments: boolean;
}

function isCmdExe(file: string): boolean {
  // Windows 路径一律 `path.win32`（§7.23）：用 `path.basename` 会跟着"跑测试这台机器"走 ——
  // 在 macOS / Linux 上 `basename('C:\\Windows\\system32\\cmd.exe')` 返回整串，于是这里判成
  // false、走进 `.exe` 那条直连分支（门禁里 `M launchSpec` 红的就是这一条）。
  // Windows 上 `path.win32.basename === path.basename`，所以生产行为不变。
  const base = path.win32.basename(file).toLowerCase();
  return base === 'cmd.exe' || base === 'cmd';
}

/** PE 映像可以直接 spawn；其它可执行文件（`.cmd` / `.bat`）在 Windows 上都要经 cmd.exe */
function isPeImage(file: string): boolean {
  const ext = path.win32.extname(file).toLowerCase();
  return ext === '.exe' || ext === '.com';
}

/**
 * 这份路径在**自己的平台**上能不能被起起来。
 *
 * Windows 上只看扩展名：Node 安装目录里 `npm`（POSIX sh 脚本）与 `npm.cmd` 是并存的，
 * 只按 PATH 找「叫 npm 的那个文件」会拿到前者 —— 而它既不是 PE，也不是 cmd 能执行的批处理。
 * 所以**解析侧只认带可执行扩展名的**，执行侧再按扩展名决定要不要经 cmd.exe。
 */
export function isRunnablePath(file: string, platform: string): boolean {
  if (platform !== 'win32') return true;
  // 同上：这个是 Windows 专用判据（`platform === 'win32'` 才走），用 win32 的取扩展名规则，
  // 才能在非 Windows 的机器上被用例脚本测到（§7.23）。
  return WIN_RUNNABLE_EXTS.has(path.win32.extname(file).toLowerCase());
}

/**
 * 统一包装器：把「可执行文件 + argv」变成真正能起的 spec。
 * **凡是自己起 dsh / npm 的地方都用它**（env-doctor 的探测与一键修复、plugin-manager 的
 * dump 与装/卸/升级）—— 各写一遍就会出现「一条路能跑、另一条路报 not recognized」。
 *
 * - 非 Windows：原样返回 argv 数组；
 * - Windows + PE（`.exe` / `.com`）：可以直接 spawn，不需要 cmd 这层；
 * - Windows 其它（`.cmd` / `.bat` / 无扩展名），以及**已经是 cmd.exe 的调用**
 *   （`resolveDshLauncher` 给的 shim / npx / custom-shim 那条路）：经 `cmd.exe`，把 `/d /s /c`
 *   之后的整条命令拼成**一个**参数，再整条套一层引号 —— `/s` 会把最外层那对引号剥掉，
 *   剥完才是真命令行（cmd 的既定行为，`cross-spawn` 一类库也是这么拼的），否则路径里带空格 /
 *   最后一个参数带引号时会被 `/s` 的引号剥离规则切坏（真机实测：`C:\Program Files\nodejs\npm.cmd`
 *   会被切成 `'C:\Program Files' is not recognized as an internal or external command`）。
 */
export function launchSpec(file: string, args: string[], platform: string): LaunchSpec {
  if (platform !== 'win32') {
    return { file, args: [...args], windowsVerbatimArguments: false };
  }
  if (!isCmdExe(file) && isPeImage(file)) {
    return { file, args: [...args], windowsVerbatimArguments: false };
  }
  const parts =
    isCmdExe(file) && args[0] === '/d' && args[1] === '/s' && args[2] === '/c'
      ? args.slice(3) // 已经是引好的段落（dshArgsFor 拼的），原样接在后面
      : [file, ...args].map(quoteForCmd);
  return {
    file: isCmdExe(file) ? file : COMSPEC,
    args: ['/d', '/s', '/c', `"${parts.join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * 「启动 dsh」的统一入口：解析出来的 launcher（含 shim / npx / 自定义 shim 这三条回退分支）
 * 经它变成能真的 `spawn` / `execFile` 的 spec。
 *
 * 为什么必须走这里：`resolveDshLauncher()` 在这些回退分支上给的是 `cmd.exe` + `/d /s /c`
 * 前缀（见该函数），直接 `spawn(launcher.file, dshArgsFor(...))` 时 Node 会把内嵌的引号再
 * 转义一遍，cmd 报 `'"…dsh.cmd"' is not recognized` —— 也就是"用户自己装了 dsh 却解析不到"时
 * 插件页一整块功能都不可用。
 */
export function dshLaunchSpec(launcher: DshLauncher, args: string[], platform: string): LaunchSpec {
  return launchSpec(launcher.file, dshArgsFor(launcher, args), platform);
}

/** 解析要启动的 dsh web（= `dsh web --no-open` + 监听地址与附加参数） */
export function resolveDshInvocation(settings: SettingsValues): InvocationSpec {
  const args = ['web', '--no-open'];
  const host = String(settings.host || '127.0.0.1').trim();
  const port = Number(settings.port);
  if (host && host !== '127.0.0.1') args.push('--host', host);
  if (Number.isInteger(port) && port > 0) args.push('--port', String(port));
  args.push(...splitArgs(settings.extraArgs));

  const launcher = resolveDshLauncher(settings);
  return {
    file: launcher.file,
    args: dshArgsFor(launcher, args),
    display: [launcher.display, ...args].join(' '),
    kind: launcher.kind,
  };
}

/**
 * 选择本地 Shell（用于"新建本地 Shell"标签）。
 * Windows：pwsh > powershell > cmd；macOS/Linux：$SHELL > zsh > bash > sh。
 */
export function resolveShell(settings: SettingsValues): ShellSpec {
  const override = String(settings.shell || '').trim();
  if (override) return { file: override, args: [], display: override };

  if (isWindows) {
    const pwsh = whichSync('pwsh.exe');
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], display: pwsh };
    const powershell = whichSync('powershell.exe');
    if (powershell) return { file: powershell, args: ['-NoLogo'], display: powershell };
    return { file: COMSPEC, args: [], display: COMSPEC };
  }

  // macOS/Linux：优先用户当前交互 shell（登录模式，PATH 与终端里一致），
  // 依次回退 zsh / bash / sh。GUI 启动的应用 PATH 很窄，不加 -l 会找不到 homebrew 装的东西。
  //
  // 注意：POSIX 上**不要**自动优先 pwsh。装了 PowerShell 的 mac 不少（GitHub 的 macOS
  // runner 就自带），自动挑它会让"新建本地 Shell"意外开出 PowerShell，而不是用户自己的 zsh；
  // 自检也因此在 CI 上红过一条。想用 pwsh / fish 之类，就在设置里显式填路径。
  const fromEnv = String(process.env.SHELL || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return { file: fromEnv, args: ['-l'], display: fromEnv };
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(candidate)) return { file: candidate, args: ['-l'], display: candidate };
  }
  return { file: '/bin/sh', args: ['-l'], display: '/bin/sh' };
}
