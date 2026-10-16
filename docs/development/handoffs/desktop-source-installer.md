# eadp studio 源码安装包入口

最终结果：完整执行生成脚本 `./build-desktop.ps1` 返回 `0`，实际生成 `artifacts/windows/eadp-studio-0.2.1-alpha.4-win-x64-unsigned.exe`，351769285 字节，SHA256 `f968a6893a8ed9e1fad5999a9727855aeac3ce7a8afa94de9ec2d28494225aa7`。最终 ASAR 为 185136408 字节，SHA256 `d8012161b99f55db52c3880d39b4249a723a73d7d93ed1d0957526cc96b3fe7e`；产品名、实际 HTML 标题、完整 Studio/plugin/template/contracts/toolchain inventory 校验通过。scope 为 unsigned source build，尚未安装验证。完整证据和边界见[本次构建验收](../acceptance/eadp-studio-source-build-2026-10-16.md)。

2026-10-16 同步补记：主分支已同步至 `2048a39`，产品入口和品牌改动已由 `70be7ca` 提交，固定上游已由 `3766738` 升级为 `dsh-v0.2.1-alpha.4`（commit `86a402200d95fecef4529d969836f1fe13c6cb0d`）。三个旧 worktree 的 13 个提交经 `git cherry` 和逐对 stable patch-id 确认均已等价集成，主 Agent 已保存引用和必要运行记录并清理旧 checkout。当前 alpha.4 适配保留，不恢复 alpha.2 实现。

alpha.4 的源码装配沿用官方 `build:lib`（含 Host/Client aggregate TypeScript 检查）；正式打包改用官方 `scripts/build.ts --profile official --scope artifacts`，替代已删除的 `--artifacts-only` 参数。Typert 调用锚点随 `rejectBuildOutputs` 参数更新，仍调用现有 `analyzeInBatches()`。Windows release pack 复用官方有界 scheduler，固定并发为 4。GNU tar 获取源码时启用本地路径及原始 UTF-8 名称；package-set 读取 tarball manifest 时使用 basename 和其父目录作为 cwd，与上游 tarball helper 一致。

此前运行证据须分开解释：alpha.4 的 `2026-10-16T09-06-08.341Z-Jq4gzC` 完成 artifact build、release pack 和 runtime 准备，随后在 `prepare:packages` 的绝对 Windows 路径触发 GNU tar `Cannot connect to D: resolve failed`；维护的定点编辑覆盖此失败行。该旧过程的 client receipt 对应 `86c5fc5`，不是同步后源码的最终验收。更早 alpha.2 流程在编译期间 HEAD 改变，release receipt 因 `DSH_CLIENT_COMMIT_HASH` 不一致被拒绝，最终已通过下文的包装 snapshot 修正解决，不能只要求用户不提交。完成最终 alpha.4 源码入口后，`dependencyInstallVerified=true`、`nativeBuildVerified=true`；发行三项继续为 false，安装/干净机启动仍未验证。旧 alpha.2 安装历史保留原 acceptance 文档，本次 lock 的 `windowsVerification` 已替换为准确的 alpha.4 build-only scope。相同 alpha.4 source hash 的 Linux、Windows 解包证据一并保留；fetch 脚本不写验收字段，升级脚本仅在新 source materialization 时清空旧验收，非本次平台列表变更的来源。

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

alpha.4 专项复验最终纯测试命令（Windows 原生、沙箱外；exit code `0`，`11/11` 通过，未跳过）：

```powershell
node --experimental-transform-types --test tests/scripts/studio-typert-edits.test.mjs tests/scripts/studio-template-archive.test.mjs tests/scripts/fetch-dsh.test.mjs tests/scripts/studio-packaging-edits.test.mjs
```

该结果包含真实 GNU tar 和系统 bsdtar 的中文/空格/驱动器路径 manifest 读取、GNU tar 获取源码时 UTF-8 成员及真实符号链接、fixed alpha.4 anchors/命令参数/Windows并发4及macOS已有值保留，以及原 Typert direct/batch 模型一致性和模板实际 pnpm pack/hardlink 验证。GNU tar 测试从 Git 所在目录发现 `usr/bin/tar.exe`，并提供它的工具 PATH（包括 gzip），不改变产品配置。参数属性转换仅用于在原生 Node 测试中导入 alpha.4 TypeScript 源码，产品构建继续使用上游 tsx 工具链。

其余 focused（品牌、入口、pnpm调用、payload、IPC导入、启动和模板cleanup）首轮覆盖 27 项中的 25 项通过；另外两项分别是沙箱拒绝 hardlink 和 Node strip-only 不支持新参数属性，已在上述纯命令中复验通过。未宣称全测试套件通过：Windows 上 `setup-linux.test.mjs` 的 `/bin/bash` 场景不适用；此前全量脚本测试的对应 9 项因 Windows 缺 `/bin/bash` 失败，Linux 原生验证应在 Linux 工作站执行。主 Agent 已将适配固定到 `0c0f746`，后续完整入口运行中不改变 HEAD 或产品构建源码；新增专项测试和本段记录暂留工作区，等待原生构建结束后再提交。

完整入口 `0c0f746` 实际结果（日志 `.local/logs/eadp-studio-alpha4-0c0f746.log`，run `2026-10-16T12-43-57.914Z-mjwLlu`）：源码构建、release pack、package-set 及全部 runtime 准备通过，已生成 `win-unpacked/eadp studio.exe`。Electron-builder 完成 fuses 后在用户全局缓存发现 `icons@1.2.3/icons-bundle-yehgs.state` 为 stale extracting 状态，恢复解压时 `.tmp` rename 返回 `EBADF`，最终入口退出 `1`。因此该次不能作为成功安装包或脚本成功证据。

修正只落在 `scripts/build-desktop.mjs`：打包前创建主 checkout 的 `.local/cache/electron-builder`，通过 electron-builder 官方 `ELECTRON_BUILDER_CACHE` 环境变量固定工具缓存。已核验当前 app-builder-lib `26.17.0` 的 `out/util/electronGet.js` 实际实现：`getCacheDirectory` 接受该变量，`downloadBuilderToolset` 的 extraction/archive/downloads 路径均传 `allowEnvVarOverride: true`；icons tool直接调用该下载函数。无需修改上游、清理全局缓存、静默重试或切换旧实现。

缓存专项回归纯命令 `node --test tests/scripts/build-desktop.test.mjs` 返回 exit code `0`，`4/4` 通过。新增用例通过真实 `runPnpm` shim 子进程加载当前 electron-builder 的 `getCacheDirectory`，验证中文/空格/`&`路径正确传递、目录已创建、实际解析至 workspace 缓存，并保留父进程既有环境。缓存修正后的最终验收仍要求完整执行 `./build-desktop.ps1` 成功；单独 builder 阶段仅作故障诊断，不替代源码入口结果。

HEAD 变化的可靠性修正：仅要求构建期间不提交不足以防止外部进程移动 HEAD。`STUDIO_PACKAGED_COMMIT_EDIT` 在维护的 `desktop-build-commit.mjs` 定点编辑中，让上游现有 `desktopBuildCommitEnvironment(packaged)` 同时输出 `DSH_CLIENT_COMMIT_HASH: packaged.commit`。入口已有的一次 `readDesktopBuildCommit` 成为桌面 metadata、客户端 bundle 与 release receipt 的同一来源；实际产品源码仍应保持稳定，但不再因后续 Git HEAD 移动而让同一批产物的 commit 校验出现误差。该值来自产品 checkout，而非锁定的 DSH commit，不新增查Git、配置项或重试。

新增真实回归在临时 Git 仓库读取包装 snapshot，生成并写入官方 client artifact receipt，然后实际创建第二个 commit 移动 HEAD；未固定环境时复现 `DSH_CLIENT_COMMIT_HASH` mismatch，使用生成的包装环境后仍通过同一 artifact receipt 校验。同时验证定点编辑幂等、漂移和重复拒绝。此次仅修改维护的 build/test/docs，未直接修改构建缓存。

最终缓存和包装 focused 纯命令 `node --test tests/scripts/build-desktop.test.mjs tests/scripts/studio-packaging-edits.test.mjs` 返回 `0`，`8/8` 通过。源码脚本最终日志为 `.local/logs/eadp-studio-source-script-final-20261016.log`，对应 `.exit=0`；raw run 为 `2026-10-16T13-33-39.343Z-XsSTGy`。完整 payload verifier 返回 `0`，`.local/acceptance/eadp-studio-alpha4-final/verification.json` 为 `passed`。本次 run 捕获 sourceCommit `39bdfc1fd3c6138505a7e81c0c7df248b33f1d81`、`sourceDirty=true`，sourceDigest `2b292fed1cc56e4c1d3abb764462a71d93e6b75a92e971c26e1c868749018cbd`，不将带未提交修改的开发构建称为正式发行。
