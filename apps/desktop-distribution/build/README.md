# 桌面发行装配

本目录维护固定 DSH 源码之上的产品装配脚本和唯一授权的上游锚定编辑。`../release.lock.json` 固定上游提交、包版本与归档校验；`.local/upstream/dsh/` 是只读取证缓存，`.local/build/local-workbench-dsh/` 是可重建装配树，二者都不是维护源码位置。

所有编辑只写入装配树。每个编辑都要求精确锚点唯一存在；锚点缺失、重复或部分应用都会抛错并中止，不得在缓存或装配树中手工修补。宿主缺口与编辑的对应关系见 [`docs/blocked-upstream.md`](../../../docs/blocked-upstream.md)。

## 入口与静态检查

```sh
pnpm check
pnpm build:plugins
pnpm build:desktop
```

- `pnpm build:plugins` 调用 `prepare-workbench.mjs`：校验固定源码，装配 `eadp-contracts`、`eadp-shell`、`eadp-requirements`、`eadp-prototype`、`eadp-knowledge`，依次完成 Host 编译、官方 Typert 生成、Client 编译、各包 `tsc --noEmit`、插件打包和产物回执校验。五个 tarball 写入 `.local/build/packed-workbench/`。
- `pnpm build:desktop` 仅支持原生 Windows x64。它复用同一装配入口，运行官方打包预检和 NSIS 流程，将 `packed-workbench` 作为额外包输入，产出未签名安装包及 SHA-256 回执。不安装、不启动桌面，不执行模型或原型验收。
- `node apps/desktop-distribution/build/verify-workbench-distribution.mjs <dsh-resource-directory> <runtime/eadp-tools-directory>` 校验解包后的五包回执、生产依赖解析、模板/知识资源和完整 Node/pnpm 文件清单。
- `pnpm dev:desktop --prepare` 是 Windows 开发准备入口；本重构的静态门禁不执行该命令，也不启动 Electron。

构建锁防止并发装配相互覆盖。依赖升级脚本在固定源码变化后删除 `local-workbench-dsh` 与 `packed-workbench`，并把验收状态重置为未通过。静态构建成功不代表桌面验收或生产就绪。

## 插件与资源装配

`workbench-edits.mjs` 将 `@eadp/shell`、`@eadp/requirements`、`@eadp/prototype`、`@eadp/knowledge` 加入 CLI 生产依赖；`@eadp/contracts` 随四个插件的依赖闭包进入安装结果。`cordis.patch.yml` 显式声明各插件的 service 与 slot 依赖。

## profile 装配

桌面 profile 的 bundle 组合由应用自己拥有，但组合内容仍取自固定上游的 `PROFILE_TEMPLATES.web`，不复制模板常量。`eadp-profile.ts` 是新增维护源码，装配为 `apps/desktop/src/eadp-profile.ts`，导出四个 `@eadp/*` bundle 清单和 `deployEadpProfile()`：保留作者已安装 bundle 及其顺序、base bundle 缺失时前置、EADP 四个锁定在列表末尾，列表无变化时不写文件。

部署在 `DesktopProjectManager.applyRelease()` 内、`createPluginProfile()` 之后执行，因此每次 Host 启动前都会收敛：升级后新增或移除的上游 bundle 会生效，官方 recovery 重置 bundle 列表后 EADP 也会重新出现。recovery 的 `sanitizeProfile()` 实参同时带上 `withEadpBundles()`，保证重置结果本身包含 EADP。四个 `@eadp/*` bundle 是锁定的应用组合：作者在插件管理器里取消勾选后，下次 Host 启动会重新加入，这是已接受的产品决策。应用自己的补丁不写入 profile 的 `cordis.patch.yml`（用户层，recovery 会备份并丢弃）。

原型模板唯一维护位置是 `packages/eadp-prototype/assets/prototype-template/`。装配只复制 manifest 允许且 SHA-256 匹配的文件。npm 打包同时使用 `assets/prototype-template.tar.gz` 保留 `.npmrc`、`.gitignore` 等名称；官方 `prepare:dsh` 阶段解包并拒绝额外成员、链接、逃逸路径和回执不符。

内置知识只从 `packages/eadp-knowledge/resources/builtin/` 的 manifest、`SOURCES.md` 和已登记卡片装配。用户知识库位于本机应用数据目录，不进入发行负载。

`workbench-payload.mjs` 对五个包记录当前维护源码摘要和实际输出哈希到各自的 `workbench-build.json`。缺文件、空产物、旧源码回执或哈希变化均失败。

## 保留的锚定编辑

下表列出全部编辑文件及其锚点。新增文件由对应模块原样写入；所有替换均 fail-closed。

| 维护模块 | 上游文件与锚点 | 用途 |
| --- | --- | --- |
| `desktop-brand-edits.mjs` | `scripts/client-build-environment.ts` 的 `DSH_CLIENT_TITLE`；桌面品牌、协议、安装器与 smoke 文件中的固定 DeepSeek Harness 文案和 `dsh` 协议锚点 | 设置 `eadp studio` 产品身份、`eadp-studio://`、独立用户数据与 DSH_HOME |
| `desktop-startup-edits.mjs` | `apps/desktop/src/main.ts` 的完整 `openInitialWindow`、welcome Host 连接块及 `nativeTheme/net/protocol` 导入锚点 | 直接进入本地工作台；保留原生 welcome 请求的同源 Host cookie 约束 |
| `desktop-profile-edits.mjs` | `apps/desktop/src/project-manager.ts` 的 `@deepseek-ai/dsh-app-boot` 导入块、`applyRelease` 内 `createPluginProfile` 之后、`disableAllPlugins` 的 `sanitizeProfile(...)` 调用；并新增 `apps/desktop/src/eadp-profile.ts` | 每次 Host 启动前幂等部署 EADP 组合；recovery 重置 bundle 列表后仍保留四个 `@eadp/*` bundle |
| `workbench-edits.mjs` | `apps/cli/package.json` 的 `@deepseek-ai/dsh` 生产 dependencies，四个依赖必须原先不存在 | 将四个新插件纳入 CLI 生产依赖闭包 |
| `workbench-runtime-edits.mjs` | `apps/desktop/scripts/prepare-runtime.ts` 的 `prepareCommandLink` 导入和 `readPrimaryRuntime` 前锚点 | 在官方运行时准备阶段生成固定 `eadp-tools` |
| `workbench-runtime-edits.mjs` | `packages/subprocess/subprocess-local/src/index.ts` 的 `windows-job` 返回锚点 | Windows Job 不可用时拒绝运行，不退化为无进程树约束的执行 |
| `prepare-eadp-tools.mjs`、`eadp-runtime.lock.json` | 新增 `apps/desktop/scripts/prepare-eadp-tools.{mjs,d.mts}` 与锁文件 | 只交付锁定 Node 22.22.3 和 pnpm 11.28.5；下载字节、展开文件和工具入口全部校验，不含 Git/SSH |
| `prototype-template-edits.mjs` | `apps/desktop/scripts/prepare-dsh.ts` 的 `runtime:manifests` 步骤前锚点 | 在运行时清单前校验并展开 `@eadp/prototype` 模板归档 |
| `prototype-template-edits.mjs` | `prepare-runtime-manifests.ts` 的 fs 导入与 `electron-builder-config.mjs` 的 Office 导入锚点 | 装载模板 file-transformer，避免把模板源文件当已安装依赖清单处理 |
| `studio-packaging-edits.mjs` | `package-target.ts` 的 `build:official` 与 macOS 并发参数锚点 | 使用官方 artifact 范围构建，并在 Windows 使用有界并发打包 |
| `studio-packaging-edits.mjs` | `desktop-build-commit.mjs` 的 packaged commit 环境锚点 | 让 Client 与桌面回执使用同一产品 Git 快照 |
| `studio-packaging-edits.mjs` | `prepare-package-set.ts` 的 tarball `package.json` 读取锚点 | 用相对 tarball 名称避免 GNU tar 将 Windows 盘符解释为远程主机 |
| `workbench-edits.mjs` | `prepare-package-set.ts` 的 path 导入和默认 inputs 锚点 | 接收内部设置的 `DSH_DESKTOP_PACKED_EXTRA` 五包 tarball 目录 |
| `studio-typert-edits.mjs` | `packages/typert/generator/src/workspace.ts` 的 WorkspaceAnalyzer `.analyze()` 锚点 | 使用固定上游已有的 `analyzeInBatches()` 限制反射内存 |
| `model-selection-edits.mjs` | `agent/src/model-selection.ts`、`agent/src/runtime-types.ts`、`agent-loop/src/agent.ts` 的模型通知与 pre-step 类型/调用锚点 | 共享模型切换通知监听，并把最终 prompt assembly 传到通知处理 |
| `primary-runtime-edits.mjs` | `scripts/primary-runtime/prepare.ts` 的导入、staging、资源准备和函数注释锚点 | 对 primary-runtime 源码和二进制负载做哈希后复用，排除 Python 执行生成的 `__pycache__`、`.pyc`、`.pyo`，避免运行检查使缓存失效；缺失或损坏仍从锁定归档重建 |

`eadp-profile.ts` 是 `desktop-profile-edits.mjs` 的新增维护源码；`prototype-template-archive.mjs` 与 `prototype-template-transform.mjs` 是上述模板编辑的新增维护源码；`workbench-runtime-edits.mjs` 同时登记其三个新增运行时文件。任何新增文件不再存在于维护目录都会使装配失败。

## 已删除的旧编辑

协同 HTTP 策略、秘密凭据 IPC、旧设置桥/分组、内嵌 Chromium 与画布、原型浏览器 IPC、原生 prompt/control admission、旧 Studio 插件/领域包/模板载荷均已删除。最终装配不引用这些模块，不携带浏览器运行时，也不配置协同更新服务。篡改 shipped profile 常量（`SHIPPED_PROFILE`/`WEB_PROFILE` 替换）的编辑同样已删除，改由 `desktop-profile-edits.mjs` 在每次 Host 启动前部署应用组合。

Windows 公共示例 `windows-package.env.example` 只保留产品 App ID。既有机器本地 `.env.windows` 不会被覆盖；其中如仍有旧部署配置，需要由维护者显式清理，本仓库不读取或迁移其秘密值。
