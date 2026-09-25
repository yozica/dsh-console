/**
 * 失败分类与人话文案（退出码 / 提示词 → 类别 + 出路）
 *
 * t52 从 `node-installer.ts` 拆出来的（那个文件现在只剩 `NodeInstaller` 类 + `NodeInstallHooks`
 * 接口 + barrel；`buildPlan` 与 `transferPhase` 必须留在同一个文件里 —— 反例脚本按这对锚点
 * 切源码，见 AGENTS §7.35）。
 */
import { NODE_DOWNLOAD_PAGE, OUTPUT_TAIL_CHARS } from './node-shared';

/** 安装 / 更新失败的结构化类别（界面据此说人话，不解析 stderr） */
export type InstallFailureKind =
  | 'network'
  | 'permission'
  | 'checksum'
  | 'unsigned'
  | 'busy'
  | 'disk'
  | 'unsupported'
  | 'cancelled'
  | 'timeout'
  /** 版本管理器那条路：装完了但没有 active 的 Node（VM 实测：npm shim 存在却跑不起来） */
  | 'nvm-inactive'
  /** `nvm use` 建符号链接没权限（Windows 普通权限 + 开发者模式没开） */
  | 'symlink'
  /** 要建链接的位置已经有一个同名文件夹 */
  | 'target-exists'
  /**
   * 提权那一次**等太久**（F-02）：这不是"没有权限"，是"我们不等了、那次提权可能还在进行"。
   * 结论只在事实复检之后才给（见 `settleElevationTimeout`）。
   */
  | 'elevation-timeout'
  /** 用户在 UAC 对话框上没允许（明确的"没同意"） */
  | 'elevation-declined'
  /** 提权那条路本身没跑通（PowerShell 报错 / 退出码读不出来） */
  | 'elevation-failed'
  | 'unknown';

/** 一条失败：类别 + 一句给用户看的人话 + 给事件日志的出路 */
export interface InstallFailureReason {
  kind: InstallFailureKind;
  message: string;
  hint: string | null;
}

/** 安装器 / 系统给的退出码 → 类别（Windows Installer 那几个编号是稳定契约） */
const EXIT_CODE_KINDS: Record<number, InstallFailureKind> = {
  // Windows Installer
  112: 'disk', // 磁盘空间不足
  1602: 'cancelled', // 用户取消了安装（也可能是关掉了提权询问 —— 分不清时只说第 2 条）
  1223: 'permission', // 用户在提权询问上点了"否"
  1925: 'permission', // 没有足够的权限做整机安装
  1730: 'permission', // 没有足够的权限
  1303: 'permission', // 目录写不进去
  1304: 'permission',
  1625: 'permission', // 被系统策略拦下
  1314: 'permission',
  1618: 'busy', // 系统里已经有一个安装在进行
  1622: 'unknown', // 写日志失败
  1601: 'unknown', // 安装服务不可用
  1603: 'unknown', // 致命错误（细节在安装日志尾部）
  1619: 'unknown', // 安装包打不开（多半是下载不完整）
  1620: 'unknown',
};
const EXIT_CODE_MESSAGES: Partial<Record<InstallFailureKind, string>> = {
  permission: '你拒绝了管理员权限，这台电脑上什么都没改。',
  cancelled: '安装没有完成，这台电脑上什么都没改。',
  busy: '系统里已经有一个安装正在进行，这一次没能开始。',
  disk: '这台电脑的可用空间不够，安装没有开始。',
};

export const FAILURE_HINTS: Record<InstallFailureKind, string> = {
  network:
    '① 用浏览器打开官方下载页自己装 ② 换一个下载源 ③ 装好后点「重新检测」。下载页：' +
    NODE_DOWNLOAD_PAGE,
  permission: '可以改用不用管理员权限的方式安装（版本管理器），或者点「重新检测」看当前情况。',
  checksum: '可以换一个下载源再试，或者用浏览器打开下载页自己装。',
  unsigned: '可以用浏览器打开官方下载页自己装，或者换一个下载源再试。',
  busy: '等那个安装结束后点「重新检测」，或者关掉它再试一次。',
  disk: '清出一些空间再试一次；也可以在系统设置里卸掉不再需要的东西。',
  unsupported: '可以换一个版本档，或者用浏览器打开下载页自己装。',
  cancelled: '可以重新试一次，或者自己到官方下载页装。',
  timeout: '安装可能还在后台继续；按它自己的提示做完，再点「重新检测」。',
  'nvm-inactive':
    '重开一次应用再重试这一步就行 —— 我们会自己挑一个稳定版装好并切过去；如果还是不行，日志里有每一步的命令、退出码与原文，可以拿它来排查。',
  symlink:
    '两条路：① 在「设置 → 系统 → 开发者选项」里打开「开发者模式」，再重试这一步；② 或者重开应用时用管理员身份运行一次，让这一步能建链接。',
  'target-exists':
    '把那个同名文件夹改名或删掉再重试；如果它是之前安装的 Node，删掉之后版本管理器就能接管这个位置。',
  'elevation-timeout':
    '可以等一会儿再点「重新检测」（提权之后的那一步可能还在进行）；也可以先在 Windows 的「设置 → 系统 → 开发者选项」里打开「开发者模式」，再重试这一步。',
  'elevation-declined':
    '想要建这个链接，可以打开 Windows 的「开发者模式」后重试（那样就不需要管理员权限），或者在重开应用时用管理员身份运行一次。',
  'elevation-failed':
    '可以打开 Windows 的「开发者模式」后重试（那样就不需要管理员权限），或者在重开应用时用管理员身份运行一次。',
  unknown:
    '如果系统里留下了装了一半的东西，可以到「应用」里把它卸载掉再重试；也可以自己到官方下载页装。',
};

export const FAILURE_MESSAGES: Record<InstallFailureKind, string> = {
  network: '下载没成功（连接超时或连不上）。',
  permission: '你拒绝了管理员权限，这台电脑上什么都没改。',
  checksum: '完整性校验没通过，已删除，没有安装任何东西。',
  unsigned: '这个安装包没有数字签名，我们没有安装它。',
  busy: '系统里已经有一个安装正在进行，这一次没能开始。',
  disk: '这台电脑的可用空间不够，安装没有开始。',
  unsupported: '这条安装路径现在不能走。',
  cancelled: '安装没有完成，这台电脑上什么都没改。',
  timeout: '这一步超过时限没结束，我们已经停止等待。',
  'nvm-inactive': '版本管理器装好了，但还没有任何一个 Node 版本被它启用，所以这一步没有完成。',
  symlink: '这一步要在系统里创建一个链接，但没有权限，所以没有完成。',
  'target-exists': '要创建链接的位置已经有一个同名的文件夹，所以没有完成。',
  'elevation-timeout':
    '权限询问等太久，我们已经停止等待；这次提权操作可能仍在系统里进行，我们会用事实复检之后再下结论。',
  'elevation-declined': '创建链接需要一次管理员权限，这一次没有允许，所以这一步没有完成。',
  'elevation-failed': '没能通过一次管理员权限完成这一步。',
  unknown: '安装没有成功，这台电脑上什么都没改。',
};

/** 提权那段：UAC 对话框等太久时的状态句（是"未确定"，不是"失败"） */
export const ELEVATION_TIMEOUT_MESSAGE =
  '权限询问等太久，我们已经停止等待，但这次提权操作可能仍在系统里进行。';
/** 提权那段：请求权限时先推给界面的状态（必须在 UAC 对话框出现之前就渲染出来） */
export const ELEVATION_WAITING_MESSAGE = '正在请求一次管理员权限、请在弹出的窗口里选择。';

/** 「读到它明确未签名 / 签名无效」那一条：结论在下载之后才有，所以别处不出现 */
export function unsignedFailure(message: string): InstallFailureReason {
  return { kind: 'unsigned', message, hint: FAILURE_HINTS.unsigned };
}

/**
 * 把安装过程的原文与退出码归纳成结构化的一条失败；**认不出来也只是 `unknown`，不编因果**。
 *
 * 纯函数（不碰磁盘 / 不起子进程 / 不看时钟），夹具可以直接喂
 * `'Access is denied.'` / `1602` 这些真机见过的原文。
 */
export function classifyInstallFailure(text: string, code: number | null): InstallFailureReason {
  const tail = String(text ?? '').slice(-OUTPUT_TAIL_CHARS);
  const make = (kind: InstallFailureKind, message?: string): InstallFailureReason => ({
    kind,
    message: message ?? FAILURE_MESSAGES[kind],
    hint: FAILURE_HINTS[kind],
  });

  // 1. 我们自己的判定（校验与下载器写得出的稳定句子）优先
  if (/完整性校验没通过|校验值不一致|签名与安装包内容不一致/.test(tail)) return make('checksum');
  if (/没有数字签名|未签名/.test(tail)) return make('unsigned');
  // 2. 退出码（Windows Installer 的编号是稳定契约，比文本可靠）
  if (code !== null) {
    const mapped = EXIT_CODE_KINDS[code];
    if (mapped) {
      const message = EXIT_CODE_MESSAGES[mapped];
      if (message) return make(mapped, message);
      // 编号认识、但具体原因认不出：把人话补上编号（原文与安装日志在输出区）
      return make(mapped, `安装没有成功（退出码 ${code}），这台电脑上什么都没改。`);
    }
  }
  // 3. 原文。**版本管理器那条路的原文优先**：它们说的都是"哪一步没成"，
  //    比笼统的权限 / 未知准得多（VM 实测的三句都在下面）
  //    - `No active Node.js version is configured. Run \`nvm install <version>\` then \`nvm use <version>\`.`
  //    - `You do not have sufficient privileges to complete this operation. Please run this command as administrator.`
  //    - `Cannot create a file when that file already exists.`
  if (/No active Node\.js version is configured|no active version/i.test(tail)) {
    return make('nvm-inactive');
  }
  if (/already exists|已存在|目标文件夹/i.test(tail)) return make('target-exists');
  if (
    /sufficient privileges|symbolic link|symlink|SeCreateSymbolicLinkPrivilege|developer mode|开发者模式/i.test(
      tail,
    )
  ) {
    return make('symlink');
  }
  if (
    /EACCES|EPERM|access is denied|access denied|拒绝访问|权限不足|permission denied/i.test(tail)
  ) {
    return make('permission');
  }
  if (
    /ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETWORK|ENOTSUP|socket hang up|网络|连接超时|连接不上|HTTP [45]\d\d/i.test(
      tail,
    )
  ) {
    return make('network');
  }
  if (/ENOSPC|no space left|disk full|空间不足|磁盘已满/i.test(tail)) return make('disk');
  if (/another installation|EBUSY|正在进行的安装/i.test(tail)) return make('busy');
  // 4. 退出码给不出结论时，把人话补上编号，界面照实显示
  if (code !== null && code !== 0) {
    return make('unknown', `安装没有成功（退出码 ${code}），这台电脑上什么都没改。`);
  }
  return make('unknown');
}

// ---------------------------------------------------------------- 安装器形态与 nvm 输出（纯函数）
