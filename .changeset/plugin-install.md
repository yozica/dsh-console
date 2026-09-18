---
'dsh-console': minor
---

插件页能直接装 / 卸 / 升级了（不用再开终端）

上一版只能"看"，这一版能改：

- 页头「+ 安装插件」→ 填包名、`./本地目录`、`.tgz` 或 `github:owner/repo#sha`，
  pnpm 的输出边跑边贴在页面上；装完提示「重启 dsh 后生效」并给「立即重启 dsh」。
- 树外插件的详情里多了「升级到最新」与「移除」。
- 同一时刻只允许一个操作（同一个 profile 目录不能被两个 pnpm 同时改），进行中给「中断」。
- 确认框里写明"代码从网络取、git 源安装时可能执行它的构建脚本"——装插件等于让第三方
  代码跑在你的机器上，这件事不能默默发生。

装/卸/升级改的是 package.json 与 node_modules，所以要重启 dsh；你自己的 patch 层仍然是
即时生效的，界面上把这两种时机分开写。

顺带修了两个只有真机才暴露的问题：`dsh plugin add` 在 pnpm 9 下会被
`ERR_PNPM_ADDING_TO_ROOT` 拒掉（dsh 模板的 pnpm-workspace.yaml 缺少
ignore-workspace-root-check），现在被拒时自动加 `-w` 重试一次；以及子进程的 PATH 补上了
pnpm 所在目录（GUI 启动的应用 PATH 很窄）。

还能单独指定安装源：「设置 → 插件安装源」填一个 registry（比如
`https://registry.npmmirror.com`），它只作为环境变量传给那一次 pnpm —— **不改你电脑上的
npm 配置，也不影响别的项目**；留空就跟随系统。当前生效的源显示在插件页的安装框旁边。
另外 404 的提示不再笼统说"包不存在"：缺的是依赖而不是你写的那个包时会直接指名道姓，
内置包也会在调用 pnpm 之前就被拦下并指路 patch 层。

机器上没装 pnpm 时，装 / 卸 / 升级会**在动你的 profile 之前**就停住并说清装什么
（原来会让 `dsh plugin` 先把 profile 初始化出来、再以退出码 127 失败）。只需看一眼的
层栈 / 清单不经过 pnpm，没装也照常可用。
