# eadp studio 源码安装包入口

2026-10-16 同步补记：主分支已同步至 `2048a39`，产品入口和品牌改动已由 `70be7ca` 提交，固定上游已由 `3766738` 升级为 `dsh-v0.2.1-alpha.4`（commit `86a402200d95fecef4529d969836f1fe13c6cb0d`）。三个旧 worktree 的 13 个提交经 `git cherry` 和逐对 stable patch-id 确认均已等价集成，主 Agent 已保存引用和必要运行记录并清理旧 checkout。当前 alpha.4 适配保留，不恢复 alpha.2 实现。

alpha.4 的源码装配沿用官方 `build:lib`（含 Host/Client aggregate TypeScript 检查）；正式打包改用官方 `scripts/build.ts --profile official --scope artifacts`，替代已删除的 `--artifacts-only` 参数。Typert 调用锚点随 `rejectBuildOutputs` 参数更新，仍调用现有 `analyzeInBatches()`。Windows release pack 复用官方有界 scheduler，固定并发为 4。GNU tar 获取源码时启用本地路径及原始 UTF-8 名称；package-set 读取 tarball manifest 时使用 basename 和其父目录作为 cwd，与上游 tarball helper 一致。

现有运行证据须分开解释：alpha.4 的 `2026-10-16T09-06-08.341Z-Jq4gzC` 已完成 artifact build、release pack 和 runtime 准备，随后在 `prepare:packages` 的绝对 Windows 路径触发 GNU tar `Cannot connect to D: resolve failed`；当前定点编辑覆盖此失败行。该旧过程的 client receipt 对应 `86c5fc5`，不是同步后源码的最终验收。此前 alpha.2 流程在编译期间 HEAD 改变，release receipt 因 `DSH_CLIENT_COMMIT_HASH` 不一致被正确拒绝。后续固定提交、冻结源码再执行完整入口，禁止在构建中提交代码。最终 alpha.4 exe 和原生验收尚待主 Agent 记录，当前 `nativeBuildVerified=false`、`distributionVerified=false`、`releaseReady=false`；`windowsVerification` 中 alpha.2 安装记录仅为历史证据。相同 alpha.4 source hash 的 Linux、Windows 解包证据一并保留；fetch 脚本不写验收字段，升级脚本仅在新 source materialization 时清空旧验收，非本次平台列表变更的来源。

本次提供 `./build-desktop.ps1`，亦可 `pnpm run build:desktop` 或 `node scripts/build-desktop.mjs`。原生 Windows x64 执行，安装依赖、获取固定源码、装配、构建插件及随包工具，并复用上游 Electron/NSIS 管线生成 unsigned 安装包；不创建新壳。`--help` 查看要求，`--check` 装配与安装构建依赖后执行上游打包前置检查。

品牌变更由 `apps/desktop-distribution/build/desktop-brand-edits.mjs` 中的定点编辑维护，verified 上游缓存不改。应用、可执行文件、快捷方式显示名均为 `eadp studio`，App ID 为 `io.github.paulfrom.eadp.studio`，安装包 `eadp-studio-<version>-win-x64-unsigned.exe`。产品协议为 `eadp-studio://`，Electron 数据 `%APPDATA%\eadp studio`；启动早于首次 userData 读取设置 app.name，并将 Host 的 DSH_HOME 固定为 `%USERPROFILE%\.eadp-studio`，隔离原 DSH 数据，无迁移。固定上游 home-paths 在调用函数时读取 env，不在模块加载时缓存 DSH_HOME；桌面路径解析在 main 执行时发生。沿用原图标资源。

主窗口遵循网页标题：上游 `AppFrame` 读取构建变量 `DSH_CLIENT_TITLE`，`DocumentTitle` 写入“会话名 — 产品名”。因此品牌编辑同时替换 `scripts/client-build-environment.ts` 中 official profile 的唯一产品标题声明。Vite 的现有 HTML 转换、动态标题及 release artifact record 校验共用这份来源，初始与运行中标题都为新品牌，无需截断会话标题或泛改 DeepSeek 模型供应商文案。回归执行真实生成的 profile、Vite transform、DocumentTitle 和 artifact receipt 读写校验。

首次入口将追踪的 `windows-package.env.example` 独占创建到忽略构建树的 `.env.windows`。已有本地配置不覆盖；App ID 不同则停止并提示手工修正。默认策略源 `http://100.119.183.44:6972` 源于当前部署验证：2026-10-16 主 Agent 实测 `/api/v0/check_client_update?scenario=launch` 返回 HTTP 200 和严格 allow 载荷；原无端口示例返回 404。下载页域名保留 `https://www.zyjsm.top`。入口不打印配置，不签名或上传。现有部署设置仍由 `.env.windows` 管理。

构建共享目录通过 `.local/build/.studio-desktop-build.lock` 排斥入口之间并发运行。异常返回非零，任一步失败停止后续步骤；中断残留锁需先检查进程后人工清理。手工执行 assembly 或上游打包也应避开正在运行的入口。成功后复制最终 exe 到 `artifacts/windows/`，输出绝对路径、字节数、SHA256 及同名 JSON。旧验收产物和历史结果不改写。

验证入口：

```powershell
node --test tests/scripts/desktop-brand-edits.test.mjs tests/scripts/build-desktop.test.mjs tests/scripts/run-pnpm.test.mjs
./build-desktop.ps1 --help
./build-desktop.ps1 --check
./build-desktop.ps1
```

自动回归覆盖固定源码 anchors、上游漂移和重复拒绝、二次装配、真实 locale 字典、早期产品数据隔离、入口参数/主机约束、编排顺序/失败传播、中文空格和 shell 字符路径、已有配置保留，以及安装包复制和 SHA256 记录。模拟编排验证不能替代真实原生编译与安装。当前任务的真实 Windows 构建和最终产物验收由主 Agent 单独执行；签名、升级、卸载、干净机安装与正式发行门槛继续独立记录，不将源码入口视为 G0 通过。
