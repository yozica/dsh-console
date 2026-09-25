/**
 * 进程名查询、结束进程树、存活判定与 homeDir
 *
 * 结束进程树与进程存活判定（从 `process-utils.ts` 拆出来的；那个文件现在只做 barrel 再导出，
 * 6 个消费者与两个反例脚本的 import 路径不用改）。
 */
import { isWindows } from './process-types';

import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';

/** 查询 PID 对应的进程名（尽力而为）。 */
export function processNameSync(pid: number): Promise<string> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve('');
      return;
    }
    try {
      if (isWindows) {
        execFile(
          'tasklist',
          ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
          { windowsHide: true, timeout: 8000 },
          (error, stdout) => {
            if (error || !stdout) {
              resolve('');
              return;
            }
            const match = stdout.match(/^"([^"]+)","(\d+)"/m);
            resolve(match ? match[1] : '');
          },
        );
      } else {
        execFile('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 8000 }, (error, stdout) => {
          if (error || !stdout) {
            resolve('');
            return;
          }
          const name = String(stdout).trim().split(/\s+/)[0] || '';
          resolve(name);
        });
      }
    } catch {
      resolve('');
    }
  });
}

/** POSIX：递归收集 pid 的所有后代（pgrep -P 一层层展开，子先父后） */
function collectDescendants(pid: number, exec: typeof execFileSync): number[] {
  const out: number[] = [];
  const queue: number[] = [pid];
  let guard = 0;
  while (queue.length > 0 && guard < 64) {
    guard += 1;
    const parent = queue.shift() as number;
    let children: number[];
    try {
      const stdout = exec('pgrep', ['-P', String(parent)]);
      children = String(stdout || '')
        .split(/\s+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      children = [];
    }
    out.unshift(...children);
    queue.push(...children);
  }
  return out;
}

/** POSIX：优先杀"自己的进程组"（pgid==pid 时整组一起清），否则按后代顺序逐个终止。 */
function killPosixTree(pid: number, signal: NodeJS.Signals): void {
  try {
    const pgid = Number(
      String(
        execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim(),
    );
    if (Number.isInteger(pgid) && pgid > 0 && pgid === pid) {
      process.kill(-pgid, signal);
      return;
    }
  } catch {
    /* ps 不可用：退回逐个终止 */
  }
  try {
    const targets = [...collectDescendants(pid, execFileSync), pid];
    for (const target of targets) {
      try {
        process.kill(target, signal);
      } catch {
        /* 进程可能已退出 */
      }
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* 进程可能已退出 */
    }
  }
}

/** 终止进程树（Windows 用 taskkill /T /F，POSIX 用信号按组/按后代清）。 */
export function killTree(pid: number, force = true): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve(false);
      return;
    }
    if (isWindows) {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      try {
        execFile('taskkill', args, { windowsHide: true, timeout: 8000 }, (error) =>
          resolve(!error),
        );
      } catch {
        resolve(false);
      }
      return;
    }
    try {
      killPosixTree(pid, force ? 'SIGKILL' : 'SIGTERM');
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

/** 同步终止，用于退出应用前的兜底清理。 */
export function killTreeSync(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (isWindows) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 8000,
      });
    } else {
      killPosixTree(pid, 'SIGKILL');
    }
  } catch {
    /* 进程可能已退出 */
  }
}

/** 判断 PID 是否存活。 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function homeDir(): string {
  try {
    return os.homedir();
  } catch {
    return process.cwd();
  }
}
