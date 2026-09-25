/**
 * 应用图标与应用菜单。t56 从 `main.ts` 拆出来。
 *
 * 两件事都只跟"平台 + 是否打包"有关，不需要主窗口；`__dirname` 与 `main.ts` 一样是
 * `dist/main`，所以图标那条相对路径原样成立。
 */

import fs from 'node:fs';
import path from 'node:path';

import { Menu, app, nativeImage, type NativeImage } from 'electron';

export interface MenuContext {
  isMac: boolean;
}

/**
 * 应用图标（窗口与 macOS 的 Dock 都用它）。
 *
 * 读不到就返回 `undefined`、用系统默认图标，不影响运行 —— 开发态刚 clone 下来还没有
 * `build/icon.png` 时也会走这条路。
 */
export function makeIcon(): NativeImage | undefined {
  try {
    const file = path.join(__dirname, '..', '..', 'build', 'icon.png');
    if (fs.existsSync(file)) {
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) return image;
    }
  } catch {
    // 读不到就用系统默认图标，不影响运行
  }
  return undefined;
}

/** macOS 开发态：Dock 图标取自同一张源图（打包后由 .icns 提供，不必覆盖） */
export function applyDockIcon(ctx: MenuContext): void {
  if (!ctx.isMac || app.isPackaged || !app.dock) return;
  const icon = makeIcon();
  if (icon) {
    try {
      app.dock.setIcon(icon);
    } catch {
      /* 设置失败不影响运行 */
    }
  }
}

/**
 * 应用菜单。
 *
 * Windows/Linux 上刻意留空（原来的行为）：界面自带全部操作入口，系统菜单栏只是干扰。
 *
 * macOS 不能留空 —— 系统级快捷键（Cmd+Q 退出、Cmd+W 关窗、Cmd+C/V 复制粘贴、
 * Cmd+M 最小化）都由菜单提供，菜单为空时这些键在文本框里都会失灵。
 * 所以给一个最小原生菜单：应用 / 编辑 / 显示 / 窗口。
 */
export function installApplicationMenu(ctx: MenuContext): void {
  if (!ctx.isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}
