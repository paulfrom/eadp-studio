# G0-1 最小切片交接

更新日期：2026-10-15。范围：G0-1 最小 Host/client 插件与定制桌面发行验证。正式 CLI 生产依赖缺少 Studio 的问题已修正；完整官方 Windows unsigned 打包及最终运行时 smoke 退出 0，最终安装包已安装并核对 EXE/ASAR 哈希。开发机全新数据首启通过唯一 Studio DOM、填满主区域与实际截图验证；真实宿主会话已验证追加输入、事件、单次审批、取消及更新安装后的恢复续聊，成功模型为 `deepseek-account / deepseek-flash`。这仍是最小插件验证件，未通过干净机、签名、共存和完整 G0 验收。初版失败与修正证据保留在下文。

## 目标

按 [G0-1](../../../dsh_eadp_studio_plan/G0-1-最小插件与接口清单.md) 建立内置最小 Host/client 插件的定制桌面发行验证件，复用固定上游 `d743267388641bc76f17c45ce8b4c231aed1d32c` 的真实构建管线，不虚构 DSH API、不新造 Electron 壳或 Agent loop。

## 已完成（本机 Linux）

- 对接并集成 `f762702`（工具准入范围调整）到 `main`，对应提交 `6030bad`；两个任务分支从同一基线分叉，各一个 writer。
- 重建 worktree：`.local/worktrees/g0-plugin`（`feat/g0-1-plugin`）、`.local/worktrees/g0-desktop`（`feat/g0-1-desktop-assembly`），均在 `6030bad`，`check:repository` 通过。
- 源码就绪证据入 `release.lock.json`（平台化）与 [单仓库开发准备交接](repository-setup.md)。
- 上游依赖与构建按上游契约准备，见下表。
- 产出 [G0-1 真实接口清单](../g0-1-interface-inventory.md)：面板、通信、会话、事件、审批、取消、恢复的固定 SHA/路径/symbol/限制，未知项显式标注。
- 落地最小 Host/client 插件：`packages/studio-plugin/src/host/index.ts`、`src/client/index.ts`、`src/client/StudioPanel.tsx`，`package.json` 声明 `dsh.client` 与 `exports[./client]`；client 半边注册满窗 `main` 槽位并 `ctx.layout.selectPanel`。
- 落地装配入口：`apps/desktop-distribution/build/prepare-studio-plugin.mjs`，从已校验源码建立构建树、把插件放到固定位置 `packages/eadp/studio-plugin`、注入上游 workspace 依赖、补 `tsconfig.client.json` 引用。Linux 当时已有完整上游构建；Windows 干净树续跑发现并修复 Host 前置缺失，当前脚本统一运行官方 `build:lib`（Host → Client），见下文。
- 内置默认启用（初版代码，实际安装后暴露缺口，修正见下文）：插件 `package.json` 声明 `dsh.bundle.patch` 并随包发出 `cordis.patch.yml`；初版装配脚本向构建树施加两处上游编辑并做桌面 typecheck：
  - `apps/desktop/scripts/prepare-package-set.ts`：初版人为将插件加入核心包集根（`ROOT_PACKAGES`），并接受 `DSH_DESKTOP_PACKED_EXTRA` 提供的额外 tarball 目录。后续已删除人为扩根，改为正式 CLI 生产依赖，保留额外 tarball 输入。
  - `apps/desktop/src/project-manager.ts`：在 profile 的 `dsh.profile.bundles` 末尾加入插件包名。
- 装配脚本还用 `pnpm pack` 产出插件 tarball 到 `.local/build/packed-studio/`，内含 `cordis.patch.yml`、`lib/index.js`、`lib/client.js`、类型声明与 README。

## 验证环境与结果（Linux）

| 项 | 值 |
| --- | --- |
| Node / pnpm | `v22.22.3` / `11.28.5`（满足上游 `^22.19.0 \|\| >=24`、`pnpm@11.28.5`） |
| 依赖安装 | `.local/upstream/dsh` 内 `pnpm install --frozen-lockfile`，退出 0，`node_modules` 约 2.1G |
| 上游构建 | `pnpm run build` 退出 0：`native/system/packages/linux-x64/bin/glibc/system.node`、`build:lib`（host+client）、`build:web`（357 个 client artifact） |
| 桌面构建 | `pnpm run build:desktop` 退出 0，产物 `apps/desktop/lib/` |
| 关键校验值 | `system.node` `d7cb1782…707e7`；`apps/desktop/lib/main.js` `9360edbf…6acba`；`apps/web/dist/index.html` `414155b3…87200` |
| 日志 | `.local/logs/dsh-install.log`、`.local/logs/dsh-build.log`、`.local/logs/assemble-plugin.log` |

插件装配（构建树 `.local/build/dsh`，不修改已校验源码）：

| 项 | 值 |
| --- | --- |
| 装配命令 | `node apps/desktop-distribution/build/prepare-studio-plugin.mjs`，退出 0 |
| Host 产物 | `packages/eadp/studio-plugin/lib/index.js`，`sha256 01e3d280…41c489`，ESM `export { apply }` |
| client 产物 | `packages/eadp/studio-plugin/lib/client.js`，`sha256 9eceeba9…b2b4d2`，`window.__ModuleLoader__.load({ id: '@eadp-studio/studio-plugin', … })`，`react/jsx-runtime` 为外部依赖 |
| 构建边界 | client bundle 必须复用固定上游 `packages/client/tsdown.client.ts` 预设（依赖上游仓库内模块），不能在产品 workspace 单独构建 |
| 插件 tarball | `.local/build/packed-studio/eadp-studio-studio-plugin-0.0.0.tgz`，含 `package/cordis.patch.yml`、`package/lib/{index,client}.js`、类型声明；manifest 声明 `dsh.bundle.patch` 与 `dsh.client` |
| 上游编辑 | 两处编辑幂等重放（再次运行报 `already applied`）；`build:desktop` typecheck 通过；补丁后的 `prepare-package-set.ts` 用空输入运行得到预期报错 `contains no tarballs` |
| 平台限制 | 桌面打包只支持 `mac-arm64`/`mac-x64`/`win-x64`，Linux 无目标，`package-target.ts` 直接拒绝；最终安装包须在对应 Windows/macOS 主机打包验收 |

两次独立运行（手工试验与脚本运行）产出相同 SHA256；另从零删除构建树后重跑，同样退出 0 且两个产物 SHA256 一致。装配脚本以 `CI=true` 运行上游安装，避免上游 lefthook postinstall 向外层产品仓库写入 git hook 与 `lefthook.yml`；本轮已清理首次未设 `CI` 时误写入的 `.git/hooks/prepare-commit-msg` 与根 `lefthook.yml`（均非 Git 受管内容，清理后 `git status` 干净）。

这些是 Linux 构建/检查结果，不替代 Windows 原生验收。

## Windows 续跑结果（2026-10-14）

产品基线为 `main` 的 `c8e28be`，本轮修复位于产品源码；固定 DSH 提交仍为 `d743267388641bc76f17c45ce8b4c231aed1d32c`。构建使用本机生成的 `.local/build/dsh`，不把 Linux 依赖或已构建输出作为 Windows 前置。

- 完整源码准备通过：开启开发者模式后，修复 Windows bsdtar 将目录链接创建为文件链接及按本地代码页解码 UTF-8 文件名的问题。获取脚本按目标类型创建真实符号链接，并以 `hdrcharset=UTF-8` 解包；完整 fetch 退出 0，17,129 个成员、14 个内部链接的真实路径边界及关键文件 SHA-256 校验通过，发布至 `.local/upstream/dsh`。`release.lock.json` 已记录 Windows 源码解包通过。
- 修复 Windows pnpm 启动：`spawnSync('pnpm', ...)` 在本机只有 PowerShell/CMD shim 时返回 `ENOENT`。产品构建 helper 使用固定 `cmd.exe /d /s /c` 命令，工作目录通过独立 `cwd` 传递，pack 使用固定相对输出目录；其他平台继续直接执行。没有任意 shell 参数或失败后 fallback。
- 修复干净树构建顺序：首次依赖安装成功后，直接 `build:lib:client` 因缺少 `@deepseek-ai/*/remote` 和 `ClientRemote` 属性报 TS2307/TS2339，装配退出 1。当前删除旧 `client` 操作，改用固定 `libraries → pnpm run build:lib`，由上游先构建 Host、生成 Remote 契约，再构建 Client；随后运行 `build:desktop` 和 pack。

| 项 | Windows x64 实际结果 |
| --- | --- |
| Node / pnpm | `v22.22.0`；构建树安装使用上游 `pnpm@11.28.5` |
| 根仓库准备 | `node scripts/check-repository.mjs`、`pnpm install --frozen-lockfile --ignore-scripts` 通过 |
| 修复后完整装配 | `node apps/desktop-distribution/build/prepare-studio-plugin.mjs` 退出 0；上游依赖安装、`build:lib` Host/Client、`build:desktop`、`pnpm pack` 均通过 |
| Host SHA-256 | `01e3d2801cd989379e9c73e4de95092634c487130690110c6aafcfd7b341c489`，与 Linux 产物一致 |
| Client SHA-256 | `9eceeba94d932aecd635a63df5af0dee8012634504eb0475a3471f2cdfb2b4d2`，与 Linux 产物一致 |
| 插件 tarball | `.local/build/packed-studio/eadp-studio-studio-plugin-0.0.0.tgz`；SHA-256 `364869cb26ab511ad61c797246e81e5cae93e7656a76c88165acca4b59ffe772`；含 patch、Host/Client JS、类型声明与 manifest |
| 本地回归 | Windows focused 测试通过，覆盖固定 pnpm 参数、含中文/空格/shell 特殊字符的 cwd、旧操作拒绝与失败退出传播；脚本语法、仓库检查及 diff 检查通过 |
| 首次打包尝试（历史） | 在 `.local/build/dsh` 设置正确 `DSH_DESKTOP_PACKED_EXTRA` 后运行 `pnpm run package:desktop:win:x64:unsigned`，退出 1：缺少 `apps/desktop/.env.windows`；该阻塞随后已解除，后续结果见下文 |
| 本地日志 | 首次装配失败：`.local/logs/assemble-plugin-windows-20261014.log`；修复后成功：`.local/logs/assemble-plugin-windows-20261014-retry.log`；打包失败：`.local/logs/package-desktop-windows-20261014.log` |

以上只证明 Windows 源码准备和插件/桌面代码装配通过，不表示安装程序、安装后默认 Studio、会话生命周期或 G0 通过。日志和完整执行现场仅保存在本机。

### HTTP 更新策略续跑（2026-10-14）

用户已明确更新检查直连 `http://100.119.183.44/api/v0/check_client_update?scenario=launch`，不要求 HTTPS，也不以尚未建立后端阻断打包或首次启动；`https://www.zyjsm.top` 用于下载。已停止远端部署和证书准备。

- 先实际复现固定上游打包配置和运行时配置两处拒绝该 HTTP origin，再通过产品 `build/desktop-policy-edits.mjs` 维护锚定发行编辑；装配时只重放至 `.local/build/dsh`，不修改 `.local/upstream/dsh`。策略请求 origin 与默认页面 origin 的配置解析接受 HTTP/HTTPS，保留凭证、路径、query、fragment 检查；下载页动作和登录 origin 仍保持原 HTTPS 约束。原开发 loopback 参数及其上游调用/测试统一移除，没有新增传输开关、后端服务或 fallback。
- 本地 Windows 发行配置选择匿名策略，origin 为 `http://100.119.183.44`，下载页白名单为 `https://www.zyjsm.top`。主 Agent 实测目标策略路由返回 HTTP 404 JSON `NOT_FOUND`；这表示后端路由尚未实现，不是更新策略成功。
- 上游 `main.ts` 已使用 `void mandatoryPolicy.check('launch')`，没有等待远端检查后才继续启动。网络失败原本保持当前状态：首次为 `blocking=false`、`error=unavailable`；已识别 `40005` 后的失败保留禁止状态，只有合法允许响应才解除。没有禁用请求或在无请求时伪造允许结果。
- 真实生成代码回归 3/3 通过：HTTP/HTTPS 与非法 URL 校验、编辑幂等及源码缓存不变；真实 loopback HTTP 的 404、HTML、连接拒绝、超时；启动继续先于请求完成；`40005`、失败保留和合法解除。补丁后的上游两份 focused suites 共 57/57 通过；Windows pnpm focused 1/1、脚本语法、仓库和 diff 检查通过。沙箱先出现 loopback `EACCES` 与 Vitest 临时目录 rename `EPERM`，在沙箱外运行同一测试通过；产品代码未加入环境绕过逻辑。
- 主 Agent 复检已找到 Visual Studio 2022 Community，官方 `probeDesktopToolchain('win32')` 返回空失败列表，原 C++ 工具阻塞已解除。HTTP 发行编辑后的完整装配及发行流水线进展见下文；安装包及原生首启仍待最终结果。

- 产品首启窗口：真实执行固定上游 `openInitialWindow` 及其 `needsWelcome` 谓词，复现无账号/Key 时进入 Welcome。新增受管 `build/desktop-startup-edits.mjs`，仅将冷启动窗口选择改为直接进入 Studio 工作区，保留语言、退出/恢复、后端就绪检查及函数外账号/Key 配置入口；不预置凭证、不写跳过标记。focused 执行回归 4/4 通过；实际安装包的无预置状态首启与 Studio DOM 仍待 Windows 集成验收。

### 发行流水线进展（更新至 2026-10-15）

- HTTP 版完整 `prepare-studio-plugin.mjs` 装配成功，配置与工具链检查通过；本轮 focused 回归重新执行 11/11 通过。装配日志为 `.local/logs/assemble-plugin-windows-http-20261014.log`，打包预检日志为 `.local/logs/check-package-windows-http-20261014.log`。
- 初版完整官方 Windows unsigned 流水线已完成 `build:official`、DSH/vendor/native 打包、生产依赖装配及通用运行时/Host smoke。`apps/desktop/.desktop-build/targets/win-x64/package-set/desktop-packages.json` 有 299 条记录，包含 `@eadp-studio/studio-plugin@0.0.0`；物理生产运行时依赖也包含该包。后续实际安装证明这些检查没有覆盖 Studio 的有效解析与激活，不能将通用 smoke 记为 Studio 通过。
- 初次完整流水线因 Electron 官方下载网络问题失败。主 Agent 随后验证 Node 显式继承本机代理可读取官方校验清单，并重跑原流水线；该轮进入 `electron-builder` 后，在 `icons-bundle.tar.gz` 下载完成后的缓存 rename 报 `EBADF`，完整命令退出 1。日志分别为 `.local/logs/package-desktop-windows-http-20261014.log`、`.local/logs/package-desktop-windows-http-proxy-20261014.log`；不能因上游阶段通过就记录整条打包成功。
- 主 Agent 按官方下载 SHA-256 校验准备工作区图标缓存。系统 C 盘缓存文件/目录 rename 反复 `EBADF`；转入工作区后，官方 `icon-tool.js` 又因继承仓库根 `type: module` 出现 `require` 错误。最终仅在忽略的本地缓存目录设置 `package.json` 为 CommonJS，使用工作区 `TEMP/TMP` 和 `ELECTRON_BUILDER_CACHE` 隔离官方工具环境；官方图标工具独立执行通过，没有修改官方工具。
- 随后按官方导出的环境/参数直接重试既有 `electron-builder` 阶段退出 0，日志 `.local/logs/retry-windows-builder-isolated-cache-20261015.log`；最终通用 packaged runtime smoke 也退出 0，日志 `.local/logs/smoke-windows-artifact-20261015.log`。这是原完整命令退出 1 后的分阶段续跑成功，不是原完整官方命令通过或官方断点恢复。

### 初版安装失败与生产依赖修正（2026-10-15）

- 初版 unsigned 安装程序为 286,447,870 bytes，SHA-256 `c894f362e4c951cb361be2ef777e30edb1a516108500c7c8419c1774f93782f3`。`.local/logs/windows-artifact-20261015.json` 记录 ASAR 含 Studio `lib/index.js`、`lib/client.js`、`cordis.patch.yml`，包 metadata 的策略 origin 为 `http://100.119.183.44`。该校验值仅标识首启失败的历史初版，不作为修正后新包的校验值。
- 开发机安装到 `.local/installed/eadp-studio` 退出 0，安装后 exe/ASAR 校验值与产物一致。使用全新应用数据真实启动却显示官方空新会话页，`data-studio-panel="studio"` 数量为 0；profile 的 bundles 虽包含 Studio，也未形成实际激活。该结果不是干净机证据，更不是 Studio 首启成功。
- 根因已实证：安装 ASAR 中的 Host 报 `ERR_MODULE_NOT_FOUND`，Studio 行为 `disabled=false`、`hasFiber=false`；`createRuntimeResolution` 共 532 个 entries，但 Studio entries 为空。物理包、包集和 profile 均存在不等于正式解析图包含该包。初版仅扩 `ROOT_PACKAGES`，未把 Studio 纳入 CLI 的正式 production dependencies；裸目录 smoke 的物理解析掩盖了安装 ASAR 中正式依赖闭包的缺失。
- 新受管 `build/desktop-plugin-edits.mjs` 向上游 `apps/cli/package.json` 的 `dependencies` 加入 `@eadp-studio/studio-plugin: workspace:*`，使插件进入正式 CLI 生产依赖闭包；删除旧的人为 `ROOT_PACKAGES` 扩根，保留额外 tarball 输入及默认 profile bundle。所有发行编辑仍只重放到 `.local/build/dsh`。
- StudioPanel 同时改为填满父主区域；原生 CDP 验证增加 `bringToFront` 与 `fillsMainArea` 判定，避免只凭一个可见 marker 认定满窗成功。
- 修正后完整 prepare 已退出 0，日志 `.local/logs/assemble-studio-production-dependency-20261015.log`。随后完整官方 `pnpm run package:desktop:win:x64:unsigned` 及最终 packaged runtime smoke 均退出 0，日志 `.local/logs/package-windows-production-dependency-complete-20261015.log`；最终产物与原生验收见下一节。

## 最终 Windows 验证件与原生验收（2026-10-15）

最终安装包位于 `artifacts/windows/deepseek-harness-0.2.1-alpha.2-win-x64-unsigned.exe`，286,455,922 bytes，SHA-256：

```text
59d583377f44451b75472a04ada5024efea95f604bd0c55883cf66df54b9b9ff
```

`artifacts/windows/SHA256SUMS.txt` 保存同一校验值。该包取代初版失败制品；产品基线为 `c8e28be` 加本轮未提交源码修正，不宣称干净 Git 构建。

| 验证项 | 实际结果与证据（本机忽略目录） |
| --- | --- |
| 完整官方 unsigned 管线 | 退出 0，含最终 packaged runtime smoke；`.local/logs/package-windows-production-dependency-complete-20261015.log` |
| 包集 / ASAR | `desktop-packages.json` 299 项含 Studio；ASAR 有 Host/Client/patch，CLI 正式生产依赖为 Studio `0.0.0`；`.local/logs/windows-artifact-20261015.json` |
| 实际 ASAR Host | 独立 profile 的官方 resolution 包含 Studio，Host `hasFiber=true`，import 成功，client graph 含 Studio；`.local/diagnostics/native-studio-host-after-14026427/verification-summary.json` |
| 开发机更新安装 | 用户确认可关闭后，静默安装退出 0；安装目录 `.local/installed/eadp-studio`，EXE 与 ASAR SHA-256 均匹配最终构建；`.local/logs/windows-install-final-20261015.json` |
| 全新应用数据首启 | 退出 0，无预置账号/Key；唯一可见 `data-studio-panel="studio"`，`fillsMainArea=true`，主区域与面板均为 999×780；profile bundles 含 Studio；`.local/acceptance/studio-first-launch-d5Cmxi/result.json`、同目录 `studio.png` 已目视核对 |
| 真实模型 | 用户在原生设置配置；`deepseek-account / deepseek-flash` 完成真实回复。此前 `company / deepseek-flash` 连续重试后报 `Stream ended without finish_reason`，保留失败，不能称所有通道通过 |
| 追加 / 事件 | 同会话 `G0_APPEND_OK`；运行中出现“排队发送”，排队输入进入后续 turn 并返回 `G0_RUNNING_APPEND_OK`；前台绘制后队列余项为 0；`.local/logs/model-foreground-queue-20261015.json` |
| 单次审批 | 原生审批卡出现；同一 approval ID 在 seq103 asked、seq104 decided，结果 `allowed-once`；指定验收文件内容一致，turn8 completed。卡片在自动点击前已被批准；没有记录为 Agent 完成点击，也未更改全局权限 |
| 取消 | 实际停止控件触发，turn5 `aborted`，原因 `user`；取消发生在首个模型请求前，不代表已验证流式中途取消 |
| 重启恢复及续聊 | 最终安装后打开原会话；前 113 条事件 SHA-256 与重启前完全一致，seq 单调增长至 131；turn9 由 `deepseek-account / deepseek-flash` 以 resume 发起，经历两次 503 后上游重试成功，返回 `G0_RESTART_OK` 并 completed；`.local/logs/model-session-before-restart-20261015.json`、`model-events-summary-20261015.json`、`model-restart-ui-20261015.json` |

原生检查脚本已修正两项取证问题：`main` 槽位包装采用 `display: contents`，应测量其实际布局容器；GUI 必须显示并等待绘制后截图。早期截图只包含“正在加载设置”，不作为 Studio 截图证据。最终运行保存了实际 Studio 画面且只清理本次拥有的进程树；未通过磁盘 PID 终止用户其他进程。

上述会话能力是同一固定上游原生宿主的真实验收，Studio 本身仍是显示 `EADP Studio` 的最小面板；没有将其称为五阶段业务界面已实现。会话前半段使用初版原生 core，恢复续聊使用最终安装版本。凭证和完整 AI 现场只存本地，不入 Git。

## 未完成与验收边界

- 原源码权限、C++ 工具、发行配置与打包故障均已解除。指定 HTTP 更新路由尚未建立，当前为 `unavailable`，未阻断打包及首启；有效更新策略响应、定时/手动更新和签名发行未验收。
- 尚无独立干净 Windows 机器/VM 安装结果；开发机隔离数据不能替代该验收。官方 DSH 共存、生产升级/卸载资格亦未验证。本轮只证明本任务自有安装目录的一次更新和会话数据保留。
- 未验证模板依赖、模板规则加载与静态 Mock（G0-3），也未完成 G0-1 的全部业务入口及其他 G0 门槛。
- `release.lock.json` 记录 dependency/native build 为 true，`distributionVerified`、`targetReleasePocVerified`、`releaseReady` 仍为 false。

## 下一步（Windows 工作站）

1. 使用上列最终哈希制品在独立干净 Windows 环境验收安装与首启；另测官方 DSH 共存、升级/卸载边界。无环境证据前不提高发行状态。
2. 重建仍在 `<共享根>/.local/build/dsh` 设置 `$env:DSH_DESKTOP_PACKED_EXTRA='<共享根>/.local/build/packed-studio'`，运行 `pnpm run package:desktop:win:x64:unsigned`；产品源码改变后先重跑产品装配。签名发行按正式前提执行。
3. 继续模板及其他 G0 业务门槛，区分最小插件、原生宿主和产品业务流程的证据，不复用旧制品哈希。
4. 同一任务分支交接；本轮修正尚未提交或推送。
