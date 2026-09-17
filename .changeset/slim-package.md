---
'dsh-console': patch
---

内部：把渲染层依赖从生产依赖里摘出来，安装包小了一圈

`vue` / `@xterm/*` / `@fontsource/*` 只被渲染层用到，而渲染层是由 Vite 打包成 `dist/renderer` 的
单文件产物；它们挂在 `dependencies` 里时，electron-builder 会**再拷一份**进 `app.asar`。
现在归到 `devDependencies`，生产依赖只剩主进程运行时要 require 的 `node-pty` 与 `electron-updater`。

实测（本地 `--dir` 包）：`app.asar` 20.2 MB → **2.1 MB**，未压缩的 `.app` 306 MB → **289 MB**，
下载的安装包相应小几 MB。功能没有任何变化，自检加了两条把这条规则钉住（每个生产依赖都必须真被
主进程 require、渲染层依赖不许留在 dependencies）。
