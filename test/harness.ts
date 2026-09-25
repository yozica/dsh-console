'use strict';

/**
 * 自检的公共件：断言登记、统计、CI 注解，以及"这台机器能不能起子进程"的探测。
 *
 * 这些原本长在 `test/selftest.ts` 的顶部（那里是一个 6500 行的 `main()`）。拆开之后
 * 各主题的检查放在 `test/checks/*.ts`，统一用这里的 `check()` / `skip()` 登记，
 * 汇总与失败注解也只留一份 —— 否则每个模块各打一份汇总，输出就没法按行比对了。
 */

import { execFile } from 'node:child_process';

export const IS_WINDOWS = process.platform === 'win32';

export interface CheckResult {
  name: string;
  ok: boolean;
  /** 这条断言打印的实际值（失败时进 CI 注解，见文件末尾汇总） */
  extra?: unknown;
}

const results: CheckResult[] = [];

export function check(name: string, ok: boolean, extra?: unknown): void {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
}

export function skip(name: string, why: string): void {
  console.log(`SKIP  ${name}  — ${why}`);
}

/** 当前环境能否启动外部命令（受限沙箱里 netstat/lsof/ps 会被拒） */
export function canSpawnBinaries(): Promise<boolean> {
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
export function canQueryProcessName(): Promise<boolean> {
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

/** 汇总与退出码（原来在 `main()` 末尾）：失败时在 GitHub Actions 里连实际值一起标成注解 */
export function report(): void {
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
