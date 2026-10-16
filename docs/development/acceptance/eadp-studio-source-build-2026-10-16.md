# eadp studio alpha.4 源码安装包构建验收

2026-10-16 在 Windows x64 开发机完整执行 `./build-desktop.ps1`，入口返回 `0`，生成可安装的 unsigned NSIS exe；不是手工收尾后的结果。固定 DSH 为 `dsh-v0.2.1-alpha.4` / `86a402200d95fecef4529d969836f1fe13c6cb0d`。产品构建入口捕获源码 commit `39bdfc1fd3c6138505a7e81c0c7df248b33f1d81`，工作区有未提交修改，`sourceDirty=true`；Studio source digest 为 `2b292fed1cc56e4c1d3abb764462a71d93e6b75a92e971c26e1c868749018cbd`。

| 产物 | 字节数 | SHA256 |
| --- | ---: | --- |
| `artifacts/windows/eadp-studio-0.2.1-alpha.4-win-x64-unsigned.exe` | 351769285 | `f968a6893a8ed9e1fad5999a9727855aeac3ce7a8afa94de9ec2d28494225aa7` |
| 最终应用 `resources/app.asar` | 185136408 | `d8012161b99f55db52c3880d39b4249a723a73d7d93ed1d0957526cc96b3fe7e` |

可复查的本机证据：

- 完整入口日志：`.local/logs/eadp-studio-source-script-final-20261016.log`；同名 `.exit` 文件内容为 `0`。
- 官方打包 run：`.local/build/dsh/apps/desktop/.desktop-build/packaging-runs/2026-10-16T13-33-39.343Z-XsSTGy`。
- 最终解包与 verifier：`.local/acceptance/eadp-studio-alpha4-final/verification.json`，`status=passed`，完整 payload verifier 退出 `0`。
- 安装包同名 `.exe.json` 记录实际输出路径、字节数和 SHA256。

Windows 可执行文件 `ProductName` 与 `FileDescription` 均为 `eadp studio`。最终 ASAR metadata 中产品名、版本、App ID、源码 commit/dirty 状态均与本次包装入口一致；实际随包 `dsh-web-frontend/dist/index.html` 标题为 `eadp studio`。完整 Studio Host/client、模板、contracts 及随包工具 inventory 均通过校验；官方 runtime smoke 完成离线插件安装/移除、DOCX/XLSX/PPTX 转 PDF 和工具发现。

此前确实出现过两项入口可靠性失败：构建过程中 HEAD 移动导致 `DSH_CLIENT_COMMIT_HASH` 收据不一致，以及全局 electron-builder 图标缓存 stale 状态恢复 rename 时 `EBADF`。现通过维护的定点编辑将包装入口捕获的产品 commit 同时传给客户端构建/校验，并通过官方 `ELECTRON_BUILDER_CACHE` 将工具缓存固定到本仓库 `.local/cache/electron-builder`。均不靠重试、旧实现或删除用户全局缓存。修正后上述完整源码入口真实返回 `0`。

缓存/包装两组 focused 回归 `8/8` 通过：`node --test tests/scripts/build-desktop.test.mjs tests/scripts/studio-packaging-edits.test.mjs`。另外 alpha.4 专项 `11/11` 的命令与 Windows 上 Linux `/bin/bash` 测试不适用的边界见[源码入口交接](../handoffs/desktop-source-installer.md)。不宣称全平台全套测试通过。

验收范围为 `development-machine-unsigned-source-build`。本次未执行安装后应用启动或干净机安装，`installedStartupVerified=false`、`cleanMachineInstallationVerified=false`；未签名、未验证升级/卸载及正式发布，`distributionVerified=false`、`targetReleasePocVerified=false`、`releaseReady=false`。`dependencyInstallVerified` 和 `nativeBuildVerified` 可据此次真实构建置为 `true`。以前 alpha.2 的开发机安装历史保留在[原 Windows 验收记录](g0-windows-2026-10-16.md)，不能推算为本次 alpha.4 已安装验收。
