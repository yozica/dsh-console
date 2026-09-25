'use strict';

/**
 * 自检共用的"仓库事实"：路径、临时目录、共享的 `Settings` 实例。
 *
 * 原来这些都长在 `test/selftest.ts` 的 `main()` 开头，别的段落（环境自检、安装引擎、
 * 门禁界面）隔着几千行还在用同一个 `settings` / `sandbox` —— 拆文件时它们必须有一个
 * 公开的落脚点，所以收进这里。往后各主题要共享的"读到的源码文本"也加在这一份里，
 * 以免出现"检查 A 从检查 B 的文件里 import 一个派生值"这种绕回去的依赖。
 */

import fs from 'node:fs';
import path from 'node:path';

import { Settings } from '../src/main/settings';

export interface Repo {
  /** 仓库根 */
  root: string;
  /** 自检的临时目录（`.verify/`，建好且被 git 忽略） */
  sandbox: string;
  /** 共享的设置实例（§1 起就要求：不认识的键要报错、且一个字都不写） */
  settings: Settings;
}

export function createRepo(): Repo {
  const root = path.join(__dirname, '..');
  const sandbox = path.join(root, '.verify');
  fs.mkdirSync(sandbox, { recursive: true });

  const settings = new Settings(path.join(sandbox, 'settings.json'));
  settings.patch({ port: 3080, host: '127.0.0.1', extraArgs: '' });

  return { root, sandbox, settings };
}
