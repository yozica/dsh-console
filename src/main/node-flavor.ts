/**
 * 安装包形态识别与静默参数
 *
 * t52 从 `node-installer.ts` 拆出来的（那个文件现在只剩 `NodeInstaller` 类 + `NodeInstallHooks`
 * 接口 + barrel；`buildPlan` 与 `transferPhase` 必须留在同一个文件里 —— 反例脚本按这对锚点
 * 切源码，见 AGENTS §7.35）。
 */

/** 安装包是谁做出来的：决定"静默安装"的参数长什么样（两家用的字母完全不同） */
export type InstallerFlavor = 'inno' | 'nsis' | 'unknown';

/**
 * 从安装包的字节里认出它是 Inno Setup 还是 NSIS（纯函数，夹具喂几个字节就能测）。
 *
 * 为什么要认：静默参数是**两家各自的**约定 —— Inno 是 `/VERYSILENT`（NSIS 的 `/S` 它不认），
 * NSIS 是 `/S`。写死一个就会在另一家上什么也不发生（最糟的是"看起来成功、其实弹了向导"）。
 * 标记都是各自 overlay 里的固定字符串：NSIS 是 `NullsoftInst`（"Nullsoft Install System"），
 * Inno 是 `Inno Setup Setup Data`。都找不到就老实说 `unknown`（那时按可见向导走并提示用户）。
 */
export function detectInstallerFlavor(bytes: Buffer | null | undefined): InstallerFlavor {
  if (!bytes || bytes.length === 0) return 'unknown';
  // NSIS 放在前面判：它的标记更独特；而 Inno 的安装包里不会同时出现 Nullsoft 的 overlay
  if (bytes.includes(Buffer.from('NullsoftInst'))) return 'nsis';
  if (bytes.includes(Buffer.from('Inno Setup'))) return 'inno';
  return 'unknown';
}

/**
 * 静默安装参数（纯函数）。认不出来时返回**空数组** —— 那就走它自己的可见向导，
 * 并且必须把"需要你在窗口里点一下"告诉用户（VM-02 的教训：不许让界面说"只管等"）。
 */
export function installerSilentArgs(flavor: InstallerFlavor): string[] {
  if (flavor === 'nsis') return ['/S'];
  if (flavor === 'inno') return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'];
  return [];
}
