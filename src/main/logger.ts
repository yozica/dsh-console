/**
 * 把主进程的 console 输出同时写进 <userData>/logs/console.log。
 * 非 GUI 场景（或用户懒得看终端）时，这里是排查启动问题最直接的入口。
 *
 * 说明：源码一律用 ESM 的 import/export 语法，tsc 仍按 CommonJS 输出（见 tsconfig.main.json），
 * 所以 `require()` 加载它的地方（自检、Electron 入口）不受影响。
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

export interface FileLog {
  file: string;
  close: () => void;
}

type ConsoleLevel = 'log' | 'warn' | 'error';

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function installFileLogging(dir: string): FileLog {
  const file = path.join(dir, 'console.log');
  let stream: fs.WriteStream;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 超过上限就从头写，避免无限增长
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BYTES) fs.truncateSync(file, 0);
    } catch {
      /* 首次运行 */
    }
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch (error) {
    console.error(
      '[logger] 无法创建日志文件:',
      error instanceof Error ? error.message : String(error),
    );
    return { file: '', close: () => {} };
  }

  const originals: Record<ConsoleLevel, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const stamp = () => new Date().toISOString();
  const emit = (level: ConsoleLevel, args: unknown[]) => {
    const text = args.map(describe).join(' ');
    try {
      stream.write(`${stamp()} [${level}] ${text}\n`);
    } catch {
      /* 写失败就算了，不能因为日志把应用搞挂 */
    }
  };

  const levels: ConsoleLevel[] = ['log', 'warn', 'error'];
  for (const level of levels) {
    console[level] = (...args: unknown[]) => {
      originals[level](...args);
      emit(level, args);
    };
  }

  return {
    file,
    close: () => {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
      try {
        stream.end();
      } catch {
        /* ignore */
      }
    },
  };
}
