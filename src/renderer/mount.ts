/**
 * 把外壳与各页面挂到各自的挂载点上。
 *
 * 迁移是逐页进行的，所以这里是一个"挂载清单"而不是一个根组件：
 * 外壳拆成 RailNav / TopBar / StatusBar 三块，页面在 `pages/<一处>/` 下（t67 起：
 * 一个页面 / 一个特性一个目录，通用组件才进 `components/` —— 见 AGENTS §2）。
 * 等剩下几页也迁完，这份清单会收成一个真正的根组件（那时 index.html
 * 只剩一个挂载点，也不再有"外壳渲染一半、app.ts 管另一半"的接缝）。
 *
 * 挂载点的包装元素都设了 `display: contents`（见 styles.css），
 * 这样组件渲染出来的 aside/header/footer 仍然是原来那层网格/弹性布局的子元素。
 */

import { createApp, type Component } from 'vue';

import EnvGate from './gate/EnvGate.vue';
import GateBanner from './gate/GateBanner.vue';
import ArchivePane from './pages/archive/ArchivePane.vue';
import DashboardPane from './pages/dashboard/DashboardPane.vue';
import EnvPane from './pages/env/EnvPane.vue';
import PluginPane from './pages/plugin/PluginPane.vue';
import SettingsPane from './pages/settings/SettingsPane.vue';
import TerminalPane from './pages/terminal/TerminalPane.vue';
import UiPane from './pages/ui/UiPane.vue';
import UsagePane from './pages/usage/UsagePane.vue';
import CloseDialog from './layout/CloseDialog.vue';
import RailNav from './layout/RailNav.vue';
import StatusBar from './layout/StatusBar.vue';
import TopBar from './layout/TopBar.vue';

type MountEntry = readonly [string, Component];

const MOUNTS: readonly MountEntry[] = [
  ['rail-root', RailNav],
  ['topbar-root', TopBar],
  ['statusbar-root', StatusBar],
  // 关闭确认卡片：它自己 Teleport 到 body，这个挂载点只是个锚
  ['close-dialog-root', CloseDialog],
  // 首启门禁层：与 #boot-lock 同级的整屏覆盖层。它是覆盖层，**不是**第 10 页 ——
  // 所以既不在页面清单里，也不进 TAB_ORDER（做成页面就能被 Ctrl+2 切走，硬门禁就没意义了）
  ['gate-root', EnvGate],
  ['gate-banner-root', GateBanner],
  ['dashboard-root', DashboardPane],
  // 终端页的宿主：会话条 + 本地 Shell，dsh 那一路由它内部的子组件 DshTerminal 渲染
  //（`MOUNTED_COMPONENTS` 只列挂载进去的那些，子组件由自检的另一条规则盯着）
  ['terminal-root', TerminalPane],
  ['ui-root', UiPane],
  ['usage-root', UsagePane],
  ['archive-root', ArchivePane],
  ['plugin-root', PluginPane],
  ['env-root', EnvPane],
  ['settings-root', SettingsPane],
];

export function mountAll(): void {
  for (const [id, component] of MOUNTS) {
    const root = document.getElementById(id);
    if (root) createApp(component).mount(root);
  }
}

/** 挂载清单（自检会核对每个 .vue 都在这里，别漏挂） */
export const MOUNTED_COMPONENTS = MOUNTS.map(([, component]) => component);
