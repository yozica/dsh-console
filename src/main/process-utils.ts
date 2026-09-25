/**
 * 进程/网络相关工具：dsh 命令探测、端口占用查询、进程树终止、HTTP 健康探测。
 *
 * Windows 依赖自带的 netstat/tasklist/taskkill；
 * macOS/Linux 用 lsof（端口占用）、ps（进程名）、POSIX 信号（终止）。
 * 除这两组系统命令外不需要任何额外组件。
 *
 * t50 起这个文件只是 **barrel**：实现按主题住在 `process-*.ts` 里，这里把**公开面**逐条
 * 再导出一次（不用 `export *` —— 那些模块里还有只给兄弟模块用的内部件，不该跟着漏出来）。
 * 调用方（`main.ts` / `dsh-manager.ts` / `env-doctor.ts` / `node-installer.ts` /
 * `plugin-manager.ts` / `pty-sessions.ts` / 两个反例脚本 / 自检）一行都不用改。
 * **不要在这里加运行时逻辑** —— 它只做转发。
 */
export { COMSPEC, isMac, isWindows } from './process-types';
export {
  findNodeExe,
  findSkippedNodeShim,
  isNodeShim,
  stripAnsi,
  whichSync,
  windowsBinCandidates,
} from './process-shell';
export {
  VC_RUNTIME_DLLS,
  findPnpm,
  findPnpmForProfile,
  findPnpmWindows,
  hasVcRuntime,
  parseProfilePnpmMajor,
  pnpmExeNames,
  pnpmVersionOf,
  readProfilePnpmMajor,
  vcRuntimePaths,
} from './process-pnpm';
export { envWithKnownBins, findGlobalDshBinJs, pathWithKnownBins } from './process-path-env';
export {
  canRunDsh,
  dshArgsFor,
  dshInterpreterCandidates,
  pickDshInterpreter,
  resolveDshLauncher,
  splitArgs,
} from './process-dsh';
export {
  dshLaunchSpec,
  isRunnablePath,
  launchSpec,
  resolveDshInvocation,
  resolveShell,
} from './process-launch';
export {
  isDshResponse,
  parseLsofForPort,
  parseNetstatForPort,
  portOwnerSync,
  probeHttp,
} from './process-probe';
export { homeDir, isAlive, killTree, killTreeSync, processNameSync } from './process-proc';
export type {
  DshLauncher,
  InterpreterCandidate,
  InvocationSpec,
  PortOwner,
  ProbeResult,
  ShellSpec,
} from './process-types';
export type { PnpmPick } from './process-pnpm';
export type { LaunchSpec } from './process-launch';
