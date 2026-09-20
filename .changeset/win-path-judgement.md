---
'dsh-console': patch
---

Windows 路径判据改用 `path.win32`（沙箱门禁里那条 `M launchSpec` 在 macOS 上是误红）

`isCmdExe` / `isPeImage` / `isRunnablePath` 拼的是 **Windows** 路径，却用了跟着"跑测试这台机器"
走的 `path.basename` / `path.extname`：在 macOS / Linux 上 `basename('C:\Windows\system32\cmd.exe')`
返回**整串**，于是 `cmd.exe` 被判成"不是 cmd.exe"，`launchSpec` 走进 `.exe` 直连分支
（`verbatim=false`、不再包引号）。Windows 上两种写法等价，所以**生产行为不变** —— 换来的是这类
判据在任意平台都能被测到（`scripts/env-doctor-cases.mjs` 的 `M launchSpec` 就是被它判红的）。
