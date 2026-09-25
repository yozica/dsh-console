/**
 * dsh 解释器候选与启动命令解析（含每个进程只测一次的实测缓存）
 *
 * 决定用哪个 node + bin.js 跑 dsh（从 `process-utils.ts` 拆出来的；那个文件现在只做 barrel 再导出，
 * 6 个消费者与两个反例脚本的 import 路径不用改）。
 */
import { findGlobalDshBinJs } from './process-path-env';
import {
  findNodeExe,
  isExecutableFile,
  isFile,
  versionManagerInstalls,
  whichSync,
} from './process-shell';
import type { DshLauncher, InterpreterCandidate } from './process-types';
import type { SettingsValues } from './settings';

import { COMSPEC, isWindows } from './process-types';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 「解释器 + dsh 入口脚本」的候选组合，按"最可能可用"排序。
 *
 * 为什么要成对而不是各自独立挑：dsh 的 CLI 对 Node 版本敏感 —— 实测同一份
 * bin.js，`node 22` 上会**静默什么都不做就退出（无输出、退出码 0）**，
 * `node 24` 上正常打印版本号并起服务。而 macOS 上 PATH 里的 node 未必是能跑它的那个
 * （这台机器 PATH 里是 vite-plus 包装的 v22，nvm 下另有 v24）。
 * 所以优先给出"同一个安装目录里的 node + dsh"这种天然匹配的组合，
 * 再由 canRunDsh 实测确认。
 */
export function dshInterpreterCandidates(): InterpreterCandidate[] {
  const out: InterpreterCandidate[] = [];
  const seen = new Set<string>();
  const push = (node: string | null, binJs: string | null, source: string) => {
    if (!node || !binJs) return;
    const key = `${node}\u0000${binJs}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ node, binJs, source });
  };

  // 1. PATH 里的 node + PATH shim 反推出的 bin.js（最贴近用户当前环境，Windows 常态）
  const pathNode = whichSync(isWindows ? 'node.exe' : 'node');
  const shim = findDshShim();
  const shimBinJs = shim ? (binJsCandidates(shim).find(isFile) ?? null) : null;
  push(pathNode, shimBinJs, 'PATH shim');

  // 2. 版本管理器里"配套"的 node + dsh（同一个版本目录，最新版本优先）
  if (!isWindows) {
    for (const install of versionManagerInstalls()) {
      push(
        path.join(install.bin, 'node'),
        path.join(install.modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        'nvm/fnm 配套安装',
      );
    }
  }

  // 3. PATH 里的 node + 任意扫到的全局安装
  push(pathNode, findGlobalDshBinJs(), 'PATH node + 全局安装');

  // 4. 其它常见位置找到的 node + 全局安装
  const foundNode = isWindows ? pathNode : findNodeExe();
  push(foundNode, findGlobalDshBinJs(), '已知位置 node + 全局安装');

  return out.filter((candidate) => isExecutableFile(candidate.node) && isFile(candidate.binJs));
}

/** 探针结果缓存：键是"解释器 + 入口脚本"，取值是否可用 */
const dshProbeCache = new Map<string, boolean>();

/**
 * 实测「这个 node 能不能跑这份 dsh」——跑一次 `--version`，有输出才算能用。
 *
 * 比硬编码"要求 Node ≥ x"稳：dsh 的版本要求会变，而且它不满足要求时**不报错**，
 * 只安静地退出（退出码 0、零输出），光看退出码根本发现不了。
 * 结果缓存，所以同一组合每个进程只测一次。
 */
export function canRunDsh(nodeExe: string, binJs: string): boolean {
  const key = `${nodeExe}\u0000${binJs}`;
  const cached = dshProbeCache.get(key);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    const stdout = execFileSync(nodeExe, [binJs, '--version'], {
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    ok = String(stdout || '').trim().length > 0;
  } catch {
    // 起不来 / 超时 / 没有输出：都当作"这个组合不可用"
    ok = false;
  }
  dshProbeCache.set(key, ok);
  return ok;
}

/**
 * 挑一个真能跑 dsh 的解释器组合。
 * 所有候选都测不过（例如受限环境不允许再起子进程）时，退回第一个候选 ——
 * 宁可把问题留给运行期，也不要在这里直接失败。
 */
export function pickDshInterpreter(): InterpreterCandidate | null {
  const candidates = dshInterpreterCandidates();
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    if (canRunDsh(candidate.node, candidate.binJs)) return candidate;
  }
  return candidates[0];
}

/** 拆分带引号的参数串，例如 --flag "a b" -> ['--flag', 'a b'] */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

/** 把字符串参数包成 cmd.exe 可安全执行的形式（仅 Windows 用） */
export function quoteForCmd(value: string): string {
  return /[\s&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 平台感应的 dsh shim 文件（Windows 的 dsh.cmd / POSIX 的 dsh） */
function findDshShim(): string | null {
  if (isWindows) return whichSync('dsh.cmd') || whichSync('dsh.exe');
  return whichSync('dsh');
}

/**
 * npm 全局安装的 dsh 包根目录里那条 bin.js 的候选位置。
 * 布局因平台而异：Windows 的 %APPDATA%\npm 把 shim 与 node_modules 放同一层，
 * POSIX 的全局 bin（如 /opt/homebrew/bin）的 shim 是指向 ../lib/node_modules 的符号链接。
 */
function binJsCandidates(shimPath: string): string[] {
  const prefix = path.dirname(shimPath);
  const candidates = [path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')];
  if (!isWindows) {
    const real = (() => {
      try {
        return fs.realpathSync(shimPath);
      } catch {
        return shimPath;
      }
    })();
    const realDir = path.dirname(real);
    candidates.push(
      path.join(realDir, '..', 'lib', 'bin.js'),
      path.join(prefix, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(realDir, '..', '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    );
  }
  return candidates;
}

/**
 * 解析"怎么调用 dsh"（不含子命令）。
 * 优先级：自定义命令 > node + dsh 入口脚本（实测能跑的组合）> dsh shim > npx
 *
 * 两道保险都是为了"明明装了 dsh 却起不来"这类问题：
 *  1. 不依赖 PATH：shim 不在 PATH 里时直接扫 nvm/fnm、homebrew、pnpm 的全局安装目录
 *     （macOS 上 GUI 启动的 PATH 很窄，只有 /usr/bin:/bin:/usr/sbin:/sbin）。
 *  2. 解释器要实测：dsh 的 CLI 在旧 Node 上会**静默退出**（无输出、退出码 0），
 *     所以候选组合会跑一次 `--version` 验证，只挑真能跑的那个（见 pickDshInterpreter）。
 */
export function resolveDshLauncher(settings: SettingsValues): DshLauncher {
  const override = String(settings.dshCommand || '').trim();
  if (override) {
    // 支持写整条命令行，例如「/path/to/node /path/to/@deepseek-ai/dsh/lib/bin.js」——
    // 这样"换一个能跑 dsh 的 Node"才表达得出来（第一个 token 是可执行文件，其余是我们的前置参数）
    const parts = splitArgs(override);
    const file = parts[0];
    const prefixArgs = parts.slice(1);
    if (/\.(cmd|bat)$/i.test(file) && !isWindows) {
      throw new Error(
        `自定义命令 ${file} 是 Windows 批处理脚本，macOS 上无法执行。可以改成「node 的绝对路径 + dsh 入口脚本」，例如 /path/to/bin/node /path/to/@deepseek-ai/dsh/lib/bin.js。`,
      );
    }
    if (/\.(cmd|bat)$/i.test(file)) {
      return {
        file: COMSPEC,
        prefixArgs: ['/d', '/s', '/c', `"${file}"`, ...prefixArgs],
        viaCmd: true,
        display: override,
        kind: 'custom-shim',
      };
    }
    return { file, prefixArgs, viaCmd: false, display: override, kind: 'custom' };
  }

  const picked = pickDshInterpreter();
  if (picked) {
    return {
      file: picked.node,
      prefixArgs: [picked.binJs],
      viaCmd: false,
      display: `${picked.node} ${picked.binJs}`,
      kind: 'node-bin',
    };
  }
  const dshShim = findDshShim();
  if (dshShim) {
    if (isWindows) {
      return {
        file: COMSPEC,
        prefixArgs: ['/d', '/s', '/c', `"${dshShim}"`],
        viaCmd: true,
        display: dshShim,
        kind: 'shim',
      };
    }
    return { file: dshShim, prefixArgs: [], viaCmd: false, display: dshShim, kind: 'shim' };
  }
  const npx = whichSync(isWindows ? 'npx.cmd' : 'npx');
  if (npx) {
    const prefixArgs = ['-y', '@deepseek-ai/dsh'];
    if (isWindows) {
      return {
        file: COMSPEC,
        prefixArgs: ['/d', '/s', '/c', `"${npx}"`, ...prefixArgs],
        viaCmd: true,
        display: `${npx} ${prefixArgs.join(' ')}`,
        kind: 'npx',
      };
    }
    return {
      file: npx,
      prefixArgs,
      viaCmd: false,
      display: `${npx} ${prefixArgs.join(' ')}`,
      kind: 'npx',
    };
  }
  throw new Error(
    isWindows
      ? '找不到 dsh：PATH 里既没有 dsh.cmd，也没有 node/npx。请在设置里指定启动命令。'
      : '找不到 dsh：既没有全局安装的 @deepseek-ai/dsh，PATH 里也没有 node/npx。请在设置里指定启动命令。',
  );
}

/**
 * 把 dsh 子命令拼成最终 argv。
 * cmd.exe 那条路要按 cmd 的转义规则处理（`&`、引号等），这是唯一需要平台分支的地方。
 */
export function dshArgsFor(launcher: DshLauncher, args: string[]): string[] {
  if (!launcher.viaCmd) return [...launcher.prefixArgs, ...args];
  return [...launcher.prefixArgs, ...args.map(quoteForCmd)];
}
