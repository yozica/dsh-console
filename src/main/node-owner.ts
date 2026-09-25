/**
 * 这台机器上的 Node 是谁装的（归属判定 + 注册表 PATH 合并）
 *
 * t52 从 `node-installer.ts` 拆出来的（那个文件现在只剩 `NodeInstaller` 类 + `NodeInstallHooks`
 * 接口 + barrel；`buildPlan` 与 `transferPhase` 必须留在同一个文件里 —— 反例脚本按这对锚点
 * 切源码，见 AGENTS §7.35）。
 */
import path from 'node:path';

import type { NvmModel } from './node-nvm';

import type { EnvNodeOwner } from '../shared/ipc';

/** 版本管理器的目录名特征（除 nvm 之外的版本管理器：认得出「不是系统装的」，但不当成 nvm） */
const OTHER_MANAGER_DIRS = ['volta', 'fnm', 'nvs', 'nodist', 'scoop'];

/** nvm 的目录名：**独立的一段**才算（`D:\nvm-tools\node.exe` 不误判 —— N4c 那条判据继续成立） */
const NVM_DIR_NAMES = ['nvm', 'nvm4w'];

/** 取自环境的一份值（键名大小写不敏感；Windows 上 NVM_HOME / Nvm_Home 都见过） */
export function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase());
  const value = key ? env[key] : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeForCompare(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/"/g, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

function isUnder(child: string, parent: string): boolean {
  const target = normalizeForCompare(child);
  const root = normalizeForCompare(parent);
  if (!target || !root) return false;
  return target === root || target.startsWith(`${root}\\`);
}

/**
 * 「当前这份 Node 是谁管的」——**纯函数**：只读入参、没有 IO、不抛（冻结 §4.2 的 t29 形状，需求 §7.7）。
 *
 * 三条定死的规矩：
 *  1. **判据只有一份**：采集侧（`main/env-doctor.ts` 的完整探测与快速探测）与安装计划都调这一个导出，
 *     全仓库没有第二处路径归属判断（渲染层更不许自己猜）；
 *  2. 判据里**没有一条依赖子进程**：`nvm env` 只是加分证据（这里连它都不需要），
 *     所以启动瞬间的快速探测也判得出来；
 *  3. **没有"剩下的一律当系统装的"这条兜底**：`system` 必须**有正面证据**（官方默认安装位 /
 *     官方安装包自己写下的安装目录），其余一律 `unknown` —— 那条兜底正是 VM-14
 *     （在版本管理器管的机器上按"系统装的"又装一份官方 MSI）。
 *
 * 顺序即优先级：版本管理器的目录（模型给的根 / 版本目录 / 当前版本目录 + `NVM_*` 变量）→
 * 路径里那条独立的 `nvm` / `nvm4w` 目录名 → 官方安装位 → 其余（含 volta / fnm 等别的管理器）`unknown`。
 */
export function detectNodeOwner(input: {
  /** 自检报告里那份 Node 的真实路径（`findNodePath()` 的结果）；没找到时 null */
  nodePath: string | null;
  env: NodeJS.ProcessEnv;
  /** §7.6 推导出来的版本管理器模型（`deriveNvmModel` 的产物）；推不出来时 null */
  model: NvmModel | null;
  /** 官方安装包写在注册表里的安装目录（`HKLM\SOFTWARE\Node.js` 的 `InstallPath`）；读不到时 null */
  msiInstallPath: string | null;
}): { owner: EnvNodeOwner; evidence: string[] } {
  const target = normalizeForCompare(input.nodePath ?? '');
  if (!target) {
    return { owner: 'unknown', evidence: ['没找到 Node 的可执行文件，所以判不出这份 Node 归谁管'] };
  }
  const shown = String(input.nodePath ?? '').trim();

  // ① 版本管理器（nvm-windows）：模型的目录 / 变量给的目录 / 路径里那条独立的目录名
  const nvmEvidence: string[] = [];
  const model = input.model;
  if (model) {
    const dirs: [string, string][] = [
      ['版本管理器的版本目录', model.installsDir ?? ''],
      ['版本管理器的当前版本目录', model.activeDir ?? ''],
      ['版本管理器的程序根目录', model.root],
    ];
    for (const [label, dir] of dirs) {
      if (dir && isUnder(target, dir)) nvmEvidence.push(`${label} ${dir}`);
    }
  }
  for (const name of ['NVM_SYMLINK', 'NVM_HOME', 'NVM_DIR']) {
    const value = envValue(input.env, name);
    if (value && isUnder(target, value)) nvmEvidence.push(`环境变量 ${name}=${value}`);
  }
  const segments = target.split('\\').map((segment) => segment.replace(/^\./, ''));
  const nvmSegment = segments.find((segment) => NVM_DIR_NAMES.includes(segment));
  if (nvmSegment) {
    nvmEvidence.push(`路径里那条独立的 ${nvmSegment} 目录名：${shown}`);
  }
  if (nvmEvidence.length > 0) {
    return { owner: 'nvm', evidence: nvmEvidence.map((item) => `这份 Node 归版本管理器：${item}`) };
  }

  // ② 官方安装包的**正面证据**：官方默认安装位，或安装包自己写下的安装目录
  const systemEvidence: string[] = [];
  const programFiles = envValue(input.env, 'ProgramFiles');
  const programFilesX86 = envValue(input.env, 'ProgramFiles(x86)');
  const officialDirs = [
    programFiles ? path.win32.join(programFiles, 'nodejs') : 'C:\\Program Files\\nodejs',
    programFilesX86 ? path.win32.join(programFilesX86, 'nodejs') : '',
    input.msiInstallPath ?? '',
  ].filter((dir) => dir !== '');
  for (const dir of officialDirs) {
    if (isUnder(target, dir)) systemEvidence.push(dir);
  }
  if (systemEvidence.length > 0) {
    return {
      owner: 'system',
      evidence: systemEvidence.map((dir) => `这份 Node 在官方安装包的安装位：${dir}`),
    };
  }

  // ③ 其余全部 `unknown`：别的版本管理器也在这里（它们既不是 nvm，也不该按"系统装的那一份"去覆盖）
  const other = segments.find((segment) => OTHER_MANAGER_DIRS.includes(segment));
  if (other) {
    return {
      owner: 'unknown',
      evidence: [
        `这份 Node 归别的版本管理器（路径里有 ${other} 目录），不是 nvm，也不该当成系统装的那一份`,
      ],
    };
  }
  return { owner: 'unknown', evidence: [`认不出这份 Node 是谁装的：${shown}`] };
}

/**
 * 用户级 + 机器级 PATH 合成一段（去重、顺序稳定、保留调用方给的原文与键名）。
 *
 * 为什么是纯函数：读注册表是 IO（真机上才跑得到），而「两段怎么合」是判定 ——
 * 这段合并逻辑必须能在没有 Windows 的机器上被反例钉住（需求 §7.4）。
 * 分隔符固定 `;`：这两段 PATH 来自 Windows 注册表，这里的语义就是 Windows 的。
 */
export function mergePathFromRegistry(machine: string | null, user: string | null): string {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const segment of [machine, user]) {
    for (const raw of String(segment ?? '').split(';')) {
      const dir = raw.trim();
      if (!dir) continue;
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push(dir);
    }
  }
  return dirs.join(';');
}

/**
 * 下载源校验：只认 http(s)，去掉末尾斜杠；写错 / 留空返回 null（当没填，走官方直连）。
 * 与既有的「插件安装源」同款做法：**只影响我们这一次下载，不写用户任何配置文件**。
 */
export function normalizeNodeSource(value: string): string | null {
  const text = String(value ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!text) return null;
  if (!/^https?:\/\/[^\s/]+/i.test(text)) return null;
  return text;
}

/**
 * 「当前进程是不是提权跑的」的判定（喂一次只读探测的输出与退出码）。
 *
 * 用的探针是 `whoami /groups`：它的输出里有完整性级别的 SID，**与系统语言无关**
 * （本机实测非提权时那一行是 `Mandatory Label\Medium Mandatory Level Label S-1-16-8192`，
 * 退出码 0）。只认正向证据：读到 High（`S-1-16-12288`）/ System（`S-1-16-16384`）才算
 * 「提权」。读不出来（没跑成、输出不认识）按**否**处理，因为这条判定的用途是拦下
 * 「管理员身份装版本管理器」（冻结文档 R-23）；没有证据就不拦人，确认区仍然会写明
 * 「不要用管理员身份运行」这句话。
 */
export function isElevatedProbeOutput(stdout: string, status: number | null): boolean {
  if (status !== 0) return false;
  return /s-1-16-(?:12288|16384)\b/i.test(String(stdout ?? ''));
}
