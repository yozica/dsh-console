'use strict';

/**
 * 主进程逻辑自检（不需要 Electron、不会启动/结束任何进程）。
 * 运行：npm test
 *
 * 这里只剩**入口**：建好仓库事实（`test/repo.ts`），按主题依次跑 `test/checks/*`，
 * 最后汇总并给失败打注解（`test/harness.ts`）。断言本身在那些模块里 ——
 * 原来它们全挤在这一个文件的一个 6500 行 `main()` 里（拆分记录见 AGENTS §7.34）。
 *
 * 覆盖：
 *   1. dsh 启动命令解析（node + bin.js / shim / npx 三级回退，按平台判定）—— `checks/launch.ts`
 *   2. ANSI 清理 + 从 dsh 横幅里提取带令牌的 URL —— 同上
 *   3. HTTP 健康探测的 dsh 判据（真实探测本机端口 + 纯函数夹具）—— 同上
 *   4. 端口占用解析（Windows 的 netstat / macOS·Linux 的 lsof 夹具 + 可选的真实查询）—— 同上
 *   5. DshManager 状态机（外部实例接管判定）—— 同上
 *   6. 渲染层静态检查（含 macOS 的平台适配契约）—— `checks/renderer.ts`
 *   7. 主题、样式与视觉契约 —— `checks/styles.ts`
 *   8. 发布链路、自动更新契约与打包约定 —— `checks/release.ts`
 *   9. 插件装配层 / 补丁层 / 救援 —— `checks/plugin.ts`
 *  10. 运行环境自检（判定 + 探测 + 一键修复）—— `checks/env-doctor.ts`
 *  11. 首启环境向导与门禁界面 —— `checks/env-wizard.ts`
 *  12. 安装引擎（提权 / nvm / 归属与档位）—— `checks/install-engine.ts`
 */

import { report } from './harness';
import { createRepo } from './repo';
import { runLaunch } from './checks/launch';
import { runRenderer } from './checks/renderer';
import { runStyles } from './checks/styles';
import { runRelease } from './checks/release';
import { runPlugin } from './checks/plugin';
import { runEnvDoctor } from './checks/env-doctor';
import { runEnvWizard } from './checks/env-wizard';
import { runInstallEngine } from './checks/install-engine';

async function main(): Promise<void> {
  const repo = createRepo();

  await runLaunch(repo);
  runRenderer(repo);
  runStyles(repo);
  await runRelease(repo);
  runPlugin(repo);
  runEnvDoctor(repo);
  runEnvWizard(repo);
  runInstallEngine(repo);

  report();
}

main().catch((error) => {
  console.error('自检异常：', error);
  process.exitCode = 1;
});
