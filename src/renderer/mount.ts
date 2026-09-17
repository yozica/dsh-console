/**
 * 把外壳与各页面挂到各自的挂载点上。
 *
 * 迁移是逐页进行的，所以这里是一个"挂载清单"而不是一个根组件：
 * 外壳拆成 RailNav / TopBar / StatusBar 三块，页面在 panes/ 下。
 * 等剩下几页也迁完，这份清单会收成一个真正的根组件（那时 index.html
 * 只剩一个挂载点，也不再有"外壳渲染一半、app.ts 管另一半"的接缝）。
 *
 * 挂载点的包装元素都设了 `display: contents`（见 styles.css），
 * 这样组件渲染出来的 aside/header/footer 仍然是原来那层网格/弹性布局的子元素。
 */

import { createApp, type Component } from 'vue';

import ArchivePane from './panes/ArchivePane.vue';
import DashboardPane from './panes/DashboardPane.vue';
import PluginPane from './panes/PluginPane.vue';
import SettingsPane from './panes/SettingsPane.vue';
import ShellPane from './panes/ShellPane.vue';
import TerminalPane from './panes/TerminalPane.vue';
import UiPane from './panes/UiPane.vue';
import UsagePane from './panes/UsagePane.vue';
import RailNav from './shell/RailNav.vue';
import StatusBar from './shell/StatusBar.vue';
import TopBar from './shell/TopBar.vue';

type MountEntry = readonly [string, Component];

const MOUNTS: readonly MountEntry[] = [
  ['rail-root', RailNav],
  ['topbar-root', TopBar],
  ['statusbar-root', StatusBar],
  ['dashboard-root', DashboardPane],
  ['terminal-root', TerminalPane],
  ['shell-root', ShellPane],
  ['ui-root', UiPane],
  ['usage-root', UsagePane],
  ['archive-root', ArchivePane],
  ['plugin-root', PluginPane],
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
