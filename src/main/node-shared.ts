/**
 * 安装引擎各模块共用的常量（超时、下载地址、输出上限、两条常驻文案）
 *
 * t52 从 `node-installer.ts` 拆出来的（那个文件现在只剩 `NodeInstaller` 类 + `NodeInstallHooks`
 * 接口 + barrel；`buildPlan` 与 `transferPhase` 必须留在同一个文件里 —— 反例脚本按这对锚点
 * 切源码，见 AGENTS §7.35）。
 */

/** 官方版本清单（Node 的 index.json：新版本在前，`lts` 是代号或 false） */
export const NODE_INDEX_PATH = 'index.json';
export const NODE_DIST_HOST = 'https://nodejs.org/dist';
/** 版本管理器（nvm-windows）的发布资产；匿名访问有频次上限，失败时不缓存、不重试、不换源 */
export const NVM_RELEASES_API = 'https://api.github.com/repos/nvm-windows/nvm/releases?per_page=20';
/** 给人看的发布页（拒绝类计划里 `url` 指向它 —— 那才是用户真有得去的地方） */
export const NVM_RELEASES_PAGE = 'https://github.com/nvm-windows/nvm/releases';
/**
 * 装完版本管理器之后，我们要从系统里重读并注入本进程的变量名。
 *
 * nvm-windows 的安装程序改的是**两个**变量（`NVM_HOME` 放各版本、`NVM_SYMLINK` 是当前版本
 * 的符号链接位置）加 PATH；只补 PATH 不够（VM 实测那条链就断在这里）。白名单是显式的：
 * 不把系统里任意变量扫进我们的进程。
 */
export const INJECTED_ENV_NAMES = ['NVM_HOME', 'NVM_SYMLINK', 'NVM_DIR'];
/** 确认区里的「自己装」出口 */
export const NODE_DOWNLOAD_PAGE = 'https://nodejs.org/en/download';
/** 一次下载的总时限（超过就按「下载超时」收尾，临时文件删掉） */
export const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
/** 安装器/等待用户的最长时限；超过就**停止等待**（不杀安装器，见 `waitForClose`） */
export const INSTALLER_TIMEOUT_MS = 30 * 60 * 1000;
/** 版本管理器自己下载 Node 的时限（它要拉几十 MB），同样只停止等待 */
export const NVM_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
/** 切换版本应当很快 */
export const NVM_USE_TIMEOUT_MS = 2 * 60 * 1000;
/** 只读探测（注册表 / 提权 / 签名）的超时 */
export const PROBE_TIMEOUT_MS = 15 * 1000;
/** `nvm list` 之类应当很快的版本管理器子命令 */
export const NVM_LIST_TIMEOUT_MS = 60 * 1000;
/** 每条版本管理器命令写进日志的原文上限（stdout / stderr 各自截尾；空的那路写「（空）」） */
export const STEP_EVIDENCE_CHARS = 1200;
/** 一次性提权（UAC 询问要等用户点）的时限 */
export const ELEVATED_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Windows「开发者模式」的注册表值：开着时普通用户也能创建符号链接
 * （`nvm use` 在 Windows 上就是建符号链接，普通权限没开这个就会失败 —— VM 实测那条路）。
 */
export const DEVELOPER_MODE_KEY =
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock\\AllowDevelopmentWithoutDevLicense';
/** 输出尾巴只留这么多字符：归纳失败原因与贴进输出区都用它 */
export const OUTPUT_TAIL_CHARS = 64 * 1024;
/** 临时目录里的残留超过这个时长就可以清掉（下载中断 / 应用被杀之后留下的） */
export const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
/** 忙位上的那句话：与编排、界面 `title` 文案同一句（冻结文档 §4.3） */
export const BUSY_MESSAGE = '正在执行上一步的操作，完成后按钮会自动恢复';
/** 「不再等待」的结论句（交互规格 §7.4 原样） */
export const DETACHED_MESSAGE =
  '我们不等了：安装可能还在后台进行，请按它自己的提示把它做完，做完点「重新检测」。';

// ---------------------------------------------------------------- 纯函数（冻结清单，离线可测）
