# 原型浏览器运行时装配记录

2026-10-28 已完成固定 Windows x64 双运行时的本机装配及启动检查，尚未形成或安装当前版本发行包。浏览器 provider 接受的运行时清单由产品发行装配提供，其摘要也必须来自独立受信的发行元数据；不得由模型、工作区、普通工具参数或运行时自行指定。没有受信清单时浏览器不可启动，不能改用系统浏览器或下载替代版本。

固定参考是 [Playwright 1.61.1 的 browsers.json](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/browsers.json) 与[同版本 registry](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/registry/index.ts)：Chromium revision 1228，版本 149.0.7827.55；Windows x64 的 Chromium 与 headless-shell 路径分别是 `builds/cft/149.0.7827.55/win64/chrome-win64.zip` 和 `builds/cft/149.0.7827.55/win64/chrome-headless-shell-win64.zip`，来源为 `https://cdn.playwright.dev`。这些只是来源和版本，不是已核实的归档摘要。

`studio-browser.lock.json` 已填写从上述固定 HTTPS 地址实际下载所得的 SHA-256；这些是本机测得的字节摘要，不是供应商签名证明。`prepare-studio-browser.mjs` 只接受 `.local/browser-archives/headed.zip` 与 `headless.zip` 中经该锁校验的字节，不下载替代归档；摘要不匹配即拒绝装配。`prepare-studio-plugin.mjs --browser-runtime` 是显式装配入口，`build:desktop` 的正式装配步骤已强制使用该入口，避免安装包静默缺少浏览器；普通源码 staging 保持独立。

| 归档 | 字节数 | SHA-256 |
| --- | ---: | --- |
| headed.zip | 192511857 | `ebc0c2b75e2ea98151a7f18ff47037bfcbab44a8660e79b9ffa6520f9b7607ab` |
| headless.zip | 119099822 | `5cfda0c763aa6a867ce2efad0c467e3220e9c5c01c4cba02fd57afe49ede5457` |

本机证据：`.local/sync-browser-assembly.log`、`.local/sync-browser-smoke.mjs`、`.local/sync-browser-smoke.json`。清单摘要为 `3a8ce2af9f8125984f552ee7582c279bc4da1625fc0279df28209a3a1dcfd4a8`，包含 headed 308 个文件和 headless 290 个文件。两个分发物均通过 Host 完整清单校验、Playwright 实际启动、版本核对、页面按钮点击和截图，进程随后正常关闭。headed 二进制以无头模式完成此项检查，未验证有头窗口或 Electron 内嵌承载。

许可载荷核对：headless 归档自带 `LICENSE.headless_shell`（2037413 字节）；headed 归档没有独立 LICENSE 文件，已实际打开该二进制的 `chrome://credits` 并保存到 `.local/sync-browser-headed-credits.html`。完整原始目录均保留。Chrome for Testing 二进制不能仅凭 Chromium 源码的 BSD 许可就推断分发条件；最终安装包的许可材料及分发审核仍需完成，不能将本机启动检查等同许可批准。

装配实现会保留两个完整解压树，逐文件记录大小和 SHA-256，生成 schema 2 的 `browser-manifest.json` 及包含其摘要的 `browser-runtime.release.json`。运行时校验同时覆盖 headed 与 headless 全部文件、固定版本、固定可执行物路径和受信 manifest hash，再按 Host 的 `headless` 模式选择 `headed/chrome-win64/chrome.exe` 或 `headless/chrome-headless-shell-win64/chrome-headless-shell.exe`。Host 组合层只从随包 assets 读取 release 元数据；最终 installer 是否包含并保留这些文件及实际安装后的校验结果仍未验证。

provider 现在通过 Playwright browser server 持有浏览器进程树；关闭先撤销新动作并中止动作信号，优雅清理超时后终止 server，随后等待已启动动作结束。每次动作仍前后核对预览身份，abort listener 在动作结束后移除。`trace` 是 100–5000 ms 的显式受限动作，不接受路径或 Playwright 脚本；Host 的 `PrototypeBrowserAttachmentStore` 选择临时及持久路径，原子保存实际截图／trace 字节和范围元数据，并以持久化字节的 SHA-256 绑定返回附件。

`prototype_browser` 已作为受限原生会话工具接入，不再保留另开 stdio-MCP 的需要。组合层提供附件根目录、预览身份和事项 generation；预览停止或崩溃、事项资源释放及 Host 退出会关闭对应能力。运行时不可用时只有工具调用失败，不阻止原生会话创建。真实业务用例、最终发行装配、取消／退出时的实际进程树以及桌面闭环仍未验证。Electron 静态保护结果、Chromium 实际业务步骤及真实桌面闭环须分别记录，不能用其中一种推断另一种。2026-10-27 尚未运行的历史状态由前述 2026-10-28 证据更新；真实桌面闭环仍未验收。
