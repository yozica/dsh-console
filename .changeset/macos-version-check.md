---
'dsh-console': patch
---

macOS 也会提示有没有新版本了（虽然仍然不能自动安装）

之前 macOS 只在设置页写一句"ad-hoc 签名装不了自动更新"，用户只能自己去 Releases 页面看有没有新版。
现在应用**照样会检查**：启动几秒后一次、之后每 6 小时一次，发现新版本会在底栏提示「发现新版本 x.y.z」，
设置页的更新卡片也会写明，按钮是「打开下载页」—— 点它去下载新的 `.dmg` 覆盖安装即可。

实现上没有引入 Squirrel：macOS 上直接取那份不到 1 KB 的 `latest-mac.yml` 比版本号（与 Windows
走 electron-updater 时读的是同一个文件）。契约里的 `canCheck`（能不能查）与 `canAutoUpdate`
（能不能装）因此分成了两个字段。
