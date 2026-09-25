/**
 * 首启门禁与「运行环境」详情层共用的词表与两句话术。
 *
 * 这些字符串原来长在 `shell/EnvGate.vue` 里（`panes/EnvPane.vue` 又抄了其中三份）。它们**不是
 * 组件私有的排版**，而是同一套设计稿（冻结文档 §3.8 / 交互 §4.1）的逐字文案 —— 放一份，
 * 两处才能保证一字不差。
 *
 * 这里只放"翻译"和"现成的句子"：判断留给主进程的纯函数（`judgeEnvironment` / `judgeWizard`）。
 */

import type {
  EnvCheckId,
  EnvCheckStatus,
  EnvNodeChannel,
  EnvNodeMethod,
  EnvStepStatus,
  EnvWizardStepId,
} from '../../shared/ipc.js';

/** 官方下载页：装不上 / 不想让我们装时的出路（本应用改动为零） */
export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';

/** 后台忙时的统一说明：与被禁用的按钮成对出现，禁用必须看得到原因（交互 §2.9 / §11.6） */
export const BUSY_HINT = '正在执行上一步的操作，完成后按钮会自动恢复';

export const STEP_LABELS: Record<EnvWizardStepId, string> = {
  node: '第一步',
  pnpm: '第二步',
  dsh: '第三步',
};

export const STEP_TITLES: Record<EnvWizardStepId, string> = {
  node: '安装 Node.js',
  pnpm: '安装 pnpm',
  dsh: '安装 dsh',
};

export const STEP_CARD_TITLES: Record<EnvWizardStepId, string> = {
  node: '第一步：安装 Node.js',
  pnpm: '第二步：安装 pnpm',
  dsh: '第三步：安装 dsh',
};

export const STEP_WHY: Record<EnvWizardStepId, string> = {
  node: '没有它 dsh 起不来，也无法安装后面的东西',
  pnpm: '装插件、卸插件、升级插件都要用它',
  dsh: 'dsh 是 DSH Console 要启动的服务本体；没有它界面里什么都做不了',
};

export const CHECK_TITLES: Record<EnvCheckId, string> = {
  node: '外部 Node',
  'node-version': 'Node 版本',
  npm: 'npm',
  pnpm: 'pnpm',
  dsh: 'dsh 本体',
  'dsh-run': 'dsh 能不能跑',
  'bundled-runtime': '应用自带运行时',
  shell: '本地 Shell',
};

/** 事实行的结论词：三种既有状态 + 两个"不是状态"的态（视觉 §6.1 的五个词逐字照用） */
export const FACT_STATUS_WORDS: Record<EnvCheckStatus | 'skipped' | 'unknown', string> = {
  ok: '正常',
  warn: '需要注意',
  missing: '不可用',
  skipped: '已跳过',
  unknown: '没测出来',
};

export const STEP_STATE_WORDS: Record<EnvStepStatus, string> = {
  done: '已完成',
  todo: '待办',
  skipped: '已跳过',
  unknown: '没测出来',
};

/** 事实行的灯：三种既有的自检状态 + 两个"不是状态"的态（见视觉 §6.1） */
export type FactStatus = EnvCheckStatus | 'skipped' | 'unknown';

/**
 * 「这份 Node 是谁管的」这一件事实**只由主进程给**（需求 §7.7 的纯函数），
 * 这一层按它决定选择区长什么样 —— 判得出归属时只给一条路、判不出来时不预选（§7.8 那张表）。
 */
export type MethodArea = 'fact-nvm' | 'fact-system' | 'choose' | 'choose-fresh';

/**
 * 选择区里"方法"那一块的事实行（逐字来自交互 §4.1 的 t29 修订 4-a；`choose-fresh` 那一支见 4-c）。
 * **`choose-fresh` 故意不在表里**：它的事实行要按"这台机器上有没有版本管理器"分两种说法，
 * 所以由 `methodFact` 现算 —— 见 `EnvGate.vue` 里的 computed。
 */
export const METHOD_FACTS: Record<Exclude<MethodArea, 'choose-fresh'>, string> = {
  'fact-nvm': '这份 Node 是版本管理器（nvm）管的，所以我们也用它来装 / 换。',
  'fact-system': '这份 Node 是官方安装包装的，所以我们也用官方安装包把它换到同一个位置。',
  choose: '我们认不出这个 Node 是怎么装的。',
};

/** 档位控件的两个选项（与 §4.1 第 4-b 条逐字一致：不用 `LTS` 这类术语） */
export const CHANNEL_OPTIONS: { id: EnvNodeChannel; title: string; note: string }[] = [
  { id: 'lts', title: '最新稳定版', note: '发布更久、坑更少。' },
  { id: 'current', title: '最新当前版', note: '追最新特性，可能还没进入稳定期。' },
];

/** 两条安装路（§4.1 的说明行逐字照用）；归属判不出来时这两条各带一句并存风险 */
export const METHOD_OPTIONS: { id: EnvNodeMethod; title: string; note: string }[] = [
  {
    id: 'direct',
    title: '直接安装官方版本（会问一次管理员权限）',
    note: '官方安装包，装到系统的默认位置；这台电脑上原来的 Node 会被换成这个版本。',
  },
  {
    id: 'nvm',
    title: '用版本管理器安装（不用管理员权限，可以装多个版本）',
    note: '先装一个版本管理器（nvm），再用它装 Node；不会动系统里原有的 Node，之后可以随时切换版本。',
  },
];

/** 档位词（事实行与「版本档位」那一行用它） */
export const CHANNEL_TITLES: Record<EnvNodeChannel, string> = {
  lts: '最新稳定版',
  current: '最新当前版',
};

/** 档位短词（并排显示与换档句用它） */
export const CHANNEL_SHORT: Record<EnvNodeChannel, string> = { lts: '稳定版', current: '当前版' };

/** 用户**显式点名**的方法与这份 Node 的归属不一致时，确认区必须带这句并存风险
 *  （需求 §7.8 的三个例外 / §7.9 第 4 条：原句里"哪一份生效"说成系统查找路径） */
export const METHOD_RISK =
  '这样这台电脑上会有两份 Node：一份是原来的（不会被删掉），一份是这次装的。之后哪一份生效，看系统查找路径里谁在前。';

/** 「v24.19.0（稳定版）」/「版本没测到（档位未知）」—— 门禁与详情层各画一处，逐字一致 */
export function versionWithChannel(version: string | null, channel: EnvNodeChannel | null): string {
  const word = channel ? CHANNEL_SHORT[channel] : '档位未知';
  return version ? `${version}（${word}）` : `版本没测到（${word}）`;
}
