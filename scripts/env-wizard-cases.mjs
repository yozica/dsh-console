/**
 * 环境向导的**独立反例用例**（验证侧资产，不属于产品代码）。覆盖三层：
 *   - 安装引擎（`src/main/node-installer.ts`）：版本清单 / 校验清单 / PATH / 提权探测 / 资产挑选 /
 *     摘要 / 发布说明签名 / 失败分类（A~F 段），以及"安装结果只能由复检事实给出"（J 段）；
 *   - 门禁判定（`src/main/env-doctor.ts` 的 `judgeWizard`）：三步状态 / 门禁三态 / currentStepId /
 *     跳过规则 / 快速探测 / 畸形输入（I 段）；
 *   - 门禁放行与**逃生口**（`src/renderer/state/env-wizard.ts` 的**真状态机**）：K 段把渲染层那份
 *     相位机编成 CJS、只把 `window.dshConsole` 换成桩，所以在沙箱里也能证明
 *     「安装引擎坏了 / 网络断了也放得进去」这条硬要求。
 *   - 另有 **O 段**（t4 独立验证加的）：`EnvNodeOwner` 的四类输入（nvm v2 shim / v1 link / 系统直装 /
 *     未知，带模型与 MSI 安装位驱动）、`decideNodePlan` 的方法跟随归属与档位跟随当前档、
 *     换档只在显式选档时发生（VM-14 / VM-15 / 需求 §12#29–34）。真调 `plan()` 的那一组驱动
 *     需要夹具目录与网络注入，放在 `.verify/t4-plan-drive.mjs`（门禁不跑它，证据见
 *     `docs/env-wizard-verification.md` 的 t4 一节）。
 *
 * 被测模块编译产物由脚本自己产出（`.verify/` 下，不进 `src/` 与 `dist/`）。
 * 设计依据：`docs/env-wizard.md` 第 7 / 9 节、`docs/env-wizard-freeze.md` §2.1 / §2.2 / §3.x / §4.2 与 §3.8。
 *
 * ## 三条原则
 *
 * 1. **默认完全离线**：`scripts/selftest-sandbox.mjs` 会自动收录 `scripts/*-cases.mjs`，
 *    而门禁必须在没有网络的机器上照跑 —— 所以夹具全是**内嵌原文**，一次网络请求都没有。
 *    `--online` 是显式开关：只重新抓一遍那些外部事实、确认内嵌夹具没过期，**不参与门禁判定**。
 * 2. **夹具是我这一轮（verifier）自己抓的原文**，不是从 `test/selftest.ts` 或实现者贴的表里抄的
 *    （抄一遍只能证明两份文件写的一样，证明不了外部事实）。抓取时间 **2026-09-19**：
 *    - `https://nodejs.org/dist/v24.21.0/SHASUMS256.txt` → HTTP 200、3171 字节、34 行（全文内嵌）
 *    - `https://nodejs.org/dist/index.json` → HTTP 200、866 条；`v26.9.0` 是 current、
 *      `v24.21.0` 是最新 LTS `Krypton`；含 `win-x64-msi` 的 631 条、含 `win-arm64-msi` 的 **0** 条
 *    - HEAD 两个 msi → 都是 200：x64 33230848 字节、arm64 29671424 字节
 *      （这正是"存在性以同目录校验清单为权威、不读 index.json 的 files"那个裁定的实证）
 *    - `https://api.github.com/repos/nvm-windows/nvm/releases` → 29 个发布；v2.0.0 是稳定版、
 *      4 个资产、digest 齐全；1.2.x 那条线是 `nvm-setup.exe`（**没有 digest**）、还多一个
 *      `nvm-update.exe`（老名字里含 setup 的只有它俩，所以判据必须咬住 `setup.exe` 结尾）
 *    - 本机（Windows 11，非提权）实测：`whoami /groups` 退出码 0、含 `S-1-16-8192`；
 *      两段注册表 PATH 都是 `REG_EXPAND_SZ`，原文里写着 `%NVM_HOME%;%NVM_SYMLINK%`，
 *      环境里 `NVM_HOME=D:\Nvm\nvm`、`NVM_SYMLINK=D:\Node\nodejs`
 * 3. **本机 whoami 只内嵌判定真正读的那一行**（Mandatory Label）：完整输出带本机账户的组清单，
 *    没必要把一个真人的机器信息提交进仓库。**提权那两档（High / System）本机复现不了**，
 *    是按 SID 语义构造的字符串 —— 下面单独标了"构造"，不当成实测原文。
 *
 * 真机上才能验的部分（真实下载、UAC 三态、MSI / 无参数 GUI 安装器的可见性、退出后安装器继续跑、
 * 系统代理）**这里不断言** —— 本脚本只覆盖纯函数判定与源码静态形状，真机结论写在
 * `docs/env-wizard-verification.md` 的"未能验证"清单里。
 *
 * 用法：
 *   node scripts/env-wizard-cases.mjs            # 离线夹具（门禁自动收录，缺编译产物时自己编一份到 .verify/）
 *   node scripts/env-wizard-cases.mjs --online    # 额外重抓外部事实并与内嵌夹具比对（需要网络；门禁不跑）
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const TSC = path.join('node_modules', 'typescript', 'bin', 'tsc');
/** 私有编译目录：`.verify/` 被 git / eslint / .prettierignore 一起忽略，不往 src/ 或 dist/ 丢产物 */
const PRIVATE_BUILD = path.join(repoRoot, '.verify', 'env-wizard-build');
const ONLINE = process.argv.includes('--online');

/** `src/**` 与两份 tsconfig 里最新的改动时刻：判断私有编译产物是否过期 */
function newestSourceMs() {
  let newest = 0;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.ts')) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  visit(path.join(repoRoot, 'src'));
  for (const name of ['tsconfig.main.json', 'tsconfig.base.json']) {
    const full = path.join(repoRoot, name);
    if (fs.existsSync(full)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * `src/main/node-installer.ts` 不在 `tsconfig.node.json` 的图里（自检只是把它的**源码文本**读来做静态断言），
 * 所以这里用 `tsconfig.main.json` 单独编一份到 `.verify/`：rootDir=src 保持不变，
 * 产物路径是 `<PRIVATE_BUILD>/main/node-installer.js`。
 */
function resolveBuildDir() {
  const built = path.join(PRIVATE_BUILD, 'main', 'node-installer.js');
  if (fs.existsSync(built) && fs.statSync(built).mtimeMs >= newestSourceMs()) return PRIVATE_BUILD;
  console.log(
    '（没有可用的编译产物 → 现场编译 tsc -p tsconfig.main.json 到 .verify/env-wizard-build）',
  );
  const result = spawnSync(
    process.execPath,
    [TSC, '-p', 'tsconfig.main.json', '--noEmit', 'false', '--outDir', PRIVATE_BUILD],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`编译失败（退出码 ${result.status ?? 1}），没法验证纯函数`);
    process.exit(2);
  }
  return PRIVATE_BUILD;
}

/**
 * 默认用脚本自己编出来的那份产物；`ENV_WIZARD_BUILD_DIR` 是给**变异实验**用的后门
 * （把产物复制一份、改回旧写法，再指过来跑 —— 证明断言真的会红，见
 * `.verify/t20-mutation-experiment.mjs`）。正常跑不设这个变量。
 */
const buildDir = process.env.ENV_WIZARD_BUILD_DIR
  ? path.resolve(repoRoot, process.env.ENV_WIZARD_BUILD_DIR)
  : resolveBuildDir();

let installer;
try {
  installer = require(path.join(buildDir, 'main', 'node-installer.js'));
} catch (error) {
  console.error('加载编译产物失败：', error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const {
  parseNodeReleaseIndex,
  pickNodeRelease,
  nodeInstallerUrl,
  nodeInstallerFileName,
  parseShasums,
  compareNodeVersions,
  detectNodeOwner,
  mergePathFromRegistry,
  normalizeNodeSource,
  isElevatedProbeOutput,
  pickNvmSetupAsset,
  assetSha256,
  parseReleaseSigning,
  expandEnvReferences,
  classifyInstallFailure,
} = installer;

/**
 * 导出缺失要变成一句人话 + exit 2，而不是几百行之后的一个 `TypeError: xxx is not a function`
 * （env-doctor-cases.mjs 真这么崩过一次）。被重构改名时这里会先红。
 */
const missingExports = [
  'parseNodeReleaseIndex',
  'pickNodeRelease',
  'nodeInstallerUrl',
  'nodeInstallerFileName',
  'parseShasums',
  'compareNodeVersions',
  'detectNodeOwner',
  'mergePathFromRegistry',
  'normalizeNodeSource',
  'isElevatedProbeOutput',
  'pickNvmSetupAsset',
  'assetSha256',
  'parseReleaseSigning',
  'expandEnvReferences',
  'classifyInstallFailure',
].filter((name) => typeof installer[name] !== 'function');
if (missingExports.length > 0) {
  console.error(
    `node-installer 缺这些导出：${missingExports.join('、')} —— 被改名或挪走了，验证脚本要跟着同步`,
  );
  process.exit(2);
}

const results = [];
const observations = [];
const check = (name, pass, actual, expected) =>
  results.push({ name, pass: Boolean(pass), actual: String(actual), expected: String(expected) });
const observe = (text) => observations.push(text);
const show = (value) => JSON.stringify(value === undefined ? null : value);
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), show(actual), show(expected));

// ================================================================ 内嵌夹具（原文）
// 下面前三块的每一行都来自我这一轮的抓取；`String.raw` 用来原样保留 Windows 的反斜杠
// （普通字符串里 `\N` 这种未知转义会被吃掉，`\n` 更会被当成换行）。

/** v24.21.0 的官方校验清单全文（34 行，HTTP 200 / 3171 字节） */
const SHASUMS_V24_21_0 = String.raw`aec7b2464afb99f078c19cb06d201d543bd3b311cba071282bce1b17c97e58bb  node-v24.21.0-aix-ppc64.tar.gz
22ca85110f26015696a3fa9216bc372ae65203d170622eaf7d211e2dd5bb49e3  node-v24.21.0-arm64.msi
bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057  node-v24.21.0-darwin-arm64.tar.gz
6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe  node-v24.21.0-darwin-arm64.tar.xz
1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097  node-v24.21.0-darwin-x64.tar.gz
0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299  node-v24.21.0-darwin-x64.tar.xz
57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2  node-v24.21.0-headers.tar.gz
7497abc2fac1d332fae580046b6b39d0de283dfaf267207a32b59753739c1517  node-v24.21.0-headers.tar.xz
724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5  node-v24.21.0-linux-arm64.tar.gz
6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2  node-v24.21.0-linux-arm64.tar.xz
51c5d53066ee92920b61783b03b06ecb99f3661160f7b15ca77e8474115a67bc  node-v24.21.0-linux-ppc64le.tar.gz
1936fd64623a2f98d1fb31b456686d10c30e92639899cfefdefa8835d22adccd  node-v24.21.0-linux-ppc64le.tar.xz
5f2fa37422e0c75de35c1686fe51d78324f2c2a8fe2cc239a41d9c000a29d938  node-v24.21.0-linux-s390x.tar.gz
2ef7e2ecbf7a6c2f3d08d106f6b2f279419c6dac89fe91b8cad193af7890082c  node-v24.21.0-linux-s390x.tar.xz
3d63405fc65a0d2d2976c1f0bc2fd27bb0bd07212469e705aac3f03ae5ab4c9c  node-v24.21.0-linux-x64-musl.tar.gz
34ab095af8efe9018f21489d3dc19871fb5edd4f130a71469b69c05fd4e32a5e  node-v24.21.0-linux-x64-musl.tar.xz
6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff  node-v24.21.0-linux-x64.tar.gz
fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6  node-v24.21.0-linux-x64.tar.xz
848cc8d138b712b5ae0f38de08fde62feb404226a63dde07d0ea5ccddbbd9dd7  node-v24.21.0-win-arm64.7z
8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921  node-v24.21.0-win-arm64.zip
4e5f86609712acf841f3a5e2d9d4854b4c149f6ead024fc38381b6d7b272c636  node-v24.21.0-win-x64.7z
158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541  node-v24.21.0-win-x64.zip
bb0eaee134f9357f22aea915ee793343e627aefc1e66488164bac6915bce2cac  node-v24.21.0-x64.msi
9831a74b04c270a429bd5a240e37712c4fe229b02b032e18ff2e0702c17c20fd  node-v24.21.0.pkg
622424efb5dc0c26c93fbb619ff10737ee289c605b837c88778e186925d82777  node-v24.21.0.tar.gz
a6f54defb6fd7c84f41dba13d61e78e9b4e0961712cf61f29715c05f5ced94fc  node-v24.21.0.tar.xz
dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7  win-arm64/node.exe
2c0c3215d59c09d7c136da4949696dae121a299e9bdfc64cd9130a58610af63d  win-arm64/node.lib
32ce76dd79deddcf6e08f612da714fc3a28fa39c0e4fe12283e019a90eb76483  win-arm64/node_pdb.7z
d565f0a7a8eda1662886475471e454dbe2c2a53c9d1a8562fc986bd11c24fd72  win-arm64/node_pdb.zip
ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32  win-x64/node.exe
a0a84aa03917b578d286010b7521837e9ff1136ffb2e4a406c14316c33fd06f7  win-x64/node.lib
0df783d02aee58bbe9dcfc157ccc5cc37987d24c4f35889587b39500b12030a9  win-x64/node_pdb.7z
122f2af58bfb25816f12e49179217c3ff5bf96c1e083f3ccb0969a5b4794ff85  win-x64/node_pdb.zip`;

/**
 * `index.json` 头两条的**真实原文**（只内嵌我真正抓到的这两条：v26.9.0 与 v24.21.0，
 * 中间那些版本没抓全就不编）。`lts: false` 是非 LTS，`lts: "Krypton"` 是最新 LTS —— 这两条
 * 恰好把"current 取第一条 / lts 取第一条 lts!==false"钉住。
 */
const REAL_INDEX_TEXT = `[{"version":"v26.9.0","date":"2026-09-16","files":["aix-ppc64","headers","linux-arm64","linux-ppc64le","linux-s390x","linux-x64","linux-x64-musl","osx-arm64-tar","osx-x64-pkg","osx-x64-tar","src","win-arm64-7z","win-arm64-zip","win-x64-7z","win-x64-exe","win-x64-msi","win-x64-zip"],"npm":"11.19.1","v8":"14.6.202.34","uv":"1.52.1","zlib":"1.3.2.1-motley","openssl":"3.5.8","modules":"147","lts":false,"security":false},{"version":"v24.21.0","date":"2026-09-07","files":["aix-ppc64","headers","linux-arm64","linux-ppc64le","linux-s390x","linux-x64","linux-x64-musl","osx-arm64-tar","osx-x64-pkg","osx-x64-tar","src","win-arm64-7z","win-arm64-zip","win-x64-7z","win-x64-exe","win-x64-msi","win-x64-zip"],"npm":"11.19.0","v8":"13.6.233.17","uv":"1.52.1","zlib":"1.3.2.1-motley","openssl":"3.5.8","modules":"137","lts":"Krypton","security":false}]`;

/** 本机注册表两段 PATH 的**原始值**（REG_EXPAND_SZ，未展开）与环境里那几个变量 */
const REG_MACHINE_RAW = String.raw`D:\Python\Scripts\;D:\Python\;%SystemRoot%\system32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SYSTEMROOT%\System32\WindowsPowerShell\v1.0\;%SYSTEMROOT%\System32\OpenSSH\;C:\Program Files (x86)\NVIDIA Corporation\PhysX\Common;%NVM_HOME%;%NVM_SYMLINK%;D:\Git\Git\cmd;C:\Program Files\NVIDIA Corporation\NVIDIA App\NvDLISR`;
const REG_USER_RAW = String.raw`C:\Users\yozica\AppData\Local\Programs\Python\Python312\Scripts\;C:\Users\yozica\AppData\Local\Programs\Python\Python312\;D:\Python\Scripts\;D:\Python\;D:\Cursor\cursor\resources\app\bin;%NVM_HOME%;%NVM_SYMLINK%;D:\VSCode\Microsoft VS Code\bin;`;
/** 变量表只给 `SystemRoot`（一份），因为注册表里 `%SystemRoot%` 与 `%SYSTEMROOT%` 两种写法都有 */
const REG_VARS = {
  SystemRoot: 'C:\\Windows',
  NVM_HOME: 'D:\\Nvm\\nvm',
  NVM_SYMLINK: 'D:\\Node\\nodejs',
};
const REG_MACHINE_EXPANDED = String.raw`D:\Python\Scripts\;D:\Python\;C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0\;C:\Windows\System32\OpenSSH\;C:\Program Files (x86)\NVIDIA Corporation\PhysX\Common;D:\Nvm\nvm;D:\Node\nodejs;D:\Git\Git\cmd;C:\Program Files\NVIDIA Corporation\NVIDIA App\NvDLISR`;
const REG_USER_EXPANDED = String.raw`C:\Users\yozica\AppData\Local\Programs\Python\Python312\Scripts\;C:\Users\yozica\AppData\Local\Programs\Python\Python312\;D:\Python\Scripts\;D:\Python\;D:\Cursor\cursor\resources\app\bin;D:\Nvm\nvm;D:\Node\nodejs;D:\VSCode\Microsoft VS Code\bin;`;
/** 机器级在前 + 去重（不分大小写）+ 丢掉空段（用户级末尾那个 `;`）+ 保留原文里的 `\` 结尾 */
const REG_MERGED = String.raw`D:\Python\Scripts\;D:\Python\;C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0\;C:\Windows\System32\OpenSSH\;C:\Program Files (x86)\NVIDIA Corporation\PhysX\Common;D:\Nvm\nvm;D:\Node\nodejs;D:\Git\Git\cmd;C:\Program Files\NVIDIA Corporation\NVIDIA App\NvDLISR;C:\Users\yozica\AppData\Local\Programs\Python\Python312\Scripts\;C:\Users\yozica\AppData\Local\Programs\Python\Python312\;D:\Cursor\cursor\resources\app\bin;D:\VSCode\Microsoft VS Code\bin`;

/** 本机 `whoami /groups` 实测的最后一行（判定真正读的就是它） */
const WHOAMI_NON_ELEVATED = 'Mandatory Label\\Medium Mandatory Level Label            S-1-16-8192';
/** **构造**（本机复现不了提权）：High / System 两档的完整性级别 SID */
const WHOAMI_HIGH = 'Mandatory Label\\High Mandatory Level Label            S-1-16-12288';
const WHOAMI_SYSTEM = 'Mandatory Label\\System Mandatory Level Label          S-1-16-16384';

/**
 * nvm-windows v2.0.0（稳定版）的四个资产 —— 名字、字节数、digest 都是抓到的原文；
 * `browser_download_url` 只是占位（这个纯函数不看它）。
 */
const NVM_V2_ASSETS = [
  {
    name: 'nvm-2.0.0-amd64-setup.exe',
    browser_download_url: 'https://github.com/nvm-windows/nvm/releases/download/v2.0.0/x1',
    digest: 'sha256:afaee67d3d7bc8ccad0b1b06f63b0f2d6b008bc7e55d5205043f095b4906ac11',
  },
  {
    name: 'nvm-2.0.0-amd64-sync.exe',
    browser_download_url: 'https://github.com/nvm-windows/nvm/releases/download/v2.0.0/x2',
    digest: 'sha256:79793ea532229a404fcf3b00d7f2efab846d6f68ac4fb26b8e5a37c21faab20b',
  },
  {
    name: 'nvm-2.0.0-arm64-setup.exe',
    browser_download_url: 'https://github.com/nvm-windows/nvm/releases/download/v2.0.0/x3',
    digest: 'sha256:62868ba9d1fd0e9b60ad7f69d05e8e85b49b5700ec29cf6e9adb9a5c83aebdb7',
  },
  {
    name: 'nvm-2.0.0-arm64-sync.exe',
    browser_download_url: 'https://github.com/nvm-windows/nvm/releases/download/v2.0.0/x4',
    digest: 'sha256:ef67fe9ebb6767bda70d8f1dc47f3113e148e0b9dea8c65f3cedaca8686daf98',
  },
];
/** 1.2.2（稳定版、老线）的五个资产：没有 digest，且 `setup.exe` 没有架构标记 */
const NVM_V1_ASSETS = [
  'nvm-noinstall.zip',
  'nvm-noinstall.zip.checksum.txt',
  'nvm-setup.exe',
  'nvm-setup.zip',
  'nvm-setup.zip.checksum.txt',
].map((name) => ({
  name,
  browser_download_url: `https://github.com/nvm-windows/nvm/releases/download/1.2.2/${name}`,
}));
/** 1.1.10 那条线里多出来的 `nvm-update.exe`：只咬 `setup.exe` 结尾才排得掉 */
const NVM_UPDATE_EXE = {
  name: 'nvm-update.exe',
  browser_download_url: 'https://example.invalid/nvm-update.exe',
};
/** 发布说明正文的真实首行 */
const NVM_BODY_V2 = 'Unsigned community build from `cli/src/manifest.json` version `2.0.0`.';
const NVM_BODY_HOTFIX2 =
  'Authenticode-signed community build from `cli/src/manifest.json` version `2.0.1-hotfix.2`.';

// ================================================================ A. 版本清单 / 档位 / 地址
eq('A1 非 JSON → 空数组（不抛）', parseNodeReleaseIndex('not json'), []);
eq('A2 不是数组的 JSON → 空数组', parseNodeReleaseIndex('{"a":1}'), []);
eq('A3 空串 → 空数组', parseNodeReleaseIndex(''), []);
eq(
  'A4 条目：没有 version 的丢掉、lts 非字符串降成 false、files 非数组降成空数组',
  parseNodeReleaseIndex('[1,"x",null,{"lts":"x"},{"version":"v1.0.0","lts":0}]'),
  [{ version: 'v1.0.0', lts: false, files: [] }],
);
const realList = parseNodeReleaseIndex(REAL_INDEX_TEXT);
eq(
  'A5 真实 index.json 头两条：版本与 LTS 档',
  realList.map((item) => `${item.version}/${item.lts}`),
  ['v26.9.0/false', 'v24.21.0/Krypton'],
);
eq('A6 条目字段恰好四个（version / lts / files / npm）', Object.keys(realList[0]).sort(), [
  'files',
  'lts',
  'npm',
  'version',
]);
eq(
  'A7 真实 files 数组原样保留（v26.9.0 有 17 项；有 win-arm64-zip、没有 win-arm64-msi）',
  [
    realList[0].files.length,
    realList[0].files.includes('win-arm64-zip'),
    realList[0].files.includes('win-arm64-msi'),
  ],
  [17, true, false],
);
eq(
  'A8 pickNodeRelease(list,"lts") = 最新稳定版',
  pickNodeRelease(realList, 'lts').version,
  'v24.21.0',
);
eq(
  'A9 pickNodeRelease(list,"current") = 清单第一条',
  pickNodeRelease(realList, 'current').version,
  'v26.9.0',
);
eq('A10 清单里没有 LTS 档时 → null', pickNodeRelease([realList[0]], 'lts'), null);
eq('A11 空清单 → null', [pickNodeRelease([], 'lts'), pickNodeRelease([], 'current')], [null, null]);
const v24 = realList[1];
eq(
  'A12 x64 下载地址按架构拼',
  nodeInstallerUrl(v24, 'x64'),
  'https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi',
);
eq(
  'A13 arm64 同样拼得出来（存在性由校验清单判，不由这里判）',
  nodeInstallerUrl(v24, 'arm64'),
  'https://nodejs.org/dist/v24.21.0/node-v24.21.0-arm64.msi',
);
eq(
  'A14 架构大小写不敏感',
  nodeInstallerUrl(v24, 'X64'),
  'https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi',
);
eq(
  'A15 认不出的架构 → null',
  [nodeInstallerUrl(v24, 'mips'), nodeInstallerUrl(v24, '')],
  [null, null],
);
eq(
  'A16 版本号不是 vX.Y.Z → null（`v24.21` 与 `24.21.0` 都不认）',
  [
    nodeInstallerUrl({ version: 'v24.21', lts: false, files: [] }, 'x64'),
    nodeInstallerUrl({ version: '24.21.0', lts: false, files: [] }, 'x64'),
  ],
  [null, null],
);
eq('A17 安装包文件名', nodeInstallerFileName('v24.21.0', 'x64'), 'node-v24.21.0-x64.msi');

// ================================================================ B. 校验清单 / 版本比较
eq(
  'B1 真实清单里取 x64 的 sha256',
  parseShasums(SHASUMS_V24_21_0, 'node-v24.21.0-x64.msi'),
  'bb0eaee134f9357f22aea915ee793343e627aefc1e66488164bac6915bce2cac',
);
eq(
  'B2 真实清单里取 arm64 的 sha256',
  parseShasums(SHASUMS_V24_21_0, 'node-v24.21.0-arm64.msi'),
  '22ca85110f26015696a3fa9216bc372ae65203d170622eaf7d211e2dd5bb49e3',
);
eq(
  'B3 清单里没有这个文件名 → null',
  parseShasums(SHASUMS_V24_21_0, 'node-v24.21.0-arm64.exe'),
  null,
);
eq(
  'B4 文件名为空 → null',
  [parseShasums(SHASUMS_V24_21_0, ''), parseShasums('', 'node-v24.21.0-x64.msi')],
  [null, null],
);
eq(
  'B5 目标名两边的空白去掉再查',
  parseShasums(SHASUMS_V24_21_0, '  node-v24.21.0-x64.msi  '),
  'bb0eaee134f9357f22aea915ee793343e627aefc1e66488164bac6915bce2cac',
);
eq(
  'B6 带路径的条目也认（清单里有 win-x64/node.exe / win-arm64/node.exe 这类行）',
  [
    parseShasums(SHASUMS_V24_21_0, 'win-x64/node.exe'),
    parseShasums(SHASUMS_V24_21_0, 'win-arm64/node.exe'),
  ],
  [
    'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32',
    'dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7',
  ],
);
eq(
  'B7 大小写不同的文件名不算命中（清单是精确匹配）',
  parseShasums(SHASUMS_V24_21_0, 'NODE-V24.21.0-X64.MSI'),
  null,
);
eq(
  'B8 版本比较：大 / 小 / 相等 / 认不出',
  [
    compareNodeVersions('v24.21.0', 'v24.19.0'),
    compareNodeVersions('v9.0.0', 'v10.0.0'),
    compareNodeVersions('v24.21', 'v24.21.0'),
    compareNodeVersions('garbage', 'v1.0.0'),
    compareNodeVersions('24.19.0', 'v24.19.0'),
  ],
  [1, -1, 0, -1, 0],
);

// ================================================================ C. 归属判定 / PATH 合并 / 来源
const NVM_ENV = { NVM_HOME: 'D:\\Nvm\\nvm', NVM_SYMLINK: 'D:\\Node\\nodejs' };
/**
 * 读「这份 Node 归谁管」的局部助手：把冻结 §4.2 的 t29 形状（对象入参）收在一处，
 * 断言那边仍然逐条精确比对 `owner`（**不是**"不抛就算过"）。
 *
 * `model` / `msiInstallPath` 都给 `null`：这几条反例考的是**路径与环境变量**那两条判据
 * （`NVM_*` 变量 → 路径里独立的 `nvm` / `nvm4w` 段 → 官方默认安装位），
 * 版本管理器模型与 MSI 写下的安装目录在 N4a~N4d 另有用例，不在这里重复。
 */
const nodeOwner = (nodePath, env) =>
  detectNodeOwner({ nodePath, env, model: null, msiInstallPath: null }).owner;
eq(
  'C1 版本管理器目录下（NVM_HOME）→ nvm',
  nodeOwner('D:\\Nvm\\nvm\\v24.19.0\\node.exe', NVM_ENV),
  'nvm',
);
eq('C2 软链目录下（NVM_SYMLINK）→ nvm', nodeOwner('D:\\Node\\nodejs\\node.exe', NVM_ENV), 'nvm');
eq(
  'C3 没有环境变量、但路径里有 nvm 段 → nvm',
  nodeOwner('D:\\Nvm\\nvm\\v24.19.0\\node.exe', {}),
  'nvm',
);
eq(
  'C4 路径里的 nvm 段也认大小写与正斜杠（`/nvm/`）',
  [nodeOwner('D:\\NVMTEST\\nvm\\node.exe', {}), nodeOwner('C:/Tools/Nvm/v20.11.0/node.exe', {})],
  ['nvm', 'nvm'],
);
eq(
  'C5 官方安装位置 / 没有版本管理器特征 → system',
  [
    nodeOwner('C:\\Program Files\\nodejs\\node.exe', {}),
    nodeOwner('C:\\Program Files\\nodejs\\node.exe', NVM_ENV),
  ],
  ['system', 'system'],
);
eq(
  'C6 别的版本管理器 → unknown（不当成 system，也不当成 nvm）',
  [
    nodeOwner('~/.volta/bin/node.exe', {}),
    nodeOwner('C:\\Users\\x\\.volta\\bin\\node.exe', {}),
    nodeOwner('C:\\Users\\x\\AppData\\Local\\fnm\\node.exe', {}),
  ],
  ['unknown', 'unknown', 'unknown'],
);
eq(
  'C7 路径为空 / null → unknown',
  [nodeOwner(null, {}), nodeOwner('   ', {})],
  ['unknown', 'unknown'],
);
eq(
  'C8 环境变量键名大小写不敏感（Windows 上 Nvm_Home 也见过）',
  nodeOwner('D:\\Nvm\\nvm\\v22.0.0\\node.exe', { Nvm_Home: 'D:\\Nvm\\nvm' }),
  'nvm',
);
eq(
  'C9 本机真实 PATH 原文展开：%SystemRoot% 与 %SYSTEMROOT% 两种写法、%NVM_HOME% / %NVM_SYMLINK% 都展开',
  expandEnvReferences(REG_MACHINE_RAW, REG_VARS),
  REG_MACHINE_EXPANDED,
);
eq(
  'C10 用户级那段（末尾一个空的 `;` 段）展开后只影响空段',
  expandEnvReferences(REG_USER_RAW, REG_VARS),
  REG_USER_EXPANDED,
);
eq(
  'C11 查不到的引用原样留着（不悄悄删掉用户自己写的目录）',
  expandEnvReferences('%NOPE%;C:\\x;%NVM_HOME%', REG_VARS),
  '%NOPE%;C:\\x;D:\\Nvm\\nvm',
);
eq(
  'C12 两段都为空 → 空串',
  [mergePathFromRegistry(null, null), mergePathFromRegistry('', '')],
  ['', ''],
);
eq(
  'C13 本机两段真实 PATH 合并：机器级在前、用户级在后、丢空段、去重不分大小写、保留原文的 `\\` 结尾',
  mergePathFromRegistry(REG_MACHINE_EXPANDED, REG_USER_EXPANDED),
  REG_MERGED,
);
eq(
  'C14 去重只按大小写折叠，不归一化分隔符与结尾反斜杠',
  mergePathFromRegistry('C:\\A;c:\\a;C:\\A\\', 'C:\\B;'),
  'C:\\A;C:\\A\\;C:\\B',
);
eq('C15 段内空白会被去掉', mergePathFromRegistry('  C:\\A  ;  C:\\B ', null), 'C:\\A;C:\\B');
eq(
  'C16 下载源：去掉末尾斜杠；空 / 写错 → null（当没填，走官方直连）',
  [
    normalizeNodeSource('https://npmmirror.com/mirrors/node/'),
    normalizeNodeSource('http://127.0.0.1:8080/'),
    normalizeNodeSource(''),
    normalizeNodeSource('   '),
    normalizeNodeSource('ftp://mirror/node'),
    normalizeNodeSource('javascript:alert(1)'),
    normalizeNodeSource('https://npmmirror.com/mirrors/node///'),
  ],
  [
    'https://npmmirror.com/mirrors/node',
    'http://127.0.0.1:8080',
    null,
    null,
    null,
    null,
    'https://npmmirror.com/mirrors/node',
  ],
);

// ================================================================ D. 提权探测 / 版本管理器安装包 / 摘要
eq(
  'D1 本机非提权原文（S-1-16-8192）+ 退出码 0 → 不是提权',
  isElevatedProbeOutput(WHOAMI_NON_ELEVATED, 0),
  false,
);
eq('D2 High（S-1-16-12288）+ 0 → 提权', isElevatedProbeOutput(WHOAMI_HIGH, 0), true);
eq('D3 System（S-1-16-16384）+ 0 → 提权', isElevatedProbeOutput(WHOAMI_SYSTEM, 0), true);
eq(
  'D4 同样的输出但探测没跑成（退出码非 0）→ 不是提权（没有正向证据就不拦人）',
  [isElevatedProbeOutput(WHOAMI_HIGH, 5), isElevatedProbeOutput(WHOAMI_HIGH, null)],
  [false, false],
);
eq(
  'D5 读不出来 → 不是提权',
  [isElevatedProbeOutput('', 0), isElevatedProbeOutput('???', 0)],
  [false, false],
);
eq(
  'D6 v2 真实资产：x64 → amd64 的 setup、arm64 → arm64 的 setup（sync 版与 zip 都不算）',
  [pickNvmSetupAsset(NVM_V2_ASSETS, 'x64').name, pickNvmSetupAsset(NVM_V2_ASSETS, 'arm64').name],
  ['nvm-2.0.0-amd64-setup.exe', 'nvm-2.0.0-arm64-setup.exe'],
);
eq(
  'D7 预发布 / hotfix / rc 的资产名跳过（发布级的 prerelease 由调用方先滤，这是第二道闸）',
  [
    pickNvmSetupAsset(
      [{ name: 'nvm-2.0.1-hotfix.2-amd64-setup.exe', browser_download_url: 'u' }],
      'x64',
    ),
    pickNvmSetupAsset(
      [{ name: 'nvm-2.0.0-rc.3-amd64-setup.exe', browser_download_url: 'u' }],
      'x64',
    ),
    pickNvmSetupAsset(
      [{ name: 'nvm-2.0.0-beta.1-amd64-setup.exe', browser_download_url: 'u' }],
      'x64',
    ),
  ],
  [null, null, null],
);
eq(
  'D8 老式名字（1.2.x 的 nvm-setup.exe，没有架构标记）：x64 可用、arm64 → null',
  [pickNvmSetupAsset(NVM_V1_ASSETS, 'x64').name, pickNvmSetupAsset(NVM_V1_ASSETS, 'arm64')],
  ['nvm-setup.exe', null],
);
eq(
  'D9 只有 zip / noinstall / update.exe → null（判据咬住 `nvm-…setup.exe` 结尾）',
  [
    pickNvmSetupAsset(
      NVM_V1_ASSETS.filter((asset) => asset.name !== 'nvm-setup.exe'),
      'x64',
    ),
    pickNvmSetupAsset([NVM_UPDATE_EXE], 'x64'),
  ],
  [null, null],
);
eq(
  'D10 同一次给两版 → 版本高的胜（合成夹具：真实 1.2.x 没有带架构标记的名字）',
  pickNvmSetupAsset(
    [
      { name: 'nvm-1.2.5-amd64-setup.exe', browser_download_url: 'u' },
      { name: 'nvm-2.0.0-amd64-setup.exe', browser_download_url: 'u' },
      { name: 'nvm-10.0.0-amd64-setup.exe', browser_download_url: 'u' },
    ],
    'x64',
  ).name,
  'nvm-10.0.0-amd64-setup.exe',
);
eq(
  'D11 架构标记对不上就跳过（arm64 的资产不能给 x64、x86 的也不能）',
  [
    pickNvmSetupAsset([{ name: 'nvm-2.0.0-arm64-setup.exe', browser_download_url: 'u' }], 'x64'),
    pickNvmSetupAsset([{ name: 'nvm-2.0.0-x86-setup.exe', browser_download_url: 'u' }], 'x64'),
  ],
  [null, null],
);
eq(
  'D12 非数组 / 空表 → null',
  [pickNvmSetupAsset(null, 'x64'), pickNvmSetupAsset([], 'x64')],
  [null, null],
);
eq(
  'D13 真实 digest → 小写值；大写也认；没有 digest / 长度不对 / 别的算法 → null',
  [
    assetSha256(NVM_V2_ASSETS[0]),
    assetSha256({
      name: 'x',
      browser_download_url: 'u',
      digest: 'SHA256:AFAEE67D3D7BC8CCAD0B1B06F63B0F2D6B008BC7E55D5205043F095B4906AC11',
    }),
    assetSha256(NVM_V1_ASSETS[2]),
    assetSha256({ name: 'x', browser_download_url: 'u', digest: 'sha256:abc' }),
    assetSha256({
      name: 'x',
      browser_download_url: 'u',
      digest: 'sha512:afaee67d3d7bc8ccad0b1b06f63b0f2d6b008bc7e55d5205043f095b4906ac11',
    }),
  ],
  [
    'afaee67d3d7bc8ccad0b1b06f63b0f2d6b008bc7e55d5205043f095b4906ac11',
    'afaee67d3d7bc8ccad0b1b06f63b0f2d6b008bc7e55d5205043f095b4906ac11',
    null,
    null,
    null,
  ],
);
eq(
  'D14 发布说明的自述：v2.0.0 → unsigned；hotfix.2 → signed；两个都在 → Unsigned 优先（"Unsigned" 里也含 "signed"）',
  [
    parseReleaseSigning(NVM_BODY_V2),
    parseReleaseSigning(NVM_BODY_HOTFIX2),
    parseReleaseSigning(`${NVM_BODY_HOTFIX2}\n${NVM_BODY_V2}`),
    parseReleaseSigning(`${NVM_BODY_V2}\n${NVM_BODY_HOTFIX2}`),
  ],
  ['unsigned', 'signed', 'unsigned', 'unsigned'],
);
eq(
  'D15 老线（1.2.x 没有这一行）与空正文 → unknown',
  [
    parseReleaseSigning('Bug fixes and maintenance.'),
    parseReleaseSigning(''),
    parseReleaseSigning('# 1.2.2\n\n- fix: something'),
  ],
  ['unknown', 'unknown', 'unknown'],
);

// ================================================================ E. 失败分类
const FAILURE_CASES = [
  ['E1 退出码 1602 → cancelled', '用户取消', 1602, 'cancelled', null],
  ['E2 退出码 1223 → permission', '在提权询问上点了否', 1223, 'permission', null],
  ['E3 退出码 1925 → permission', '权限不足', 1925, 'permission', null],
  ['E4 退出码 112 → disk', '磁盘空间不足', 112, 'disk', null],
  ['E5 退出码 1618 → busy', '系统里已有安装在进行', 1618, 'busy', null],
  [
    'E6 退出码 1603 → unknown，且人话里带 1603',
    '致命错误（细节在安装日志尾部）',
    1603,
    'unknown',
    '1603',
  ],
  ['E7 原文 ETIMEDOUT → network', 'ETIMEDOUT', null, 'network', null],
  ['E8 原文 ENETWORK: HTTP 404 → network', 'ENETWORK: HTTP 404', null, 'network', null],
  ['E9 原文 Access is denied. → permission', 'Access is denied.', null, 'permission', null],
  ['E10 原文 拒绝访问。→ permission', '拒绝访问。', null, 'permission', null],
  ['E11 原文 ENOSPC → disk', 'ENOSPC: no space left on device', null, 'disk', null],
  [
    'E12 原文 Another installation is in progress → busy',
    'Another installation is in progress',
    null,
    'busy',
    null,
  ],
  [
    'E13 我们自己写的那句校验失败 → checksum',
    '完整性校验没通过：校验值与官方清单不一致',
    null,
    'checksum',
    null,
  ],
  ['E14 我们自己写的那句未签名 → unsigned', '这个安装包没有数字签名', null, 'unsigned', null],
  ['E15 认不出来 → unknown（不编因果）', '???', null, 'unknown', null],
  [
    'E16 我们自己的判定优先于退出码（校验失败 + 古怪退出码仍是 checksum）',
    '完整性校验没通过',
    1603,
    'checksum',
    null,
  ],
  ['E17 退出码 0 但原文是网络错误 → network', 'ETIMEDOUT', 0, 'network', null],
];
for (const [name, text, code, kind, messageFragment] of FAILURE_CASES) {
  const reason = classifyInstallFailure(text, code);
  const ok =
    reason.kind === kind &&
    typeof reason.message === 'string' &&
    reason.message.length > 0 &&
    reason.hint !== null &&
    (messageFragment === null || reason.message.includes(messageFragment));
  check(
    name,
    ok,
    `kind=${reason.kind} message=${show(reason.message)} hint=${show(reason.hint)}`,
    `kind=${kind} + 非空 message + 非 null hint`,
  );
}
const unknownWithCode = classifyInstallFailure('???', 1603);
check(
  'E18 认不出的退出码也要把编号带进人话（`退出码 <N>`），别让用户拿着一句"未知"去猜',
  unknownWithCode.message.includes('1603') && unknownWithCode.kind === 'unknown',
  `message=${show(unknownWithCode.message)}`,
  'message 里含 1603',
);

// ================================================================ F. 三条静态钉子（源码形状）
// t52 起 node-installer.ts 是 barrel + 类，纯函数与 IO 住在 node-*.ts 里；
// 下面这些静态钉子钉的是"引擎的源码形状"，所以读**整份**（barrel 里没有 export function）。
const installerSource = [
  'node-shared',
  'node-release',
  'node-owner',
  'node-failure',
  'node-flavor',
  'node-nvm',
  'node-plan',
  'node-io',
  'node-installer',
]
  .map((stem) => fs.readFileSync(path.join(repoRoot, 'src', 'main', `${stem}.ts`), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const countOf = (text, needle) => text.split(needle).length - 1;
function sliceBetween(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to);
  if (start < 0 || end < 0 || end <= start) return null;
  return text.slice(start, end);
}
/** 一个方法的函数体：从签名到**它后面**第一个类成员（`sliceBetween` 的 `to` 是从头找的，会撞到前面） */
function methodBody(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const end = text.indexOf('\n  private ', start + signature.length);
  return text.slice(start, end < 0 ? text.length : end);
}

const planSlice = sliceBetween(
  installerSource,
  'private async buildPlan(',
  'private async transferPhase(',
);
check(
  'F1 计划阶段切片切得出来（函数被改名时这条先红，而不是静默通过）',
  planSlice !== null,
  `切片=${planSlice === null ? '拿不到' : `${planSlice.length} 字`}`,
  'buildPlan → transferPhase 之间的源码',
);
if (planSlice !== null) {
  check(
    'F2 计划阶段不出现任何"未签名"判定（剥注释后切片里 0 次：`signer: null` 只是"还没读"，不是"未签名"）',
    !planSlice.includes('没有数字签名') && !planSlice.includes('未签名'),
    `没有数字签名=${countOf(planSlice, '没有数字签名')} 次、未签名=${countOf(planSlice, '未签名')} 次`,
    '两串各 0 次',
  );
  /**
   * 计划路径数会随需求增长，所以这条钉的是「**每一条**计划路径都钉住 signer + releaseSigning」：
   * 计划字面量有几个，`signer: null` 就该有几处；`releaseSigning` 也每条都有（`unknown` 那几处
   * 是这一轮根本没读发布自述：顶层拒绝 / 直装两处 / nvm 拒绝 / nvm 管理器已在），
   * 只有真去装管理器那条取自发布说明 —— 全文件那一次赋值仍然只有一处。
   *
   * t29 之前是 4 条（直装拒绝 / 直装正常 / nvm 拒绝 / nvm 正常），t29 之后 6 条：
   * 多出 `buildRefusalPlan()`（归属未知 / 档位判不出来 / 归属已知时点了不该走的那条路）
   * 与 `buildNvmPlan()` 的 `installsManager === false`（机器上已经有管理器：这次什么都不下载）。
   * 两条新路各自都必须写死 `releaseSigning: 'unknown'` + `signer: null`（那里连下载都不会发生）。
   */
  const planLiteralCount = countOf(planSlice, 'plan: {');
  check(
    'F3 六条计划路径每条都钉住 signer + releaseSigning（6 次 `signer: null`；5 处写死 unknown：顶层拒绝 / 直装拒绝 / 直装正常 / nvm 拒绝 / nvm 管理器已在；1 处取自发布说明；1 处取值使用）',
    planLiteralCount === 6 &&
      countOf(planSlice, 'signer: null') === planLiteralCount &&
      countOf(planSlice, "releaseSigning: 'unknown'") === planLiteralCount - 1 &&
      // 6 条路径各有一处 releaseSigning（5 处字面量 + 1 处取变量），再加上那一次赋值 = 7
      countOf(planSlice, 'releaseSigning') === planLiteralCount + 1 &&
      countOf(planSlice, 'const releaseSigning = parseReleaseSigning(') === 1 &&
      countOf(installerSource, 'const releaseSigning = parseReleaseSigning(') === 1,
    `signer: null=${countOf(planSlice, 'signer: null')}、releaseSigning: 'unknown'=${countOf(planSlice, "releaseSigning: 'unknown'")}、计划字面量=${planLiteralCount}、parseReleaseSigning 赋值=${countOf(planSlice, 'const releaseSigning = parseReleaseSigning(')}`,
    '6 / 5 / 6 条路径都钉住 / 1',
  );
}
check(
  'F4 计划阶段不读 index.json 的 files 数组（全文件没有 files.includes / files.indexOf）',
  !installerSource.includes('files.includes') && !installerSource.includes('files.indexOf'),
  `files.includes=${countOf(installerSource, 'files.includes')} 次、files.indexOf=${countOf(installerSource, 'files.indexOf')} 次`,
  '两串各 0 次',
);
const directSlice = sliceBetween(
  installerSource,
  'private async buildDirectPlan(',
  'private async buildNvmPlan(',
);
check(
  'F5 直装的存在性权威是同一版本目录下的校验清单（读到 SHASUMS256.txt 并 parseShasums；从头到尾没碰 .files）',
  directSlice !== null &&
    directSlice.includes('SHASUMS256.txt') &&
    directSlice.includes('parseShasums(') &&
    countOf(directSlice, '.files') === 0,
  `切片=${directSlice === null ? '拿不到' : `${directSlice.length} 字`}、SHASUMS256.txt=${directSlice ? countOf(directSlice, 'SHASUMS256.txt') : '—'}、parseShasums(=${directSlice ? countOf(directSlice, 'parseShasums(') : '—'}、.files=${directSlice ? countOf(directSlice, '.files') : '—'}`,
  'SHASUMS256.txt 1 次、parseShasums( 1 次、.files 0 次',
);
const hashSlice = sliceBetween(
  installerSource,
  "status === 'HashMismatch'",
  "status === 'NotSigned'",
);
check(
  "F6 HashMismatch 永远不安装：那一段里有 kind: 'failed'，且没有 releaseSigning（未签名有豁免，内容不符没有）",
  hashSlice !== null &&
    countOf(hashSlice, "kind: 'failed'") === 1 &&
    countOf(hashSlice, 'releaseSigning') === 0,
  `切片=${hashSlice === null ? '拿不到' : `${hashSlice.length} 字`}、kind: 'failed'=${hashSlice ? countOf(hashSlice, "kind: 'failed'") : '—'}、releaseSigning=${hashSlice ? countOf(hashSlice, 'releaseSigning') : '—'}`,
  "kind: 'failed' 1 次、releaseSigning 0 次",
);
/**
 * 完整性那一闸与 Authenticode 那一闸是**两件事**：内容不符（哈希对不上）是无条件硬闸 ——
 * 删文件、`kind: 'failed'`、分类成 `checksum`，没有任何"发布方声明过"的豁免。
 * 反过来，计划里 `sha256` 为空（老线 1.2.x 的资产没有 digest）时这一步整段不进，是**已知降级**、
 * 由确认区先说清楚（这里只钉"有校验值时的行为"）。
 */
const hashGateSlice = sliceBetween(
  installerSource,
  'if (plan.sha256) {',
  'const signature = this.readSignature(file);',
);
check(
  "F7 哈希不符是无条件硬闸：删文件 + kind:'failed' + checksum 分类，比对不分大小写、比的是计划里的 sha256",
  hashGateSlice !== null &&
    hashGateSlice.includes('sha256OfFile(') &&
    hashGateSlice.includes('removeQuietly(file)') &&
    hashGateSlice.includes("kind: 'failed'") &&
    hashGateSlice.includes('完整性校验没通过') &&
    hashGateSlice.includes('actual.toLowerCase() !== plan.sha256.toLowerCase()'),
  `切片=${hashGateSlice === null ? '拿不到' : `${hashGateSlice.length} 字`}、sha256OfFile=${hashGateSlice ? countOf(hashGateSlice, 'sha256OfFile(') : '—'}、removeQuietly(file)=${hashGateSlice ? countOf(hashGateSlice, 'removeQuietly(file)') : '—'}`,
  "sha256OfFile ≥1、removeQuietly(file) ≥1、kind: 'failed'、完整性校验没通过、大小写不敏感的比对都在这一闸里",
);
check(
  'F8 引擎从不读 `*.checksum.txt` / zip 的校验文件（`nvm-setup.zip.checksum.txt` 覆盖的是 zip，不是 setup.exe；校验值只来自发布资产的 digest）',
  !installerSource.includes('checksum.txt') &&
    !installerSource.includes('nvm-setup.zip') &&
    !installerSource.includes('zip.checksum'),
  `checksum.txt=${countOf(installerSource, 'checksum.txt')} 次、nvm-setup.zip=${countOf(installerSource, 'nvm-setup.zip')} 次`,
  '两串各 0 次',
);

// ================================================================ G. 观察（不判 pass/fail）
observe(
  'index.json 866 条里含 win-arm64-msi 的 0 条、含 win-x64-msi 的 631 条，' +
    '而 v24.21.0 的 SHASUMS256.txt 里 node-v24.21.0-arm64.msi 有 sha256、HEAD 也是 200（29671424 字节）' +
    '—— 所以"存在性以同目录校验清单为权威"成立，index.json 的 files 只能用来列版本',
);
observe(
  `nvm-windows 的发布页正文里 v2.0.0 是 "Unsigned community build…"、v2.0.1-hotfix.2 是 "Authenticode-signed…"；` +
    '1.2.2 那条线的资产（nvm-setup.exe）**没有 digest** —— 所以 assetSha256 返回 null 是正常情形，界面要说"这次没能校验完整性"而不是"校验失败"',
);
observe(
  '真实 API 地址是 api.github.com/repos/nvm-windows/nvm/releases（coreybutler/nvm-windows 会 301 到它）—— ' +
    'node 的 https.get 不跟 301，写错仓库名就是一次静默的网络失败',
);
if (!ONLINE) {
  observe(
    '（--online 未开启：内嵌夹具没有重新核对外部事实。需要时手动跑一次 node scripts/env-wizard-cases.mjs --online）',
  );
}

// ================================================================ H. --online：重抓外部事实（不进门禁）
if (ONLINE) {
  const { get } = await import('node:https');
  const fetchText = (url) =>
    new Promise((resolve, reject) => {
      get(url, { headers: { 'user-agent': 'dsh-console-verifier' } }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }).on('error', reject);
    });
  let onlineChecks = 0;
  try {
    const shasums = await fetchText('https://nodejs.org/dist/v24.21.0/SHASUMS256.txt');
    eq(
      'H1 （--online）v24.21.0 的校验清单与内嵌夹具一字不差',
      shasums.body.replace(/\r\n/g, '\n').trim(),
      SHASUMS_V24_21_0.trim(),
    );
    onlineChecks += 1;
    const index = await fetchText('https://nodejs.org/dist/index.json');
    const list = JSON.parse(index.body);
    const lts = list.find((item) => item.lts !== false);
    eq(
      'H2 （--online）index.json 的最新 LTS 仍是 v24.21.0（内嵌夹具没过期）',
      [list[0].version, lts.version, lts.lts],
      ['v26.9.0', 'v24.21.0', 'Krypton'],
    );
    onlineChecks += 1;
  } catch (error) {
    observe(
      `--online 抓取失败（不影响离线结论）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  observe(`--online 跑了 ${onlineChecks} 条比对`);
}

// ================================================================ I. 「环境 OK」判定与 currentStepId（纯函数）
/**
 * 门禁判定的输入是**阶段一那份报告**，所以这里不手写报告字面量，而是造一份原始探测事实、
 * 先过 `judgeEnvironment`、再进 `judgeWizard` —— 两步接起来测，才是用户真正走的那条路
 *（手写报告会绕开"报告是怎么来的"这一半，反例就测不到了）。
 */
const envDoctor = require(path.join(buildDir, 'main', 'env-doctor.js'));
const {
  judgeEnvironment,
  judgeWizard,
  WIZARD_STEP_IDS,
  WIZARD_STEP_SKIPPABLE,
  WIZARD_STEP_CHECK_IDS,
  probeTroubleLines,
} = envDoctor;
const missingDoctorExports = ['judgeEnvironment', 'judgeWizard', 'probeTroubleLines'].filter(
  (name) => typeof envDoctor[name] !== 'function',
);
if (missingDoctorExports.length > 0) {
  console.error(
    `env-doctor 缺这些导出：${missingDoctorExports.join('、')} —— 判定函数被改名或挪走了`,
  );
  process.exit(2);
}

const NODE_OK = {
  path: 'C:\\Program Files\\nodejs\\node.exe',
  version: 'v24.19.0',
  exitCode: 0,
  error: null,
};
const NO_BIN = { path: null, version: null, exitCode: null, error: null };
const SKIPPED = { ...NO_BIN, skipped: true };
const probeRaw = (over = {}) => ({
  checkedAt: 1758000000000,
  platform: 'win32',
  packaged: true,
  bundled: { electron: '44.3.0', node: '24.19.0', chrome: '140.0.0' },
  node: { ...NODE_OK },
  npm: { ...NODE_OK, path: 'C:\\Program Files\\nodejs\\npm.cmd' },
  pnpm: { ...NODE_OK, path: 'C:\\Program Files\\nodejs\\pnpm.cmd' },
  dsh: {
    kind: 'node-bin',
    display: 'C:\\Program Files\\nodejs\\node.exe …\\dsh\\bin.js',
    runs: true,
    version: '0.5.3',
    exitCode: 0,
    error: null,
    resolveError: null,
  },
  shell: { file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', exists: true },
  error: null,
  ...over,
});
const wizardOf = (over, skips = []) => judgeWizard(judgeEnvironment(probeRaw(over)), skips);
const stepOf = (state, id) => state.steps.find((step) => step.id === id);
const summaryOf = (state) =>
  `${state.gate}｜${state.steps.map((step) => `${step.id}:${step.status}`).join(' ')}｜current=${state.currentStepId}｜skips=[${state.skips.join(',')}]`;

const healthy = wizardOf({});
eq(
  'I1 健康机器：三步全 done、门禁 open、currentStepId=null、gateReason=null、skips 为空',
  [
    healthy.gate,
    healthy.steps.map((step) => step.status),
    healthy.currentStepId,
    healthy.gateReason,
    healthy.skips,
  ],
  ['open', ['done', 'done', 'done'], null, null, []],
);
const noNode = wizardOf({ node: { ...NO_BIN } });
eq(
  'I2 缺 Node（唯一有证据的缺失）：node=todo → blocked、currentStepId=node、gateReason 点名 Node',
  [
    noNode.gate,
    stepOf(noNode, 'node').status,
    noNode.currentStepId,
    noNode.gateReason.includes('Node'),
  ],
  ['blocked', 'todo', 'node', true],
);
const noPnpm = wizardOf({ pnpm: { ...NO_BIN } });
eq(
  'I3 缺 pnpm：pnpm=todo → blocked、currentStepId=pnpm（npm 在，所以只挡这一步）',
  [noPnpm.gate, stepOf(noPnpm, 'pnpm').status, noPnpm.currentStepId],
  ['blocked', 'todo', 'pnpm'],
);
const oldNode = wizardOf({ node: { ...NODE_OK, version: 'v20.9.0' } });
eq(
  'I4 版本过低（node 在、版本 v20.9.0 出区间）：node-version=warn **不当缺失** → node 步骤仍 done、门禁 open（冻结 §2.2 / §3.8#4）',
  [oldNode.gate, stepOf(oldNode, 'node').status, noNode.gate],
  ['open', 'done', 'blocked'],
);
const dshDead = wizardOf({
  dsh: {
    kind: 'node-bin',
    display: '…',
    runs: false,
    version: null,
    exitCode: 0,
    error: null,
    resolveError: null,
  },
});
eq(
  'I5 dsh 定位到了但跑不动（退出码 0 + 零输出）：dsh-run=missing → dsh=todo、blocked、currentStepId=dsh',
  [dshDead.gate, stepOf(dshDead, 'dsh').status, dshDead.currentStepId],
  ['blocked', 'todo', 'dsh'],
);
const dshNpx = wizardOf({
  dsh: {
    kind: 'npx',
    display: 'npx -y @deepseek-ai/dsh',
    runs: true,
    version: '0.5.3',
    exitCode: 0,
    error: null,
    resolveError: null,
  },
});
eq(
  'I6 dsh 走 npx（能用但要联网解析）：只是 warn → dsh 步骤仍 done、门禁 open',
  [dshNpx.gate, stepOf(dshNpx, 'dsh').status],
  ['open', 'done'],
);
const fastProbeClean = wizardOf({
  node: { ...SKIPPED },
  npm: { ...SKIPPED },
  pnpm: { ...SKIPPED },
  dsh: {
    kind: null,
    display: null,
    runs: false,
    version: null,
    exitCode: null,
    error: null,
    resolveError: null,
    skipped: true,
  },
});
eq(
  'I7a 干净机器上的快速探测（三个路径全 null = 真实证据、子进程项 skipped）：node=missing → **blocked**（启动决策据此不自动拉起 dsh，R-14）',
  [
    fastProbeClean.gate,
    stepOf(fastProbeClean, 'node').status,
    fastProbeClean.currentStepId,
    stepOf(fastProbeClean, 'node').detail.includes('没找到'),
  ],
  ['blocked', 'todo', 'node', true],
);
const fastProbeHealthy = wizardOf({
  node: { ...NODE_OK, version: null, skipped: true },
  npm: { ...NODE_OK, path: 'C:\\Program Files\\nodejs\\npm.cmd', version: null, skipped: true },
  pnpm: { ...NODE_OK, path: 'C:\\Program Files\\nodejs\\pnpm.cmd', version: null, skipped: true },
  dsh: {
    kind: null,
    display: null,
    runs: false,
    version: null,
    exitCode: null,
    error: null,
    resolveError: null,
    skipped: true,
  },
});
eq(
  'I7b 路径都在、只是"这一轮没测版本"（skipped→warn）：三步判据都成立 → 全 done、门禁 open、缺项数 0 —— 健康机器不为快速探测多等一次，也不被拦（R-14 / §3.8#4）',
  [
    fastProbeHealthy.gate,
    fastProbeHealthy.steps.map((step) => step.status),
    judgeEnvironment(probeRaw({ node: { ...NODE_OK, version: null, skipped: true } })).counts
      .missing,
  ],
  ['open', ['done', 'done', 'done'], 0],
);
const errored = wizardOf({ error: '读设置失败：settings.json 解析不了' });
eq(
  'I8 探测自己失败（report.error 非空）+ 没有 missing 证据：三步记 unknown → 门禁 unknown、currentStepId=第一个 unknown（node）',
  [errored.gate, errored.steps.map((step) => step.status), errored.currentStepId],
  ['unknown', ['unknown', 'unknown', 'unknown'], 'node'],
);
const erroredMissing = wizardOf({ pnpm: { ...NO_BIN }, error: '读设置失败' });
eq(
  'I9 探测自己失败 + 某一步有 missing 证据：**有证据就挡** → pnpm=todo、blocked、currentStepId=pnpm',
  [erroredMissing.gate, stepOf(erroredMissing, 'pnpm').status, erroredMissing.currentStepId],
  ['blocked', 'todo', 'pnpm'],
);
const skippedUnskippable = wizardOf({ node: { ...NO_BIN } }, ['node', 'dsh', 'bogus']);
eq(
  'I10 不可跳过的 id（node / dsh）与未知 id 写进 skips 一律**被忽略**：node 仍 todo、blocked，skips 收敛成空数组',
  [skippedUnskippable.gate, stepOf(skippedUnskippable, 'node').status, skippedUnskippable.skips],
  ['blocked', 'todo', []],
);
const skippedPnpm = wizardOf({ pnpm: { ...NO_BIN } }, ['pnpm']);
eq(
  'I11 可跳过的 pnpm 被跳过：pnpm=skipped（不是 todo）→ 门禁 open、currentStepId=null（跳过之后不再挡人）',
  [
    skippedPnpm.gate,
    stepOf(skippedPnpm, 'pnpm').status,
    skippedPnpm.currentStepId,
    stepOf(skippedPnpm, 'pnpm').detail.includes('跳过'),
  ],
  ['open', 'skipped', null, true],
);
eq(
  'I12 步骤形状：id 顺序 = node/pnpm/dsh、checkIds 只用既有自检项、skippable 只有 pnpm 是 true、node 的 fixAction 恒为 null',
  [
    healthy.steps.map((step) => step.id),
    healthy.steps.map((step) => step.checkIds),
    healthy.steps.map((step) => step.skippable),
    healthy.steps.map((step) => step.fixAction)[0],
    WIZARD_STEP_IDS.join(','),
    WIZARD_STEP_SKIPPABLE.pnpm && !WIZARD_STEP_SKIPPABLE.node && !WIZARD_STEP_SKIPPABLE.dsh,
    WIZARD_STEP_CHECK_IDS.dsh.join(','),
  ],
  [
    ['node', 'pnpm', 'dsh'],
    [['node', 'node-version', 'npm'], ['pnpm'], ['dsh', 'dsh-run']],
    [false, true, false],
    null,
    'node,pnpm,dsh',
    true,
    'dsh,dsh-run',
  ],
);
const blockedCases = [noNode, noPnpm, dshDead, erroredMissing];
check(
  'I13 冻结推论：`gate === blocked` 时 currentStepId 一定指向一个 todo 的步骤（当前步骤卡永远有可做的动作）',
  blockedCases.every((state) => {
    const step = stepOf(state, state.currentStepId);
    return state.gate === 'blocked' && step !== undefined && step.status === 'todo';
  }),
  blockedCases.map((state) => summaryOf(state)).join(' ／ '),
  '每条都是 blocked + currentStepId 指向 todo',
);
const malformed = [];
for (const [label, args] of [
  ['judgeWizard(null, null)', [null, null]],
  ['judgeWizard(undefined, undefined)', [undefined, undefined]],
  ['judgeWizard({}, undefined)', [{}, undefined]],
  [
    'judgeWizard({checks:"x",plans:5,error:null}, ["bogus"])',
    [{ checks: 'x', plans: 5, error: null }, ['bogus']],
  ],
  ['judgeWizard({steps:[],report:null}, [])', [{ steps: [], report: null }, []]],
]) {
  try {
    const state = judgeWizard(...args);
    malformed.push(`${label} → gate=${state && state.gate}（不抛）`);
  } catch (error) {
    malformed.push(`${label} → 抛了：${error instanceof Error ? error.message : String(error)}`);
  }
}
check(
  'I14 输入畸形（null / undefined / 字段类型全错）：判定**不许抛**（冻结 §2.1「任何输入都不抛」），且总要给出一个门禁三态',
  malformed.every((line) => line.includes('（不抛）') && /gate=(open|blocked|unknown)/.test(line)),
  malformed.join('；'),
  '每一条都"不抛 + gate 是三态之一"',
);

// ================================================================ J. 安装结果的判定（行为：注入桩，避开真机动作）
/**
 * 攻击点：「只看退出码就宣布成功」。
 *
 * `run()` 会真的下载并安装，**不能在沙箱里调**；但收尾那几个方法（`settleSuccess` /
 * `settleFailure` / `confirmDetached`）只吃注入的钩子与复检报告，所以能在这里真跑：
 * 把 `hooks.recheck` 造成"说 node 好了 / 说还缺 / 直接抛"，看引擎给什么终态。
 * 引擎硬约定（冻结 §4.2 + 需求 §7.6）：**没有复检事实就不宣布任何结论**。
 */
const EMPTY_INSTALL = {
  phase: 'idle',
  method: null,
  mode: null,
  percent: null,
  bytes: null,
  cancellable: false,
  detached: false,
  message: null,
  code: null,
  report: null,
};
const reportWith = (nodeStatus) => ({
  checkedAt: 1758000000001,
  platform: 'win32',
  packaged: true,
  bundled: { electron: '44.3.0', node: '24.19.0', chrome: '140.0.0' },
  checks: [{ id: 'node', status: nodeStatus, detail: '夹具', fixHint: null, fixAction: null }],
  counts: { ok: nodeStatus === 'ok' ? 1 : 0, warn: 0, missing: nodeStatus === 'missing' ? 1 : 0 },
  plans: [],
  error: null,
  firstProblemId: nodeStatus === 'ok' ? null : 'node',
});
const PLAN_FIXTURE = {
  method: 'direct',
  mode: 'install',
  channel: 'lts',
  version: 'v24.21.0',
  url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi',
  sourceHost: 'nodejs.org',
  sha256: 'bb0eaee134f9357f22aea915ee793343e627aefc1e66488164bac6915bce2cac',
  evidence: '与安装包同一个目录下的官方校验清单',
  releaseSigning: 'unknown',
  signer: null,
  usable: true,
  refuseReason: null,
  needsElevation: true,
  affectsRunningDsh: false,
  display: 'msiexec /i node-v24.21.0-x64.msi /qb /norestart',
  target: 'C:\\Program Files\\nodejs（官方安装包的默认位置）',
  note: '夹具',
};
const installerModule = require(path.join(buildDir, 'main', 'node-installer.js'));
function makeInstaller(recheckImpl) {
  const logs = [];
  const published = [];
  const hooks = {
    output: () => {},
    state: (state) => published.push(state),
    log: (text) => logs.push(text),
    recheck: recheckImpl,
    stopDsh: async () => {},
  };
  const settings = { get: () => '', all: () => ({}) };
  return { installer: new installerModule.NodeInstaller(settings, hooks), logs, published };
}
const BUSY_MESSAGE = '正在执行上一步的操作，完成后按钮会自动恢复';
const NETWORK_REASON = {
  kind: 'network',
  message: '下载没成功（连接超时或连不上）。',
  hint: '① 用浏览器打开官方下载页自己装 ② 换一个下载源',
};
const PERMISSION_REASON = {
  kind: 'permission',
  message: '你拒绝了管理员权限，这台电脑上什么都没改。',
  hint: '可以改用不用管理员权限的方式安装（版本管理器）。',
};
{
  const busyRunning = makeInstaller(async () => reportWith('ok'));
  busyRunning.installer.running = true;
  const stateRunning = await busyRunning.installer.run({ method: 'direct', mode: 'install' });
  check(
    'J1 互斥位在跑时：`run()` 直接回忙位那句话，**不进入**下载 / 安装（没有第二次真动作）',
    stateRunning.message === BUSY_MESSAGE && busyRunning.logs.length === 0,
    `message=${show(stateRunning.message)} logs=${busyRunning.logs.length}`,
    `message=${BUSY_MESSAGE}，logs=0`,
  );
  const busyDetached = makeInstaller(async () => reportWith('ok'));
  busyDetached.installer.holding = true;
  const stateDetached = await busyDetached.installer.run({ method: 'direct', mode: 'install' });
  check(
    'J2 「不再等待」期间（holding）仍然算忙：`run()` 被拦下（R-06 的落点）',
    busyDetached.installer.busy() && stateDetached.message === BUSY_MESSAGE,
    `busy=${busyDetached.installer.busy()} message=${show(stateDetached.message)}`,
    'busy=true + 忙位那句话',
  );
  const noRun = makeInstaller(async () => reportWith('ok'));
  const stateNoRun = await noRun.installer.settleFailure(PERMISSION_REASON, false);
  check(
    'J3 安装器**没起来**的失败：终态 error、不带复检报告、permission 只照贴那一句（不编因果、不接出路句）',
    stateNoRun.phase === 'error' &&
      stateNoRun.report === null &&
      stateNoRun.message === PERMISSION_REASON.message,
    `phase=${stateNoRun.phase} report=${stateNoRun.report === null ? 'null' : '有'} message=${show(stateNoRun.message)}`,
    'error + report=null + message 原样',
  );
  const networkFail = makeInstaller(async () => reportWith('missing'));
  const stateNetwork = await networkFail.installer.settleFailure(NETWORK_REASON, false);
  check(
    'J4 网络类失败：那句话后面接上出路（不然"什么都没改"之后用户不知道该干什么）',
    stateNetwork.message.startsWith(NETWORK_REASON.message) &&
      stateNetwork.message.includes('下载页'),
    show(stateNetwork.message),
    'message + 出路',
  );
  const landed = makeInstaller(async () => reportWith('ok'));
  const stateLanded = await landed.installer.settleFailure(NETWORK_REASON, true);
  check(
    'J5 安装器报错退出、但**复检说 Node 已经可用**：不许再说"这台电脑上什么都没改"，改口说已经落地（以事实为准）',
    stateLanded.phase === 'done' &&
      stateLanded.message.includes('其实已经落地') &&
      stateLanded.report !== null,
    `phase=${stateLanded.phase} message=${show(stateLanded.message)}`,
    'done + "其实已经落地"',
  );
  const stillMissing = makeInstaller(async () => reportWith('missing'));
  const stateMissing = await stillMissing.installer.settleFailure(NETWORK_REASON, true);
  check(
    'J6 安装器失败 + 复检仍说缺：终态 error、把失败原文给出来、报告一起带上（"什么都没改"要有证据支持）',
    stateMissing.phase === 'error' &&
      stateMissing.report !== null &&
      stateMissing.message.includes('没成功'),
    `phase=${stateMissing.phase} report=${stateMissing.report === null ? 'null' : '有'} message=${show(stateMissing.message)}`,
    'error + 非空 report',
  );
  const recheckThrows = makeInstaller(async () => {
    throw new Error('探测失败：spawnSync EPERM');
  });
  const stateThrows = await recheckThrows.installer.settleFailure(NETWORK_REASON, true);
  check(
    'J7 复检**自己失败**：绝不说 done、也不假装结论可靠 —— 终态 error + 说清"没能重新检测"',
    stateThrows.phase === 'error' &&
      stateThrows.report === null &&
      stateThrows.message.includes('没能重新检测'),
    `phase=${stateThrows.phase} message=${show(stateThrows.message)}`,
    'error + "没能重新检测"',
  );
  const successButMissing = makeInstaller(async () => reportWith('missing'));
  const stateSuccessMissing = await successButMissing.installer.settleSuccess(PLAN_FIXTURE);
  check(
    'J8 安装器**正常退出**但复检说还是缺：终态必须是 error（退出码不等于装好了）',
    stateSuccessMissing.phase === 'error' && stateSuccessMissing.message.includes('还没找到 Node'),
    `phase=${stateSuccessMissing.phase} message=${show(stateSuccessMissing.message)}`,
    'error + "还没找到 Node"',
  );
  const successThrows = makeInstaller(async () => {
    throw new Error('复检炸了');
  });
  const stateSuccessThrows = await successThrows.installer.settleSuccess(PLAN_FIXTURE);
  check(
    'J9 安装器正常退出但复检跑不完：也是 error，绝无 done',
    stateSuccessThrows.phase === 'error' && stateSuccessThrows.message.includes('没能重新检测'),
    `phase=${stateSuccessThrows.phase} message=${show(stateSuccessThrows.message)}`,
    'error + "没能重新检测"',
  );
  const quiet = makeInstaller(async () => reportWith('ok'));
  quiet.installer.running = true;
  const runningBusy = quiet.installer.busy();
  quiet.installer.running = false;
  quiet.installer.holding = true;
  const holdingBusy = quiet.installer.busy();
  quiet.installer.holding = false;
  const idleBusy = quiet.installer.busy();
  const idleStateBefore = JSON.stringify(quiet.installer.state());
  const stopResult = quiet.installer.stop();
  let quitThrew = null;
  try {
    quiet.installer.detachOnQuit();
  } catch (error) {
    quitThrew = error instanceof Error ? error.message : String(error);
  }
  check(
    'J10 互斥位三态：running / holding 都算忙，空闲不算；空闲时 `stop()` 与退出时的 `detachOnQuit()` 都不抛、不改状态',
    runningBusy &&
      holdingBusy &&
      !idleBusy &&
      stopResult.phase === 'idle' &&
      quitThrew === null &&
      JSON.stringify(quiet.installer.state()) === idleStateBefore,
    `busy(running)=${runningBusy} busy(holding)=${holdingBusy} busy(idle)=${idleBusy} stop.phase=${stopResult.phase} detachOnQuit 抛=${show(quitThrew)}`,
    'true/true/false + idle + 不抛 + 状态不变',
  );
  const successSlice = sliceBetween(
    installerSource,
    'private async settleSuccess(',
    'private probeInstalledNode(',
  );
  const executeSlice = sliceBetween(
    installerSource,
    'private async execute(',
    'private async buildPlan(',
  );
  check(
    "J11 静态钉子：`done` 只能由复检事实给出 —— settleSuccess 里 `publish('done'` 排在 `!observed || nodeMissing(report)` 之后；`execute` 里安装之后必须走 settleSuccess（退出码不直接等于成功）；四处 `publish('done'` 全部在复检方法里（settleSuccess / settleFailure / confirmDetached / finishDetached）",
    successSlice !== null &&
      successSlice.includes('probeInstalledNode()') &&
      successSlice.includes('!observed || this.nodeMissing(report)') &&
      successSlice.indexOf("publish('done'") > successSlice.indexOf('nodeMissing(report)') &&
      executeSlice !== null &&
      executeSlice.indexOf('settleSuccess(plan)') > executeSlice.indexOf('installPhase(plan') &&
      countOf(installerSource, "publish('done'") === 4 &&
      [
        'private async settleSuccess(',
        'private async settleFailure(',
        'private async confirmDetached(',
        'private async finishDetached(',
      ].every((method) => {
        const body = methodBody(installerSource, method);
        return body !== null && body.includes("publish('done'");
      }),
    `settleSuccess 切片 ${successSlice ? successSlice.length : '—'} 字、execute 切片 ${executeSlice ? executeSlice.length : '—'} 字、publish('done' 共 ${countOf(installerSource, "publish('done'")} 处`,
    "settleSuccess 里 done 在复检之后、execute 里 installPhase 之后是 settleSuccess、publish('done' 4 处且都在复检方法里",
  );
}

// ================================================================ K. 门禁放行与逃生口（渲染层真状态机 + IPC 桩）
/**
 * **为什么必须跑起来**：逃生口是"安装引擎坏了 / 网络断了 / 探测卡住了，用户还能不能进主界面"
 * 这条硬要求。静态检查只能证明"代码里没写别的分支"，证明不了"真到那一步它放行"。
 *
 * 做法：把 `src/renderer/state/env-wizard.ts` 单独编一份 CJS（`.verify/env-wizard-renderer-build`），
 * 在 Node 里 require —— `window.dshConsole` 用桩（渲染层与主进程的边界就是这个对象），
 * **状态机本身是产品源码**：相位、三条 disjunct 的可见性判定、逃生口、单向性都是它自己算的。
 * 每个场景重新 require（清 require.cache），因为那些相位位是模块级的。
 */
const RENDERER_BUILD = path.join(repoRoot, '.verify', 'env-wizard-renderer-build');
function resolveRendererBuild() {
  const built = path.join(RENDERER_BUILD, 'renderer', 'state', 'env-wizard.js');
  if (fs.existsSync(built) && fs.statSync(built).mtimeMs >= newestSourceMs()) return RENDERER_BUILD;
  console.log('（渲染层状态机没有可用的编译产物 → 现场 tsc 到 .verify/env-wizard-renderer-build）');
  const result = spawnSync(
    process.execPath,
    [
      TSC,
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--target',
      'es2023',
      '--skipLibCheck',
      '--esModuleInterop',
      '--outDir',
      RENDERER_BUILD,
      '--rootDir',
      'src',
      'src/renderer/env.d.ts',
      'src/renderer/state/env-wizard.ts',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (!fs.existsSync(built)) {
    console.error(`渲染层状态机编译失败（退出码 ${result.status ?? 1}），门禁与逃生口没法验证`);
    process.exit(2);
  }
  return RENDERER_BUILD;
}
const rendererBuild = resolveRendererBuild();
/** 装一个 IPC 桩并要求一份**全新**的状态机实例（相位位是模块级的，场景之间必须互不污染） */
function loadWizardModule(stub) {
  globalThis.window = { dshConsole: stub };
  for (const key of Object.keys(require.cache)) {
    if (key.replace(/\\/g, '/').includes('.verify/env-wizard-renderer-build'))
      delete require.cache[key];
  }
  return require(path.join(rendererBuild, 'renderer', 'state', 'env-wizard.js'));
}
const loadBootLock = () => require(path.join(rendererBuild, 'renderer', 'state', 'boot-lock.js'));
const gateState = (gate) => ({
  report: {
    checkedAt: 1758000000002,
    platform: 'win32',
    packaged: true,
    bundled: { electron: '44.3.0', node: '24.19.0', chrome: '140.0.0' },
    checks: [],
    counts: { ok: 0, warn: 0, missing: 0 },
    plans: [],
    error: gate === 'open' ? null : '夹具：这一轮没测全',
    firstProblemId: null,
  },
  steps: [],
  gate,
  currentStepId: null,
  gateReason: gate === 'open' ? null : '夹具',
  skips: [],
});

{
  // K1/K2：IPC 整个坏掉（网络不通 / 主进程不响应）—— 门禁照样能放行，且逃生口零 IPC
  let calls = 0;
  const mod = loadWizardModule({
    envWizard: () => {
      calls += 1;
      return Promise.reject(new Error('ENETUNREACH: 主进程不响应'));
    },
  });
  const first = await mod.loadWizard({ refresh: true });
  check(
    'K1 拉结论整个失败：门禁留在「检查中」并明说原因（不给用户一颗转圈的环），第一轮不许空白',
    first === null &&
      mod.gatePhase.value === 'checking' &&
      Boolean(mod.wizardError.value) &&
      mod.gateVisible.value === true,
    `返回=${show(first)} phase=${mod.gatePhase.value} visible=${mod.gateVisible.value} error=${show(mod.wizardError.value)}`,
    'null / checking / visible=true / 非空 error',
  );
  const callsBeforeEscape = calls;
  mod.escapeGate();
  check(
    'K2 逃生口：**零 IPC** 就能把门禁收起来（不写盘、不看安装状态、不再问一次主进程）→ 用户进得去主界面',
    mod.gateVisible.value === false &&
      mod.gatePhase.value === 'escaped' &&
      calls === callsBeforeEscape,
    `visible=${mod.gateVisible.value} phase=${mod.gatePhase.value} IPC 次数 ${callsBeforeEscape} → ${calls}`,
    'visible=false / escaped / IPC 次数不变',
  );
}
{
  // K3/K4：真的被挡住 + 安装通道正在动系统 / 已经出错 —— 逃生口都不受影响
  let handlers = {};
  const mod = loadWizardModule({
    envWizard: () => Promise.resolve(gateState('blocked')),
    onEnvInstallState: (handler) => {
      handlers.install = handler;
      return () => {};
    },
    onEnvInstallOutput: () => () => {},
  });
  mod.wireEnvWizard();
  await mod.loadWizard({ refresh: true });
  const blockedVisible = mod.gateVisible.value;
  handlers.install({
    ...EMPTY_INSTALL,
    phase: 'installing',
    method: 'direct',
    mode: 'install',
    message: '正在安装…',
  });
  const busyAfterInstall = mod.anyoneBusy.value;
  const visibleWhileBusy = mod.gateVisible.value;
  mod.escapeGate();
  check(
    'K3 门禁真的挡人 + 安装通道正在装（忙位为真）：遮挡层照常显示，但**逃生口不受忙位门控**，一点就放行',
    blockedVisible === true &&
      busyAfterInstall === true &&
      visibleWhileBusy === true &&
      mod.gateVisible.value === false &&
      mod.gatePhase.value === 'escaped',
    `blocked 时 visible=${blockedVisible} anyoneBusy=${busyAfterInstall} 忙时 visible=${visibleWhileBusy} 逃生后 visible=${mod.gateVisible.value}`,
    'true/true/true → 逃生后 false',
  );
  const mod2 = loadWizardModule({
    envWizard: () => Promise.resolve(gateState('blocked')),
    onEnvInstallState: (handler) => {
      handlers.install2 = handler;
      return () => {};
    },
    onEnvInstallOutput: () => () => {},
  });
  mod2.wireEnvWizard();
  await mod2.loadWizard({ refresh: true });
  handlers.install2({
    ...EMPTY_INSTALL,
    phase: 'waiting',
    method: 'nvm',
    mode: 'install',
    detached: true,
    message: '我们不等了',
  });
  const detachedBusy = mod2.anyoneBusy.value;
  mod2.escapeGate();
  check(
    'K4 「不再等待」期间（detached）：忙位仍然算忙（R-06），而逃生口照样放行',
    detachedBusy === true && mod2.gateVisible.value === false && mod2.gatePhase.value === 'escaped',
    `anyoneBusy=${detachedBusy} visible=${mod2.gateVisible.value} phase=${mod2.gatePhase.value}`,
    'true / false / escaped',
  );
}
{
  // K5/K6：放行页可达，健康机器首轮不该看见门禁层
  let round = 0;
  const mod3 = loadWizardModule({
    envWizard: () => {
      round += 1;
      return Promise.resolve(gateState(round === 1 ? 'blocked' : 'open'));
    },
  });
  await mod3.loadWizard({ refresh: true });
  const wasBlocked = mod3.gateVisible.value;
  await mod3.loadWizard({ refresh: true });
  check(
    'K5 门禁层放行页可达（同一个实例：先挡住、再变 open）：相位 released 且**仍然可见**，用户才点得到「进入 DSH Console」',
    wasBlocked === true && mod3.gatePhase.value === 'released' && mod3.gateVisible.value === true,
    `挡住时 visible=${wasBlocked} → released 后 phase=${mod3.gatePhase.value} visible=${mod3.gateVisible.value}`,
    'true → released / true',
  );
  mod3.enterMainUi();
  check(
    'K5b 点「进入 DSH Console」之后门禁层收起（相位 entered）',
    mod3.gatePhase.value === 'entered' && mod3.gateVisible.value === false,
    `phase=${mod3.gatePhase.value} visible=${mod3.gateVisible.value}`,
    'entered / false',
  );
  const healthyMod = loadWizardModule({ envWizard: () => Promise.resolve(gateState('open')) });
  await healthyMod.loadWizard({ refresh: true });
  check(
    'K6 健康机器第一轮就是 open（本轮没挡过人）：相位 released 但门禁层**根本不渲染**（不许静默全屏）',
    healthyMod.gatePhase.value === 'released' && healthyMod.gateVisible.value === false,
    `phase=${healthyMod.gatePhase.value} visible=${healthyMod.gateVisible.value}`,
    'released / false',
  );
  const unknownMod = loadWizardModule({ envWizard: () => Promise.resolve(gateState('unknown')) });
  await unknownMod.loadWizard({ refresh: true });
  check(
    'K6b 门禁 unknown（这一轮没测全，不挡人）：相位 unknown、层收起，主界面 + 黄条就是给用户的答案',
    unknownMod.gatePhase.value === 'unknown' && unknownMod.gateVisible.value === false,
    `phase=${unknownMod.gatePhase.value} visible=${unknownMod.gateVisible.value}`,
    'unknown / false',
  );
}
{
  // K7/K8：单向性 + 唯一的重开入口
  const mod = loadWizardModule({ envWizard: () => Promise.resolve(gateState('blocked')) });
  await mod.loadWizard({ refresh: true });
  mod.escapeGate();
  const escaped = mod.gateVisible.value === false;
  await mod.loadWizard({ refresh: true });
  check(
    'K7 逃生之后不可逆：再来一份 blocked 报告也只更新数据（相位收敛到 done），**不会把门禁重新扣上来**',
    escaped && mod.gatePhase.value === 'done' && mod.gateVisible.value === false,
    `phase=${mod.gatePhase.value} visible=${mod.gateVisible.value}`,
    'done / false',
  );
  mod.reopenGate();
  const reopenPhase = mod.gatePhase.value;
  const reopenVisible = mod.gateVisible.value;
  await mod.loadWizard();
  check(
    'K8 用户显式重开（横幅 / 自检页那两条路）是**唯一**允许再显示门禁层的入口',
    reopenPhase === 'checking' && reopenVisible === true,
    `reopenGate → phase=${reopenPhase} visible=${reopenVisible}`,
    'checking / true',
  );
}
{
  // K9：与启动锁互斥（R-08 的前置条件）
  const mod = loadWizardModule({ envWizard: () => Promise.resolve(gateState('blocked')) });
  const bootLock = loadBootLock();
  bootLock.setBootLockVisible(true);
  await mod.loadWizard({ refresh: true });
  const hiddenWhileLocked = mod.gateVisible.value;
  bootLock.setBootLockVisible(false);
  const visibleAfterUnlock = mod.gateVisible.value;
  check(
    'K9 启动锁在显示时：门禁层一律不显示（两层不互相压）；锁一撤立刻按相位显示',
    hiddenWhileLocked === false && visibleAfterUnlock === true,
    `锁中 visible=${hiddenWhileLocked}；撤锁后 visible=${visibleAfterUnlock}`,
    'false / true',
  );
}
{
  // K10：逃生口与判定无关（不写盘 / 不改判定 / 不发 IPC）——用"逃生之后判定数据仍在更新"来证明
  let received = 0;
  const mod = loadWizardModule({
    envWizard: () => {
      received += 1;
      return Promise.resolve(gateState('open'));
    },
  });
  await mod.loadWizard({ refresh: true });
  mod.escapeGate();
  const before = received;
  await mod.loadWizard({ refresh: true });
  check(
    'K10 逃生之后：判定照旧在更新（数据面与显示面分开），但层不再显示 —— 逃生**不改判定、不写盘**',
    received === before + 1 && mod.wizard.value !== null && mod.gateVisible.value === false,
    `IPC 次数 ${before} → ${received}、wizard=${mod.wizard.value ? '有' : 'null'}、visible=${mod.gateVisible.value}`,
    'IPC +1、数据更新、visible=false',
  );
  const bannerMod = loadWizardModule({ envWizard: () => Promise.resolve(gateState('unknown')) });
  await bannerMod.loadWizard({ refresh: true });
  const beforeBanner = bannerMod.gateVisible.value;
  await bannerMod.loadWizard({ refresh: true }); // 主界面横幅的「重新检测」就是这一句
  const afterBanner = bannerMod.gateVisible.value;
  observe(
    `主界面横幅的「重新检测」返回**之后**的 gateVisible：${beforeBanner} → ${afterBanner}（相位 ${bannerMod.gatePhase.value}）—— 这一行看不出问题，要看**等待期间**（见 K11）`,
  );
}
{
  /**
   * K11：主界面横幅的「重新检测」**等待期间**会不会把全屏门禁层拉出来。
   *
   * 冻结 R-08 的第 ② 条 disjunct 是"`checking` 且**这一轮属于门禁层**"，§3.8#15 把判据写全成
   * "挂载后第一轮、层内「重新检测」→ 可见；**从主界面横幅触发的 `checking` → 不可见**"。
   * 这一条必须**在等待期间**取样才看得见：请求回来之后相位就被结论覆盖了。
   * 用可控的 Promise 桩把"等待期间"钉住（这是这套状态机最容易假通过的地方之一）。
   */
  const pending = [];
  const mod = loadWizardModule({
    envWizard: () => new Promise((resolve) => pending.push(resolve)),
  });
  const firstRound = mod.loadWizard({ refresh: true });
  const visibleFirstRound = mod.gateVisible.value;
  pending.shift()(gateState('unknown'));
  await firstRound;
  const visibleAfterFirst = mod.gateVisible.value;
  const bannerRound = mod.loadWizard({ refresh: true });
  const visibleDuringBannerRound = mod.gateVisible.value;
  pending.shift()(gateState('unknown'));
  await bannerRound;
  const visibleAfterBanner = mod.gateVisible.value;
  check(
    'K11 横幅触发的 checking **不可见**（冻结 R-08 ② / §3.8#15）：挂载后第一轮可见、层内重新检测可见，而从主界面横幅点「重新检测」不许弹出全屏门禁层',
    visibleFirstRound === true &&
      visibleAfterFirst === false &&
      visibleDuringBannerRound === false &&
      visibleAfterBanner === false,
    `第一轮等待期间=${visibleFirstRound}（应为 true）、第一轮结束=${visibleAfterFirst}（应为 false）、横幅等待期间=${visibleDuringBannerRound}（应为 false）、横幅结束=${visibleAfterBanner}（应为 false）`,
    'true / false / false / false',
  );
}

// ================================================================ K12. inflight 的兜底（t27 新增）
{
  /**
   * K12：**一次往返永远不回来**时，用户显式发起的下一轮必须真的发出去。
   *
   * `inflight` 是"并发共用同一次往返"的手段，它隐含一个前提 —— **每次 invoke 都会 settle**。
   * 这条前提不能当公理（主进程可能卡在一个永远回不来的探测里；界面与主进程半新半旧时那个通道
   * 甚至可能压根不存在）。前提一破，旧形状 `if (inflight) return inflight;` 会把**所有**后续拉取
   * 都挂在那颗死掉的 Promise 上：用户点「重新检测」/「重新打开环境向导」一点反应都没有，
   * 而且连一条错误都不会显示 —— 比报错更难排查。
   *
   * 所以冻结下来的规则是：显式 `refresh`（用户主动要新结论）与 `reopenGate()`（用户显式重开向导）
   * **一律**作废旧的；其余调用只在往返年轻于 `INFLIGHT_STALE_MS` 时才共用。
   * 这里用**可控的 Promise 桩**把"永远不回来"这件事造出来（同 K11 的手法）。
   */
  const pending = [];
  const mod = loadWizardModule({
    envWizard: () => new Promise((resolve) => pending.push(resolve)),
  });
  const hung = mod.loadWizard({ refresh: true }); // 第一轮：永远不回来
  const afterFirst = pending.length;
  const refreshed = mod.loadWizard({ refresh: true }); // ① 显式 refresh：必须作废死掉的那次
  const afterRefresh = pending.length;
  mod.reopenGate(); // ② 用户显式重开：也必须
  const afterReopen = pending.length;
  const shared = mod.loadWizard(); // ③ 年轻 + 非 refresh：**仍然共用**（去重不能被兜底搞坏）
  const afterShared = pending.length;
  // ④ 超过时限之后：必须发新的一次（把时钟往前推，而不是真等 15 秒）
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + mod.INFLIGHT_STALE_MS + 1;
  const stale = mod.loadWizard();
  Date.now = realNow;
  const afterStale = pending.length;
  check(
    'K12 inflight 兜底：一次往返永远不回来时，显式 refresh / reopenGate() / 超过 INFLIGHT_STALE_MS 都必须真的再发一次，而"年轻 + 非 refresh"仍然共用（去重没被搞坏）',
    afterFirst === 1 &&
      afterRefresh === 2 &&
      refreshed !== hung &&
      afterReopen === 3 &&
      afterShared === 3 &&
      afterStale === 4,
    `桩收到的 env:wizard 次数：第一轮=${afterFirst} → 显式 refresh 后=${afterRefresh} → reopenGate 后=${afterReopen} → 普通调用后=${afterShared} → 超时后=${afterStale}（INFLIGHT_STALE_MS=${mod.INFLIGHT_STALE_MS}）；refreshed ${refreshed === hung ? '===' : '!=='} hung`,
    '1 / 2 / 3 / 3 / 4，且 refreshed !== hung',
  );
  // 新那一轮的结果照常生效（不是"发出去但没人接"）
  pending[pending.length - 1](gateState('blocked'));
  await stale;
  check(
    'K12b 兜底之后新那一轮的结果照常并进相位机（被作废的那次既不覆盖结论、也不清掉新的）',
    mod.wizard.value !== null &&
      mod.gatePhase.value === 'blocked' &&
      mod.gateVisible.value === true,
    `phase=${mod.gatePhase.value} visible=${mod.gateVisible.value} wizard=${mod.wizard.value ? '有' : 'null'}`,
    'blocked / true / 有',
  );
  void hung;
  void refreshed;
  void shared;
}

// ================================================================ M. VM 实测四条 + UI 间距（t20 新增）
/**
 * VM-01~VM-04 来自**用户真机实测**（最高等级证据），不是任何成员的推断：
 *   VM-01 nvm 装完 Node 不可用 → 下一步 npm 报 `No active Node.js version is configured. Run
 *         \`nvm install <version>\` then \`nvm use <version>\`.`；
 *   VM-02 安装器 GUI 静默阻塞、界面没说"去窗口里点完"；
 *   VM-03 完成判据与真实可用性不一致（Node 文件在、跑不出结果，却被判成完成）；
 *   VM-04 界面出现 `PATH` / `dsh.cmd` / `npx` 这类内部术语，而旧词表断言只扫渲染层、扫不到
 *         主进程产出的文案（覆盖面盲区）。
 *
 * 下面按「这些真机现象还会不会发生」组织：**能用离线夹具钉的钉在这里**（判据 / 词表 /
 * 原始错误落日志 / nvm 步骤形状 / 安装器形态与静默参数 / UI 间距），只有真机能验的在报告里
 * 显式列为未验证。VM-05 的间距断言见本段末尾。
 */

/** 报告里取一行（VM 段用；与 I 段的 `stepOf` 并列） */
const checkOf = (report, id) => report.checks.find((item) => item.id === id);

/** 冻结 §3.8 #22 的词表：界面文案里不许出现的内部术语（我这份是独立列的，含 VM-04 点名的三个） */
const FORBIDDEN_IN_UI = [
  'PATH',
  'dsh.cmd',
  'npx',
  'COMSPEC',
  'verbatim',
  'SHA256',
  'SHASUMS256',
  'NVM_SYMLINK',
  'NVM_HOME',
  'EPERM',
  'spawnSync',
  'ECONNRESET',
  'ETIMEDOUT',
];
function forbiddenInUi(text) {
  return FORBIDDEN_IN_UI.filter((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w.$])${escaped}(?![\\w$])`, word === 'verbatim' ? 'i' : '').test(
      text,
    );
  });
}

// ---- VM-03：Node 文件在、跑不出结果 —— 不许判成完成（拿真实输入驱动判定，不是读代码）
const vmProbeRaw = (over = {}) =>
  probeRaw({
    node: { ...NODE_OK, version: null, exitCode: 0, error: null },
    npm: {
      path: 'C:\\Program Files\\nodejs\\npm.cmd',
      version: null,
      exitCode: 1,
      error: 'No active version',
    },
    pnpm: {
      path: 'C:\\Program Files\\nodejs\\pnpm.cmd',
      version: null,
      exitCode: 1,
      error: 'No active version',
    },
    dsh: {
      kind: null,
      display: null,
      runs: false,
      version: null,
      exitCode: null,
      error: null,
      resolveError: '找不到 dsh: PATH 里没有 dsh.cmd，也没有 npx。请在设置里指定启动命令。',
    },
    ...over,
  });
const vmRaw = vmProbeRaw();
const vmReport = judgeEnvironment(vmRaw);
const vmState = judgeWizard(vmReport, []);
check(
  'M1 VM-03：Node 文件在、但 `node --version` 跑不出结果 → node-version=missing（不是黄灯），向导第一步是 todo、门禁 blocked、当前步骤 node',
  checkOf(vmReport, 'node').status === 'ok' &&
    checkOf(vmReport, 'node-version').status === 'missing' &&
    vmReport.counts.missing >= 1 &&
    vmState.steps[0].status === 'todo' &&
    vmState.gate === 'blocked' &&
    vmState.currentStepId === 'node',
  `node=${checkOf(vmReport, 'node').status} node-version=${checkOf(vmReport, 'node-version').status} missing=${vmReport.counts.missing} 第一步=${vmState.steps[0].status} gate=${vmState.gate} current=${vmState.currentStepId}`,
  'node=ok / node-version=missing / missing≥1 / 第一步=todo / gate=blocked / current=node',
);
check(
  'M2 VM-03 的文案：那两句必须是「找到了却跑不出结果」，不能笼统说「没装」（否则用户会去重装一个已经在那里的东西）',
  checkOf(vmReport, 'node-version').detail.includes('找到了 Node') &&
    checkOf(vmReport, 'node-version').detail.includes('没有任何输出') &&
    !checkOf(vmReport, 'node-version').detail.includes('没找到') &&
    checkOf(vmReport, 'pnpm').detail.includes('找到了 pnpm') &&
    !checkOf(vmReport, 'pnpm').detail.includes('没找到 pnpm'),
  `node-version=${show(checkOf(vmReport, 'node-version').detail)}｜pnpm=${show(checkOf(vmReport, 'pnpm').detail)}`,
  '两句都说「找到了…跑不出来」，都不说「没找到/没装」',
);

// ---- VM-04：主进程产出的用户可见文案不含内部术语（夹具里就带着 VM 现场那句原始报错）
const vmUiTexts = [];
for (const row of vmReport.checks) {
  vmUiTexts.push({ where: `${row.id}.detail`, text: String(row.detail ?? '') });
  vmUiTexts.push({ where: `${row.id}.fixHint`, text: String(row.fixHint ?? '') });
}
const vmUiHits = vmUiTexts.flatMap(({ where, text }) =>
  forbiddenInUi(text).map((word) => `${where}→${word}`),
);
check(
  'M3 VM-04：主进程产出的用户可见文案（每一项的 detail 与 fixHint，共 ' +
    `${vmUiTexts.length} 个字段）不含内部术语 —— 输入夹具里刻意带着 VM 现场那句含 PATH / dsh.cmd / npx 的原始报错`,
  vmUiHits.length === 0,
  vmUiHits.length ? vmUiHits.join('、') : '0 处命中',
  '0 处命中',
);
// ---- VM-04 的另一半：被界面撤下去的原始错误必须落进**日志**（细节留日志、结论给人话）
const vmTrouble = probeTroubleLines(vmRaw, vmReport).join('\n');
check(
  'M4 VM-04 的另一半：同一份夹具里，原始错误落进了日志行（dsh 定位原文含 PATH / dsh.cmd / npx、子进程错误串、零输出原因都在），而界面文案里一处都没有',
  vmTrouble.includes('PATH 里没有 dsh.cmd') &&
    vmTrouble.includes('No active version') &&
    vmTrouble.includes('没有任何输出'),
  `日志行 ${vmTrouble.split('\n').length} 条：${show(vmTrouble.slice(0, 300))}`,
  '日志里含 dsh 定位原文（带 PATH/dsh.cmd/npx）、npm 的错误串、零输出的原因',
);

// ---- VM-01 / VM-02：nvm 路径与安装器阻塞（离线静态钉子 + 纯函数夹具）
const vmInstallBody = methodBody(installerSource, 'private async installNodeWithNvm(');
const vmRunBody = methodBody(installerSource, 'private async runNvmCommand(');
const vmUseBody = methodBody(installerSource, 'private async useNvmVersion(');
const vmElevateBody = methodBody(installerSource, 'private async runElevated(');
const vmVerifyBody = methodBody(installerSource, 'private async verifyActiveNode(');
const vmLaunchBody = methodBody(installerSource, 'private launchInstaller(');
const vmFinishBody = methodBody(installerSource, 'private async finishDetached(');
const vmNails = [
  [
    'M5 VM-01：`nvm install` 与 `nvm use` 都真的执行、并且都按退出码分类失败（不吞退出码、不看"命令跑过了"就算成功）',
    vmInstallBody !== null &&
      vmInstallBody.includes("['install', versionArg]") &&
      vmInstallBody.includes('useNvmVersion(') &&
      vmRunBody !== null &&
      /outcome\.code\s*!==\s*0/.test(vmRunBody) &&
      vmRunBody.includes('classifyInstallFailure('),
  ],
  [
    'M6 VM-01：`nvm install` 之后再问一次 `nvm list`，并逐个版本比对（退出码说不清"装进来没有"）',
    vmInstallBody !== null &&
      vmInstallBody.includes('readNvmList(') &&
      vmInstallBody.includes('compareNodeVersions('),
  ],
  [
    'M7 VM-01：成败判据是 `<NVM_SYMLINK>\\node.exe --version` **与** `npm.cmd --version` **都**拿到版本号（两条实测，不是一条）',
    vmVerifyBody !== null &&
      countOf(vmVerifyBody, "'--version'") >= 2 &&
      vmVerifyBody.includes('NVM_SYMLINK') &&
      vmVerifyBody.includes('npm'),
  ],
  [
    'M8 VM-01：nvm 两步之前先重读系统环境，且注入的不只是 PATH（NVM_HOME / NVM_SYMLINK / NVM_DIR 都在白名单里）',
    (() => {
      if (vmInstallBody === null) return false;
      const refreshAt = vmInstallBody.indexOf('refreshProcessPathFromSystem()');
      const runAt = vmInstallBody.indexOf('runNvmCommand(');
      const names = /INJECTED_ENV_NAMES[^=]*=\s*\[([^\]]*)\]/.exec(installerSource);
      const injected = names ? names[1] : '';
      return (
        refreshAt >= 0 &&
        runAt > refreshAt &&
        injected.includes('NVM_HOME') &&
        injected.includes('NVM_SYMLINK') &&
        injected.includes('NVM_DIR')
      );
    })(),
  ],
  [
    'M9 VM-01 / F-02：符号链接权限那条路是"走通或如实拦下"——开发者模式判定 + 一次性提权（`-Verb RunAs`）+ 四种结果各自收场（**行为**，不只源码正则）',
    vmUseBody !== null &&
      vmUseBody.includes('readDeveloperMode(') &&
      vmUseBody.includes('await this.isElevated()') &&
      // 三种"没成功"不再堆在 useNvmVersion 里的 if 串，而是交给纯函数各自给类别
      /elevationFailure\(elevated\.kind\)/.test(vmUseBody) &&
      // 用户点了"不再等待"或提权进程还在跑 → 保持未确定（不是失败）
      /kind === 'stopped'[\s\S]{0,200}kind: 'detached'/.test(vmUseBody) &&
      vmElevateBody !== null &&
      vmElevateBody.includes('-Verb RunAs') &&
      // 行为：四种结果都能真跑出来（超时最先判、与"用户没允许"分开）
      installerModule.classifyElevationOutcome({
        code: 0,
        stdout: '{"ExitCode":0}',
        stderr: '',
        error: null,
        timedOut: false,
      }) === 'ok' &&
      installerModule.classifyElevationOutcome({
        code: 1,
        stdout: '',
        stderr: 'This operation was canceled by the user.',
        error: null,
        timedOut: false,
      }) === 'declined' &&
      installerModule.classifyElevationOutcome({
        code: null,
        stdout: '',
        stderr: '',
        error: null,
        timedOut: true,
      }) === 'timeout' &&
      installerModule.classifyElevationOutcome({
        code: 1,
        stdout: 'boom',
        stderr: '',
        error: null,
        timedOut: false,
      }) === 'failed' &&
      // 超时**不许**复用"没权限"的类别/文案（F-02 第 1 条）
      installerModule.elevationFailure('timeout').kind === 'elevation-timeout' &&
      installerModule.elevationFailure('timeout').message.includes('可能仍在系统里进行') &&
      installerModule.elevationFailure('timeout').kind !== 'symlink',
  ],
  [
    'M10 VM-01：拒绝提权之后的文案给出两条出路（开发者模式 / 管理员），不是一句"失败了"',
    (() => {
      const reason = classifyInstallFailure(
        'exit status 1: You do not have sufficient privileges to complete this operation. Please run this command as administrator.',
        null,
      );
      return (
        reason.kind === 'symlink' &&
        Boolean(reason.hint) &&
        reason.hint.includes('开发者模式') &&
        reason.hint.includes('管理员')
      );
    })(),
  ],
  [
    'M11 VM-02：安装器形态按真实资产给静默参数（Inno → `/VERYSILENT …`、NSIS → `/S`、认不出 → 空数组），且认不出时把"请到窗口里把向导点完"说给用户',
    JSON.stringify(
      installerModule.installerSilentArgs(
        installerModule.detectInstallerFlavor(
          Buffer.from('Inno Setup Setup Data (6.2.5)', 'latin1'),
        ),
      ),
    ) === JSON.stringify(['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-']) &&
      JSON.stringify(
        installerModule.installerSilentArgs(
          installerModule.detectInstallerFlavor(Buffer.from('NullsoftInst v3.09', 'latin1')),
        ),
      ) === JSON.stringify(['/S']) &&
      JSON.stringify(
        installerModule.installerSilentArgs(
          installerModule.detectInstallerFlavor(Buffer.from('just some bytes', 'latin1')),
        ),
      ) === JSON.stringify([]) &&
      vmLaunchBody !== null &&
      vmLaunchBody.includes('installerSilentArgs(flavor)') &&
      vmLaunchBody.includes('请到那个窗口里把向导点完'),
  ],
  [
    'M12 VM-01：`nvm list` 的解析（空清单 / 带 active / 只有 active / 垃圾输出）—— 真机原文由 `parseNvmListOutput` 负责认',
    JSON.stringify(installerModule.parseNvmListOutput('No installations recognized.')) ===
      JSON.stringify({ versions: [], active: null }) &&
      JSON.stringify(
        installerModule.parseNvmListOutput(
          '      24.21.0\n    * 22.12.0 (Currently using 64-bit executable)',
        ),
      ) === JSON.stringify({ versions: ['24.21.0', '22.12.0'], active: '22.12.0' }),
  ],
  [
    'M13 VM-01：开发者模式只认 `0x1` / `1`（AppModelUnlock），其它值不算开启 —— 只影响提示，不拦人',
    installerModule.isDeveloperModeEnabled('0x1') === true &&
      installerModule.isDeveloperModeEnabled('1') === true &&
      installerModule.isDeveloperModeEnabled('0x0') === false &&
      installerModule.isDeveloperModeEnabled('0x2') === false &&
      installerModule.isDeveloperModeEnabled(null) === false,
  ],
  [
    'M14 VM-01：「不再等待」之后安装器退出时补做 nvm 两步（不再停在"管理器装好但没有 active Node"）',
    vmFinishBody !== null &&
      vmFinishBody.includes('detachedNvmResume') &&
      vmFinishBody.includes('installNodeWithNvm('),
  ],
];
for (const [name, pass] of vmNails) check(name, pass, pass ? '满足' : '不满足', '满足');

// ---- VM-05：UI 间距（用户红框那三处的七个值 + 一条同批改的）钉成静态断言
/**
 * **这条只能保证"值没被改回去"，保证不了"在真机上看着舒服"** —— 观感类的最终判定只能由人
 * 在真机上看（真机复看清单写在 `docs/env-wizard-verification.md`）。
 * `ENV_WIZARD_CSS_FILE` 是给**变异实验**用的后门（把 CSS 复制一份、把某个值改回旧值，再指过来跑）。
 */
const CSS_FILE = process.env.ENV_WIZARD_CSS_FILE
  ? path.resolve(repoRoot, process.env.ENV_WIZARD_CSS_FILE)
  : path.join(repoRoot, 'src', 'renderer', 'styles.css');
/**
 * 各页面组件里的 `<style scoped>` 块（t48 样式分层之后，"页面自己的规则"不再堆在全局表里）。
 * 拼接顺序 = 全局表 + 组件块，和真实级联一致（组件块在后），`cssValueOf` 取最后一条也因此仍然对。
 * **递归扫** `src/renderer/**\/*.vue`（t67）：组件按「一处一目录」散在 `pages/*` / `gate/` /
 * `layout/` 下，把目录名写死在这里就等于"每搬一次目录都要改这个脚本"。
 */
function componentStyles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.vue')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) out.push(m[1]);
      }
    }
  };
  walk(path.join(repoRoot, 'src', 'renderer'));
  return out.join('\n');
}
// `ENV_WIZARD_CSS_FILE` 是给**变异实验**用的后门：它替换的是"整份样式"，所以指定它时**只读它**
// —— 想变异一条已经搬进组件的规则，把那一段也抄进你的副本即可（默认路径两层都读）。
const cssText = (
  (fs.existsSync(CSS_FILE) ? fs.readFileSync(CSS_FILE, 'utf8') : '') +
  (process.env.ENV_WIZARD_CSS_FILE ? '' : `\n${componentStyles()}`)
).replace(/\/\*[\s\S]*?\*\//g, '');
function cssValueOf(selector, property) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [...cssText.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  if (rules.length === 0) return null;
  const block = rules[rules.length - 1][1];
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(block);
  return match ? match[1].trim() : null;
}
const SPACING_PINS = [
  ['.wizard-progress > .btn-row', 'gap', '12px', '红框①：两按钮之间（原继承 .btn-row 的 8px）'],
  [
    '.wizard-progress > .btn-row',
    'margin-top',
    '12px',
    '红框①：按钮行与上方进度行之间（原来贴死）',
  ],
  ['.gate-card .env-op', 'margin-top', '12px', '红框②：卡片里输出面板与上方按钮行/结果行之间'],
  ['.gate-result .btn-row', 'margin-top', '12px', '卡片里"块 → 按钮行"统一节奏 12px（原 10px）'],
  ['.env-op-head', 'padding', '0 16px', '红框②：头行左右与 .panel-head / .env-row 同一条竖线'],
  ['.env-op-out', 'padding', '14px 16px', '红框③：输出正文与井边不贴（原 12px 14px）'],
  ['.env-op-out', 'font-size', 'var(--t-sm)', '红框③：输出正文一档字号（原 --t-xs）'],
  [
    '.env-op-out',
    'line-height',
    '1.8',
    '红框③：行盒 20.1px → 22.5px（规格 1.75，按 §0 的"可同比例微调"）',
  ],
  ['.env-op-summary', 'padding', '11px 16px', '结论行与头行/正文同一条竖线（原 10px 14px）'],
  ['.env-op-cmd', 'padding', '3px 9px', '文件名的砖不贴自己的边（原 3px 7px）'],
];
check(
  `M15 VM-05：间距/CSS 文件读得到（${path.relative(repoRoot, CSS_FILE)}）`,
  cssText.length > 1000,
  `读到 ${cssText.length} 字符（去掉注释后）`,
  '> 1000 字符',
);
for (const [selector, property, expected, why] of SPACING_PINS) {
  const actual = cssValueOf(selector, property);
  check(
    `M15 VM-05：${selector} { ${property}: ${expected} } —— ${why}`,
    actual === expected,
    `实际 ${show(actual)}`,
    expected,
  );
}
// 规格没写到的块间距，一律取既有页面的节奏（12px）；这条把"出处"也钉住，免得下次有人另取一个数
check(
  'M16 VM-05：门禁卡片里"块与块"的间距与既有页面节奏一致（12px：`.env { gap: 12px }` / `.gate-metabar { margin-top: 12px }` 都是 12px）',
  cssValueOf('.env', 'gap') === '12px' && cssValueOf('.gate-metabar', 'margin-top') === '12px',
  `.env{gap}=${show(cssValueOf('.env', 'gap'))}｜.gate-metabar{margin-top}=${show(cssValueOf('.gate-metabar', 'margin-top'))}`,
  '12px / 12px',
);
// 输出区的高度规格（视觉 §5.5：38px 标题行 / 220px 上限）没被这次改动碰过
check(
  'M17 VM-05：规格值没被顺手改掉 —— 输出区标题行 38px、正文上限 220px（视觉 §5.5）',
  cssValueOf('.env-op-head', 'height') === '38px' &&
    cssValueOf('.env-op-out', 'max-height') === '220px',
  `height=${show(cssValueOf('.env-op-head', 'height'))}｜max-height=${show(cssValueOf('.env-op-out', 'max-height'))}`,
  '38px / 220px',
);

// ================================================================ N. nvm v2 的 shim 模型（VM-11 / VM-12，验证侧独立反例）
/**
 * 为什么单独有这一段：t39 把 nvm 那条路从 **v1 的 `NVM_HOME` / `NVM_SYMLINK` 模型**改成
 * **v2 的 shim 模型**（自己被放进 PATH、当前版本在 `<root>\.nodejs`、版本装在 `<root>\installs`）。
 * 两套模型在客机上是互斥的事实，所以这里每一条都用**客机的真实状态**当输入去驱动编译产物
 * （不是读源码正则 —— 除了明确标注"静态"的那两条）。
 *
 * 客机事实（夹具的输入；来自船长用 guestcontrol 直接取的原文结构）：
 *   - nvm v2.0.0 装在 `…\AppData\Local\Author Software\nvm`；
 *     `HKCU\Environment` 里**没有** `NVM_HOME` / `NVM_SYMLINK`（只有 Path / TEMP / TMP / OneDrive）
 *   - 用户级 PATH 里有 `<root>` 与 `<root>\.nodejs`
 *   - `nvm env` → Status=on、Operating Mode=shim、Installed Versions Total=0、Default=not set
 *   - `nvm list` → `No versions installed.`
 *   - 界面曾经报的 `…\Local\Software\nvm\nodejs\node.exe` **不存在**（exit 3）；
 *     真实存在的是 `<root>\.nodejs\node.exe`（exit 1 + `No active Node.js version…`）
 *
 * **逐字 vs 重建**：`nvm env` 的整段是按官方两种排版重建的（客机那份是分节版，我们没拿到逐字字节）；
 * npm 那两行、`nvm list` 的两句、以及两条路径判定是逐字的。
 */
const processUtils = require(path.join(buildDir, 'main', 'process-utils.js'));
const VM11_INSTALLER_EXPORTS = [
  'parseNvmEnvOutput',
  'parseNvmListOutput',
  'deriveNvmModel',
  'nvmPreferenceKey',
  'parseNvmRegistryPreferences',
  'isInactiveNodeShimOutput',
  'hasNodeVersionOutput',
  'NodeInstaller',
];
const missingVm11Installer = VM11_INSTALLER_EXPORTS.filter(
  (name) => typeof installer[name] !== 'function',
);
const missingVm11Doctor = ['findNodePathWindows'].filter(
  (name) => typeof envDoctor[name] !== 'function',
);
check(
  'N0 VM-11：这一段要用的导出都在（被改名 / 挪走时这里先红，而不是几百行后的 TypeError）',
  missingVm11Installer.length === 0 && missingVm11Doctor.length === 0,
  `node-installer 缺 ${show(missingVm11Installer)}；env-doctor 缺 ${show(missingVm11Doctor)}`,
  '两处都齐',
);

const GUEST_ROOT = 'C:\\Users\\tester\\AppData\\Local\\Author Software\\nvm';
const GUEST_PATH_DIRS = [
  'C:\\Users\\tester\\AppData\\Local\\Programs\\Python\\Python312\\Scripts',
  GUEST_ROOT,
  `${GUEST_ROOT}\\.nodejs`,
  'C:\\Windows\\system32',
];
const GUEST_ENV = { Path: GUEST_PATH_DIRS.join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const GUEST_FILES = new Set([
  `${GUEST_ROOT}\\nvm.exe`,
  `${GUEST_ROOT}\\.nodejs\\node.exe`,
  `${GUEST_ROOT}\\.nodejs\\npm.cmd`,
  `${GUEST_ROOT}\\.nodejs\\npx.cmd`,
]);
const GUEST_GUESSED = 'C:\\Users\\tester\\AppData\\Local\\Software\\nvm\\nodejs\\node.exe';
const GUEST_SHIM_LINE =
  'No active Node.js version is configured. Run `nvm install <version>` then `nvm use <version>`.';
const GUEST_NVM_ENV = [
  'NVM For Windows',
  'Computer',
  '  Windows            : 11',
  '  Administrator      : No',
  '  Developer Mode     : Disabled',
  'Installation',
  '  Version            : v2.0.0',
  `  Path               : ${GUEST_ROOT}`,
  'Version Management',
  '  Status             : on',
  '  Operating Mode     : shim',
  'Installed Versions',
  '  Total              : 0 (0 MB)',
  '  Default            : not set',
  `  Path               : ${GUEST_ROOT}\\installs`,
  'Download Sources',
  '  Node.js            : https://nodejs.org/dist',
  '  npm                : https://registry.npmjs.org (unreachable)',
].join('\n');

const guestEnvReport = installer.parseNvmEnvOutput(GUEST_NVM_ENV);
eq(
  'N1 VM-11：客机那份分节 `nvm env` 的每一项都读得出来，两个 `Path` 不混（Installation→程序根、Installed Versions→版本目录）',
  [
    guestEnvReport.version,
    guestEnvReport.status,
    guestEnvReport.mode,
    guestEnvReport.versionsTotal,
    guestEnvReport.defaultVersion,
    guestEnvReport.programRoot,
    guestEnvReport.installsDir,
    guestEnvReport.nodeMirror,
    guestEnvReport.npmMirror,
  ],
  [
    'v2.0.0',
    'on',
    'shim',
    0,
    null,
    GUEST_ROOT,
    `${GUEST_ROOT}\\installs`,
    'https://nodejs.org/dist',
    'https://registry.npmjs.org (unreachable)',
  ],
);
const flatEnvReport = installer.parseNvmEnvOutput(
  [
    'NVM For Windows',
    '├─ Version            : v2.0.0-alpha.1',
    '├─ Status             : on',
    '├─ Operating Mode     : shim',
    '└─ Installed Versions : 4',
  ].join('\n'),
);
eq(
  'N2 VM-11：官方那份扁平排版（带树线、只有一条版本数）也认；里面没有版本目录时**不许**把别的东西塞进 installsDir',
  [
    flatEnvReport.version,
    flatEnvReport.mode,
    flatEnvReport.versionsTotal,
    flatEnvReport.installsDir,
  ],
  ['v2.0.0-alpha.1', 'shim', 4, null],
);

eq(
  'N3 VM-11：`nvm list` 的 v2 单行形状（星号 = active、空格分开一串）/ v1 逐行 / 两种空清单文案都认',
  [
    installer.parseNvmListOutput('* 24.1.0    (default)  22.14.0  20.19.1'),
    installer.parseNvmListOutput(
      '      24.21.0\n    * 22.12.0 (Currently using 64-bit executable)',
    ),
    installer.parseNvmListOutput('No versions installed.'),
    installer.parseNvmListOutput('No installations recognized.'),
  ],
  [
    { versions: ['24.1.0', '22.14.0', '20.19.1'], active: '24.1.0' },
    { versions: ['24.21.0', '22.12.0'], active: '22.12.0' },
    { versions: [], active: null },
    { versions: [], active: null },
  ],
);

const guestModel = installer.deriveNvmModel({
  exe: `${GUEST_ROOT}\\nvm.exe`,
  env: GUEST_ENV,
  report: guestEnvReport,
  pathDirs: GUEST_PATH_DIRS,
  exists: (file) => GUEST_FILES.has(file),
});
eq(
  'N4 VM-11①：v2 的模型从**真实证据**推出来（根 / shim / 版本目录 / 当前版本目录），而 env 里根本没有 NVM_HOME 与 NVM_SYMLINK',
  [
    'NVM_HOME' in GUEST_ENV,
    'NVM_SYMLINK' in GUEST_ENV,
    guestModel === null ? null : guestModel.root,
    guestModel === null ? null : guestModel.mode,
    guestModel === null ? null : guestModel.installsDir,
    guestModel === null ? null : guestModel.activeDir,
    guestModel !== null && guestModel.evidence.length >= 3,
  ],
  [false, false, GUEST_ROOT, 'shim', `${GUEST_ROOT}\\installs`, `${GUEST_ROOT}\\.nodejs`, true],
);
const pathOnlyModel = installer.deriveNvmModel({
  exe: null,
  env: { Path: `${GUEST_ROOT};${GUEST_ROOT}\\.nodejs` },
  report: null,
  pathDirs: [GUEST_ROOT, `${GUEST_ROOT}\\.nodejs`],
  exists: (file) => GUEST_FILES.has(file),
});
eq(
  'N4b VM-11①：只有 PATH 里的那两条（`nvm.exe` 没探到、`nvm env` 也没读到）时，仍然推得出根目录与 `.nodejs`（模式按磁盘上的 `.nodejs` 推）',
  [
    pathOnlyModel === null ? null : pathOnlyModel.root,
    pathOnlyModel === null ? null : pathOnlyModel.activeDir,
    pathOnlyModel === null ? null : pathOnlyModel.mode,
  ],
  [GUEST_ROOT, `${GUEST_ROOT}\\.nodejs`, 'shim'],
);
const noEvidenceModel = installer.deriveNvmModel({
  exe: null,
  env: {},
  report: null,
  pathDirs: [],
  exists: () => false,
});
const symlinkOnlyModel = installer.deriveNvmModel({
  exe: null,
  env: { NVM_SYMLINK: 'D:\\Node\\nodejs' },
  report: null,
  pathDirs: [],
  exists: () => false,
});
eq(
  'N4c VM-12：没有任何真实证据时返回 null（**不许**凭空推一个根目录）；只有 NVM_SYMLINK 时也是 null（软链目录不是管理器的根）',
  [noEvidenceModel, symlinkOnlyModel],
  [null, null],
);
const v1Root = 'D:\\Nvm\\nvm';
const v1Model = installer.deriveNvmModel({
  exe: null,
  env: { NVM_HOME: v1Root, NVM_SYMLINK: 'D:\\Node\\nodejs', Path: `${v1Root};D:\\Node\\nodejs` },
  report: null,
  pathDirs: [v1Root, 'D:\\Node\\nodejs'],
  exists: (file) => file === `${v1Root}\\nvm.exe` || file === 'D:\\Node\\nodejs\\node.exe',
});
eq(
  'N4d VM-11①的另一半：真有 NVM_HOME / NVM_SYMLINK 的 v1 风格机器照旧认（link 模式、当前版本取软链目录），没有写死排斥',
  [
    v1Model === null ? null : v1Model.root,
    v1Model === null ? null : v1Model.mode,
    v1Model === null ? null : v1Model.activeDir,
  ],
  [v1Root, 'link', 'D:\\Node\\nodejs'],
);
eq(
  'N4e VM-11①：「这条 Node 是谁管的」同样按**路径**判（客机 `…\\Author Software\\nvm\\.nodejs\\node.exe` 在完全没有 NVM_HOME / NVM_SYMLINK 的环境里也算 nvm），volta 之类仍然不给 nvm',
  [
    nodeOwner(`${GUEST_ROOT}\\.nodejs\\node.exe`, {}),
    nodeOwner(`${GUEST_ROOT}\\.nodejs\\node.exe`, GUEST_ENV),
    nodeOwner('C:\\Users\\tester\\.volta\\bin\\node.exe', GUEST_ENV),
    nodeOwner('C:\\Program Files\\nodejs\\node.exe', GUEST_ENV),
  ],
  ['nvm', 'nvm', 'unknown', 'system'],
);

eq(
  'N5 VM-11：v2 的注册表偏好键名从**真根目录**推（`…\\Author Software\\nvm` → `HKCU\\Software\\Author Software\\Preferences\\nvm`），值也解析得出来',
  (() => {
    const key = installer.nvmPreferenceKey(GUEST_ROOT);
    const prefs = installer.parseNvmRegistryPreferences(
      [
        'HKEY_CURRENT_USER\\Software\\Author Software\\Preferences\\nvm',
        '    Enabled              REG_DWORD    0x1',
        `    InstallRoot          REG_SZ       ${GUEST_ROOT}\\installs`,
        '    ActiveVersion        REG_SZ       not set',
        '    OperatingMode        REG_SZ       shim',
      ].join('\r\n'),
    );
    return [key, prefs.installsDir, prefs.mode, prefs.status, prefs.defaultVersion];
  })(),
  [
    'HKCU\\Software\\Author Software\\Preferences\\nvm',
    `${GUEST_ROOT}\\installs`,
    'shim',
    'on',
    null,
  ],
);

// VM-12：界面上报的路径必须是真探测到的（推测出来的那条不在磁盘上，永远不许上屏）。
// 注意：**推测的候选可以留在候选表里**（冻结文档允许），判据是"它不存在时不许被返回"。
const guestFound = envDoctor.findNodePathWindows(GUEST_ENV, 'C:\\Users\\tester', (file) =>
  GUEST_FILES.has(file),
);
const guestNothing = envDoctor.findNodePathWindows(
  { Path: 'C:\\Ghost\\nvm;C:\\Ghost\\nvm\\.nodejs', PATHEXT: '.EXE' },
  'C:\\Users\\tester',
  () => false,
);
const guestCandidates = processUtils.windowsBinCandidates(GUEST_ENV, 'C:\\Users\\tester');
eq(
  'N6 VM-12：客机上只认真正存在的那条 `<root>\\.nodejs\\node.exe`；一条不存在的 PATH 目录（连名字都像版本管理器）不许被当成 node 报上屏，而是返回 null',
  [
    guestFound,
    guestFound === GUEST_GUESSED,
    guestNothing,
    guestCandidates.includes(`${GUEST_ROOT}\\.nodejs`),
  ],
  [`${GUEST_ROOT}\\.nodejs\\node.exe`, false, null, true],
);

// 引擎侧：「管理器在但零版本」这条失败给的是**可执行动作 + 可诊断日志**，不是「你自己去终端」
const shimReason = classifyInstallFailure(GUEST_SHIM_LINE, 1);
check(
  'N7 VM-11②：shim 那句「没有激活任何版本」被判成 nvm-inactive，且**引擎侧**给出的出路里没有一个字让用户自己去终端（这是"应用自己装版本"这条要求的地基）',
  shimReason.kind === 'nvm-inactive' &&
    !/终端/.test(String(shimReason.message) + String(shimReason.hint)) &&
    !/自己打开终端|到终端里去/.test(installerSource) &&
    installer.isInactiveNodeShimOutput(GUEST_SHIM_LINE) &&
    !installer.hasNodeVersionOutput(GUEST_SHIM_LINE) &&
    installer.hasNodeVersionOutput('v24.21.0\n'),
  `kind=${shimReason.kind}｜message=${show(shimReason.message)}｜hint=${show(shimReason.hint)}`,
  'nvm-inactive + 两处文案都不含「终端」',
);

// ---- N7b/N7c/N7d：**界面可见文案**不许把应用能做的事推给用户（F-05 / VM-13）
// 第六轮（t44）把这里原本的一条 observe() 附注换成了真断言 —— 第五轮判出的 F-05 已经被 t43 修掉，
// 修好之后就该由断言守着，而不是靠一句备注。这一组用的是**行为**（真喂客机状态、看判定输出），
// 不是读源码正则；词表与自检里那份各自独立写，互为对照。
const PUNTING_PHRASES = [
  '先在终端',
  '先在命令行',
  '到终端里去',
  '自己打开终端',
  '自己去终端',
  '自己到终端',
  '自行在终端',
  '手动到终端',
  '手动在终端',
  '你自己去敲',
  '自己回终端',
];
const guestNodePath = `${GUEST_ROOT}\\.nodejs\\node.exe`;
const guestIsFromVm = envDoctor.looksVersionManagerNode(guestNodePath, GUEST_ENV);
const guestReport = judgeEnvironment(
  probeRaw({
    node: { path: guestNodePath, version: null, exitCode: 1, error: null },
    npm: { path: null, version: null, exitCode: 1, error: null },
    pnpm: { path: null, version: null, exitCode: 1, error: null },
    nodeFromVersionManager: guestIsFromVm,
  }),
);
const guestVisible = [];
for (const row of guestReport.checks) {
  guestVisible.push(`${row.id}.detail=${row.detail}`);
  if (row.fixHint) guestVisible.push(`${row.id}.fixHint=${row.fixHint}`);
}
for (const plan of guestReport.plans) {
  guestVisible.push(`${plan.action}.note=${plan.note}`);
  guestVisible.push(`${plan.action}.display=${plan.display}`);
}
const guestPunts = guestVisible.filter((text) =>
  PUNTING_PHRASES.some((phrase) => text.includes(phrase)),
);
const guestVersionRow = guestReport.checks.find((row) => row.id === 'node-version');
const guestWizard = judgeWizard(guestReport, []);
const guestNodeStep = guestWizard.steps.find((step) => step.id === 'node');

eq(
  'N7b VM-13①（行为）：客机那份 `.nodejs\\node.exe` 走真实链路被认成「版本管理器管的」；`D:\\nvm-tools\\node.exe` 这种只是名字像的不误判，系统 Node 也不算',
  [
    guestIsFromVm,
    envDoctor.looksVersionManagerNode('D:\\nvm-tools\\node.exe', {}),
    envDoctor.looksVersionManagerNode('C:\\Program Files\\nodejs\\node.exe', {}),
    // 真有 NVM_SYMLINK 的 v1 机器：软链目录下的那份也算版本管理器管的
    envDoctor.looksVersionManagerNode('D:\\Node\\nodejs\\node.exe', {
      NVM_SYMLINK: 'D:\\Node\\nodejs',
    }),
  ],
  [true, false, false, true],
);
check(
  'N7c VM-13②（行为）：客机状态下**所有用户可见文案**（8 项 checks 的 detail + fixHint、计划的 note + display）里没有一条把用户打发去终端 —— 而门禁第一步的事实行（`step.detail`，EnvGate 渲染的就是它）说的是"版本管理器在、零版本"这一种状态',
  guestPunts.length === 0 &&
    guestVersionRow?.status === 'missing' &&
    String(guestVersionRow.detail).includes('版本管理器') &&
    String(guestVersionRow.detail).includes(guestNodePath) &&
    // 出路是应用内那条路（门禁第一步的两个安装选项），命令行只作为备选写在后半句
    String(guestVersionRow.fixHint).includes('安装 Node.js') &&
    !PUNTING_PHRASES.some((phrase) => String(guestNodeStep?.detail ?? '').includes(phrase)) &&
    guestNodeStep?.detail === guestVersionRow.detail &&
    guestWizard.gate === 'blocked' &&
    guestWizard.currentStepId === 'node' &&
    guestNodeStep?.status === 'todo',
  `命中 ${guestPunts.length} 条${guestPunts.length ? `：${show(guestPunts)}` : ''}｜versionRow.detail=${show(guestVersionRow?.detail)}｜fixHint=${show(guestVersionRow?.fixHint)}｜gate=${guestWizard.gate}/${guestWizard.currentStepId}`,
  '0 条命中 + detail 说中「版本管理器」+ fixHint 指向应用内「安装 Node.js」+ 门禁 blocked/node',
);
check(
  'N7d VM-13③（自证）：同一套词表对**第五轮判出 F-05 时那句原文**必须命中（否则这一组断言可能是空转）',
  PUNTING_PHRASES.some((phrase) =>
    '版本管理器还没选中一个版本时也是这个样子（先在终端里选一个版本，或重装官方 Node）'.includes(
      phrase,
    ),
  ),
  show(
    PUNTING_PHRASES.filter((phrase) =>
      '版本管理器还没选中一个版本时也是这个样子（先在终端里选一个版本，或重装官方 Node）'.includes(
        phrase,
      ),
    ),
  ),
  '至少命中「先在终端」',
);
// 「这个运行环境不允许起子进程」是**真的只能用户做**（我们的进程做不到），所以那里保留"自己确认"，
// 但必须先给应用内那条路（点「重新检测」）—— 这一条钉住 t43 对那处例外的处理方式没有退化。
const blockedHint = String(
  judgeEnvironment(
    probeRaw({
      node: {
        path: 'C:\\Program Files\\nodejs\\node.exe',
        version: null,
        exitCode: null,
        error: 'spawn EPERM',
      },
    }),
  ).checks.find((row) => row.id === 'node-version')?.fixHint ?? '',
);
check(
  'N7e VM-13④：真的只能用户做的例外（起不了子进程）里，应用内那条路（点「重新检测」）必须排在"自己到终端确认"之前',
  blockedHint.includes('重新检测') &&
    blockedHint.includes('终端') &&
    blockedHint.indexOf('重新检测') < blockedHint.indexOf('终端'),
  show(blockedHint),
  '含「重新检测」且它在「终端」之前',
);

// 「每一步都留证据」：命令 / 退出码 / stdout / stderr（空的那路写「（空）」）—— 行为验证，不是读代码
{
  const { installer: logInstaller, logs } = makeInstaller(async () => null);
  logInstaller.logNvmStep(
    'nvm install',
    ['install', '24.21.0'],
    1,
    'Downloading Node.js 24.21.0…',
    '',
  );
  const line = logs.length > 0 ? logs[0] : '';
  check(
    'N8 VM-11④：每一条 nvm 命令的证据行真的落进日志通道（命令 / 退出码 / stdout / stderr，空的那路写「（空）」）',
    line.includes('nvm install 24.21.0') &&
      line.includes('退出码 1') &&
      line.includes('Downloading Node.js 24.21.0') &&
      line.includes('stderr：（空）'),
    show(line),
    '含 命令 / 退出码 1 / stdout 原文 / stderr：（空）',
  );
}
// shim 模式（v2）不请求提权：静态顺序检查 —— 先看模式，再决定要不要弹 UAC
const vmUseSlice = methodBody(installerSource, 'private async useNvmVersion(');
check(
  'N9 VM-11⑤（静态）：shim 模式那条分支排在 `runElevated` 之前且不请求提权（v2 无符号链接、官方说明不需要管理员）',
  vmUseSlice !== null &&
    vmUseSlice.indexOf("model.mode === 'shim'") >= 0 &&
    vmUseSlice.indexOf("model.mode === 'shim'") < vmUseSlice.indexOf('await this.runElevated(') &&
    vmUseSlice.includes('不请求提权'),
  vmUseSlice === null
    ? '切片拿不到'
    : `shim 分支在 ${vmUseSlice.indexOf("model.mode === 'shim'")}、runElevated 在 ${vmUseSlice.indexOf('await this.runElevated(')}`,
  'shim 分支在前且写明不请求提权',
);

// ================================================================ O. t29 的归属与档位（t4 加：VM-14 / VM-15 / 需求 §12#29–34）
/**
 * 这一段是**t4（独立验证）自己的反例**，与 `test/selftest.ts` 的 18d 段是两套夹具（那边是实现者写的）。
 *
 * 三件事：
 *  1. `detectNodeOwner` 的**四类输入**（nvm v2 shim / v1 link / 系统直装 / 未知）各来一条 ——
 *     注意这里是带 `model` 与 `msiInstallPath` 驱动它的（C1–C8 那几条只喂了路径与环境变量）；
 *  2. `decideNodePlan` 的方法跟随归属 / 档位跟随当前档 / 换档只在显式选档时发生；
 *  3. 判据自己**不猜**（清单里没有那个版本 → null；当前版本读不到 → 交还给用户选）。
 *
 * 夹具里那份版本清单是**合成的**（把"同一档里还有更新的版本"摆出来）：`v26.x` 是 current、
 * `v24.x` 是 Krypton；真实抓取的那两条（A 段 `REAL_INDEX_TEXT`）不足以摆出"同档内有更新"。
 */
const T29_RELEASES = [
  { version: 'v26.9.0', lts: false, files: [] },
  { version: 'v24.21.0', lts: 'Krypton', files: [] },
  { version: 'v26.5.0', lts: false, files: [] },
  { version: 'v24.19.0', lts: 'Krypton', files: [] },
];
const missingT29Exports = ['decideNodePlan', 'nodeChannelOfVersion', 'nodePlanDirection'].filter(
  (name) => typeof installer[name] !== 'function',
);
check(
  'O0 t29：这一段要用的导出都在（被改名 / 挪走时这里先红，而不是后面一个 TypeError）',
  missingT29Exports.length === 0,
  `node-installer 缺 ${show(missingT29Exports)}`,
  '三个导出都在',
);

/** 「归属 + 有没有正面证据」一起看：只有"有证据"才算得出结论，兜底默认不算 */
const ownerWithEvidence = (input) => {
  const result = detectNodeOwner(input);
  const hasEvidence = Array.isArray(result.evidence) && result.evidence.length > 0;
  return `${result.owner}/${hasEvidence ? '有证据' : '没证据'}`;
};
const NVM_MODEL_V2 = {
  root: 'D:\\Nvm\\nvm',
  mode: 'shim',
  installsDir: 'D:\\Nvm\\nvm\\installs',
  activeDir: 'D:\\Nvm\\nvm\\.nodejs',
};
const NVM_MODEL_V1 = {
  root: 'D:\\Nvm\\nvm',
  mode: 'link',
  installsDir: 'D:\\Nvm\\nvm',
  activeDir: 'D:\\Node\\nodejs',
};
eq(
  'O1 VM-14 第①类（nvm v2 shim）：模型给出的版本目录 / 当前版本目录都判 nvm —— 环境里**一个 NVM_* 变量都没有**也算（客机上就是这样）',
  [
    ownerWithEvidence({
      nodePath: 'D:\\Nvm\\nvm\\installs\\v24.19.0\\node.exe',
      env: {},
      model: NVM_MODEL_V2,
      msiInstallPath: null,
    }),
    ownerWithEvidence({
      nodePath: 'D:\\Nvm\\nvm\\.nodejs\\node.exe',
      env: {},
      model: NVM_MODEL_V2,
      msiInstallPath: null,
    }),
  ],
  ['nvm/有证据', 'nvm/有证据'],
);
eq(
  'O2 VM-14 第②类（nvm v1 link）：`NVM_SYMLINK` 那份与版本管理器根目录下那份都判 nvm（link 模式照样认，没有写死只认 v2）',
  [
    ownerWithEvidence({
      nodePath: 'D:\\Node\\nodejs\\node.exe',
      env: {},
      model: NVM_MODEL_V1,
      msiInstallPath: null,
    }),
    ownerWithEvidence({
      nodePath: 'D:\\Nvm\\nvm\\v22.0.0\\node.exe',
      env: {},
      model: NVM_MODEL_V1,
      msiInstallPath: null,
    }),
  ],
  ['nvm/有证据', 'nvm/有证据'],
);
eq(
  'O3 VM-14 第③类（系统直装）：官方默认安装位（`%ProgramFiles%\\nodejs` / `%ProgramFiles(x86)%\\nodejs`）与**安装包自己写下的目录**（`InstallPath`）都判 system —— system 必须有正面证据',
  [
    ownerWithEvidence({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      env: { ProgramFiles: 'C:\\Program Files' },
      model: null,
      msiInstallPath: null,
    }),
    ownerWithEvidence({
      nodePath: 'C:\\Program Files (x86)\\nodejs\\node.exe',
      env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      model: null,
      msiInstallPath: null,
    }),
    ownerWithEvidence({
      nodePath: 'D:\\MSINode\\node.exe',
      env: { ProgramFiles: 'C:\\Program Files' },
      model: null,
      msiInstallPath: 'D:\\MSINode',
    }),
  ],
  ['system/有证据', 'system/有证据', 'system/有证据'],
);
eq(
  'O4 VM-14 第④类（未知）：`D:\\nvm-tools\\node.exe`（名字像 nvm、但不是独立的一段目录名）、别的版本管理器、以及**任何没有正面证据的自定义目录**一律 unknown —— 这条正是 VM-14 的成因（原来这里会兜底成"系统装的"）',
  [
    ownerWithEvidence({
      nodePath: 'D:\\nvm-tools\\node.exe',
      env: {},
      model: null,
      msiInstallPath: null,
    }),
    ownerWithEvidence({
      nodePath: 'C:\\Users\\x\\AppData\\Local\\fnm\\node.exe',
      env: {},
      model: null,
      msiInstallPath: null,
    }),
    ownerWithEvidence({
      nodePath: 'C:\\Users\\x\\.volta\\bin\\node.exe',
      env: {},
      model: null,
      msiInstallPath: null,
    }),
    ownerWithEvidence({
      nodePath: 'D:\\nvm-tools\\node.exe',
      env: {},
      model: NVM_MODEL_V2,
      msiInstallPath: null,
    }),
  ],
  ['unknown/有证据', 'unknown/有证据', 'unknown/有证据', 'unknown/有证据'],
);

/** 一次纯判定：默认是"nvm 管的机器、更新、当前 current" */
const t29Plan = (over = {}) =>
  installer.decideNodePlan({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
    releases: T29_RELEASES,
    elevated: false,
    ...over,
  });
eq(
  'O5 VM-14（方法跟随归属）：nvm → nvm；system → direct；归属未知且**找到了一份 Node** → needChoice=choose-method（一条都不预选）；归属未知且一份都没找到 → 有模型走 nvm、没模型才落到 direct',
  [
    t29Plan().method,
    t29Plan({ owner: 'system' }).method,
    t29Plan({ owner: 'unknown' }).needChoice,
    t29Plan({ owner: 'unknown', nodeFound: false, mode: 'install' }).method,
    t29Plan({ owner: 'unknown', nodeFound: false, mode: 'install', nvmPresent: false }).method,
  ],
  ['nvm', 'direct', 'choose-method', 'nvm', 'direct'],
);
eq(
  'O6 VM-15（档位跟随当前档）：current 的机器目标还是 current（v26.5.0 → v26.9.0）、lts 的机器目标还是 lts（v24.19.0 → v24.21.0），省略档位时 switchesChannel 恒 false',
  [
    `${t29Plan({ currentVersion: 'v26.5.0' }).channel}/${t29Plan({ currentVersion: 'v26.5.0' }).release.version}`,
    `${t29Plan({ currentVersion: 'v24.19.0' }).channel}/${t29Plan({ currentVersion: 'v24.19.0' }).release.version}`,
    t29Plan({ currentVersion: 'v26.5.0' }).switchesChannel,
  ],
  ['current/v26.9.0', 'lts/v24.21.0', false],
);
eq(
  'O7 VM-15（换档只由显式选档产生）：current 的机器显式要 lts → switchesChannel=true、direction=**older**（"目标低于当前"在计划里就判得出来，界面不用自己比版本号）；同档显式选则 switchesChannel=false',
  [
    [
      t29Plan({ requestChannel: 'lts' }).switchesChannel,
      t29Plan({ requestChannel: 'lts' }).direction,
      t29Plan({ requestChannel: 'lts' }).release.version,
    ],
    [
      t29Plan({ requestChannel: 'current' }).switchesChannel,
      t29Plan({ requestChannel: 'current' }).direction,
    ],
  ],
  [
    [true, 'older', 'v24.21.0'],
    [false, 'same'],
  ],
);
check(
  'O7b VM-15：**省略档位**（跟随）永不产生 direction=older —— 四个当前版本逐一驱动（"看起来像降级"只能来自显式换档）',
  ['v26.9.0', 'v26.5.0', 'v24.21.0', 'v24.19.0'].every(
    (version) => t29Plan({ currentVersion: version }).direction !== 'older',
  ),
  ['v26.9.0', 'v26.5.0', 'v24.21.0', 'v24.19.0']
    .map((version) => `${version}→${t29Plan({ currentVersion: version }).direction}`)
    .join(' '),
  '四条 direction 都不是 older',
);
eq(
  'O8 设计默认只留给 install：install 且省略档位 = 最新稳定版（lts）；update 且省略档位 = 当前档（current 机器上不是 lts）',
  [
    `${t29Plan({ mode: 'install' }).channel}/${t29Plan({ mode: 'install' }).release.version}`,
    t29Plan().channel,
  ],
  ['lts/v24.21.0', 'current'],
);
eq(
  'O9 VM-14（不重装管理器）：`installsManager` 只在"走 nvm 且机器上已经有可辨认的管理器"时为 false；nvm 没管理器 → true；直装 → true',
  [
    t29Plan().installsManager,
    t29Plan({ nvmPresent: false }).installsManager,
    t29Plan({ owner: 'system' }).installsManager,
  ],
  [false, true, true],
);
eq(
  'O10 VM-15（不猜档位）：当前版本读不到 → needChoice=choose-channel 且 release=null（那个占位的设计默认档**不许**被当成目标档位去算版本）',
  [
    t29Plan({ currentVersion: null }).needChoice,
    t29Plan({ currentVersion: null }).release,
    t29Plan({ currentVersion: null }).direction,
  ],
  ['choose-channel', null, null],
);
eq(
  'O11 判据自己也不猜：官方清单里没有这个已装版本 → 档位 null（不是 current）；版本比较认不出当前版本时 direction=null',
  [
    installer.nodeChannelOfVersion(T29_RELEASES, 'v25.0.0'),
    installer.nodeChannelOfVersion(T29_RELEASES, 'v26.5.0'),
    installer.nodePlanDirection('v24.21.0', null),
  ],
  [null, 'current', null],
);
eq(
  'O12 三个例外都要**用户显式点名 + 并存风险句**：归属 nvm 却点名 direct（非提权）被拒；归属 unknown 点名 direct 放行但带并存风险句；同一句话是常量（§7.9 第 4 条原样）',
  [
    typeof t29Plan({ requestMethod: 'direct' }).refuse?.message,
    t29Plan({ owner: 'unknown', requestMethod: 'direct' }).coexistWarning ===
      installer.NODE_COEXIST_WARNING,
    installer.NODE_COEXIST_WARNING.includes('会有两份 Node'),
  ],
  ['string', true, true],
);

// ---------------------------------------------------------------- O13~O15：r2（t9 的修复，t12 再验证）
/**
 * 需求 §12#32② 是一条**无条件**断言：`direction === 'older' ⟹ switchesChannel === true`。
 * 上一轮审查在 648 组合里数出 36 个反例 —— 都是「install + 设计默认档正好跨了她当时的档」那一支
 * （装了当前版的机器上点「换一个 Node」是一次降到稳定版；旧实现里 `switchesChannel` 只在
 * 请求显式带档位时才算，于是 `older` 而 `switchesChannel=false`：界面说不出这是换档）。
 *
 * 所以这里**不挑输入**，直接穷举整张网（mode×owner×nvmPresent×nodeFound×currentVersion×
 * requestChannel×requestMethod = 2×3×2×2×3×3×3 = 648）。
 */
const R2_RELEASES = [
  { version: 'v26.9.0', lts: false, files: [] },
  { version: 'v24.21.0', lts: 'Krypton', files: [] },
  { version: 'v24.19.0', lts: 'Krypton', files: [] },
];
const r2Plan = (over = {}) =>
  installer.decideNodePlan({
    mode: 'update',
    owner: 'nvm',
    nvmPresent: true,
    nodeFound: true,
    currentVersion: 'v26.9.0',
    releases: R2_RELEASES,
    elevated: false,
    ...over,
  });
const r2Violations = [];
let r2Total = 0;
for (const mode of ['update', 'install']) {
  for (const owner of ['nvm', 'system', 'unknown']) {
    for (const nvmPresent of [true, false]) {
      for (const nodeFound of [true, false]) {
        for (const currentVersion of ['v26.9.0', 'v24.19.0', null]) {
          for (const requestChannel of [undefined, 'current', 'lts']) {
            for (const requestMethod of [undefined, 'nvm', 'direct']) {
              const decision = installer.decideNodePlan({
                mode,
                owner,
                nvmPresent,
                nodeFound,
                currentVersion,
                releases: R2_RELEASES,
                elevated: false,
                requestChannel,
                requestMethod,
              });
              r2Total += 1;
              if (decision.direction === 'older' && decision.switchesChannel !== true) {
                r2Violations.push(
                  `${mode}/${owner}/nvm=${nvmPresent}/found=${nodeFound}/当前=${currentVersion ?? 'null'}/档=${requestChannel ?? '跟随'}/方法=${requestMethod ?? '跟随'}`,
                );
              }
            }
          }
        }
      }
    }
  }
}
check(
  'O13 VM-15（r2 / §12#32②）：穷举 648 组合，`direction === "older" ⟹ switchesChannel === true` **零反例**（上一轮审查在这张网里数出 36 个）',
  r2Total === 648 && r2Violations.length === 0,
  `${r2Total} 组合、反例 ${r2Violations.length} 条${r2Violations.length > 0 ? ` → ${r2Violations.slice(0, 3).join('；')}` : ''}`,
  '648 组合 / 反例 0',
);
const r2Reachable = r2Plan({ mode: 'install' });
eq(
  'O14 VM-15（r2 的**可达路径**）：EnvGate 第三步「换一个 Node」（install + 省略档位）在装了 current 的机器上 → 目标档 lts、目标 v24.21.0、direction=older、switchesChannel=true（界面据此说「换成稳定版 / 版本从 v26.9.0 降到 v24.21.0」）',
  [
    `${r2Reachable.channel}/${r2Reachable.release.version}`,
    r2Reachable.direction,
    r2Reachable.switchesChannel,
  ],
  ['lts/v24.21.0', 'older', true],
);
eq(
  'O15 r2 没带坏：当前档位判不出来（currentVersion=null）→ needChoice=choose-channel、release=null、switchesChannel=false（不把"不知道"说成换档）；显式换档仍可判定（current 机器显式要 lts → older + true，显式同档 → false）',
  [
    [
      r2Plan({ currentVersion: null }).needChoice,
      r2Plan({ currentVersion: null }).release,
      r2Plan({ currentVersion: null }).switchesChannel,
    ],
    [
      r2Plan({ requestChannel: 'lts' }).direction,
      r2Plan({ requestChannel: 'lts' }).switchesChannel,
      r2Plan({ requestChannel: 'current' }).switchesChannel,
    ],
  ],
  [
    ['choose-channel', null, false],
    ['older', true, false],
  ],
);

// ================================================================ 输出
let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name}`);
  if (!item.pass) {
    console.log(`       实际：${item.actual}`);
    console.log(`       期望：${item.expected}`);
  }
}
console.log('\n观察（不判 pass/fail）：');
for (const text of observations) console.log(`  - ${text}`);
console.log(
  `\n环境向导独立反例（安装引擎 + 门禁判定 + 门禁/逃生口）：${results.length - failed}/${results.length} 通过（失败 ${failed} 条）`,
);
process.exitCode = failed > 0 ? 1 : 0;
