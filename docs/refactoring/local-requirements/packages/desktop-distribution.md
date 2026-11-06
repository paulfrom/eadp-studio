# desktop-distribution：新工作台的发行装配

状态：目标改造，尚未实施。入口见 [方案总览](../README.md)；证据见 [evidence.md](../evidence.md)。

## 1. 目标

继续使用固定 DSH `687f282e8625c6b8d11ff58211a90524be2e4317` / `0.2.1-rc.2`，不升级宿主，不附带升级技术路线。发行层负责：固定上游获取校验、桌面品牌、官方插件组合、构建、随包必要运行时、模板/内置知识资源、安装产物完整性与启动诊断。

装配目标：`@eadp/shell`、`@eadp/requirements`、`@eadp/prototype`、`@eadp/knowledge` + `@eadp/contracts`。不再装配 `@eadp-studio/studio-plugin`、`@eadp/asset-domain`、collaboration-api、浏览器运行时或内嵌画布。

不负责业务状态机；不把插件业务代码放进 build 脚本；不携带 PostgreSQL/GitLab/协同凭据；不随包携带 Chromium；不强制 Git。

## 2. 当前证据

- `release.lock.json` 固定 DSH commit/tag/archive hash；`--check` 的 acceptance 仍为 `releaseReady=false`。
- `build/prepare-studio-plugin.mjs` 负责装配 Studio 两半、打包 tarball、replay 锚定编辑、模板/技能/browser 资源；`studio-payload.mjs` 断言 `StudioService/composeStudio/StudioApplication` 与模板/browser 清单；`verify-studio-distribution.mjs` 复核已装资源。
- `build/desktop-plugin-edits.mjs` 把插件声明进 CLI 依赖/`prepare-package-set.ts`/`project-manager.ts` 的 shipped profile。
- `build/prepare-studio-browser.mjs`、`studio-browser.lock.json`、`studio-browser-edits.mjs`、`studio-browser-check.ts`、`studio-prototype-bridge.ts`、`studio-prototype-view.ts` 是内嵌浏览器/画布链路。
- 模板以 `assets/prototype-template.tar.gz` + manifest 随 npm 包发布，`prepare:dsh` 阶段解包/校验；`pnpm check` 以 48 条 manifest hash 为唯一真源。
- `scripts/build-desktop.mjs` 的 `--browser-runtime` 依赖预置浏览器 zip；正式打包使用 `DSH_DESKTOP_PACKED_EXTRA`、`ELECTRON_BUILDER_CACHE`，产物复制到 `artifacts/windows/`。

## 3. 建议结构

```text
apps/desktop-distribution/
  release.lock.json
  build/
    README.md
    desktop-brand-edits.mjs
    desktop-build-lock.mjs
    desktop-plugin-edits.mjs
    desktop-startup-edits.mjs        # 复评：无账号欢迎页时是否仍需要
    desktop-policy-edits.mjs          # 复评：删除协同 HTTP origin 专属部分
    primary-runtime-edits.mjs         # 保留：运行时复用
    prepare-eadp-plugins.mjs          # 新：装配四个插件包
    eadp-payload.mjs                  # 新：清单/摘要/模板/内置知识资源
    verify-eadp-distribution.mjs      # 新：已装资源复核
    prepare-eadp-tools.mjs            # 新：Node/pnpm 运行时
    eadp-template-edits.mjs           # 新/改：模板归档与解包
    ...必要的上游精确锚定编辑
```

名称可在实施时按现有约定调整；不为改名创建兼容导出。现有通用装配工具优先沿用；职责变化后再更名。插件源码归 packages，发行装配只消费构建产物。

## 4. 插件组合与 patch

- `cordis.patch.yml` 新增四个插件行，按官方格式声明 `inject`/slot/服务依赖；不隐式依赖。
- 两个 agent preset：
  - `eadp-requirements`：只读 fs、需求/知识工具、提案；不挂 shell。
  - `eadp-prototype`：读写 fs、需求/知识工具；guard 限 `原型/`；不挂 shell。
- 不保留旧 `eadp-scenario` preset、场景/需求模板 persona、`studio-plugin` 行。
- 客户端半边通过 `package.json` 的 `dsh.client` 与 `exports["./client"]` 被发现；Host 半边用 Typert Remote，签名变化重跑生成器。
- 插件 patch 文件不得依赖旧 Studio 的 service/slot；新增依赖必须显式声明。

## 5. 构建、检查与运行时

### 5.1 pnpm check

保留：

- Node 引擎、origin、禁止跟踪 `.local`/`node_modules`/密钥、`.local/probe` 忽略。
- 模板 manifest 逐文件 sha256/跟踪/路径/eol 校验。

更新：

- 模板路径从 `packages/studio-plugin/assets/prototype-template*` 改为 `packages/eadp-prototype/assets/prototype-template*`。
- 模板清单移除旧 preview/check/synthetic 资源；保留 `start`、依赖锁、业务 Mock 资源。
- 新增内置知识包 manifest/hash 校验；内置包随发行，用户知识库在应用数据目录，不打包、不迁移。不把内置内容缺失伪装成通过。
- 不新增测试命令；`tests/` 空目录可清理。

### 5.2 build:desktop

目标流程：

1. 原生 Windows x64、Node/pnpm/VS/tar/软链接前置检查（沿用）。
2. 构建锁、冻结安装、`fetch-dsh`（只认 lock）。
3. `prepare-eadp-plugins`：Host→Client 构建、Typert 生成、四包打包、模板/内置知识资源、replay 锚定编辑。
4. 写/校验发行环境；树内安装；官方 `package:desktop:win:x64:unsigned`。
5. 校验 `eadp-payload`/已装资源；调用 `verify-eadp-distribution`。
6. 复制安装包与 sha256 receipt 到 `artifacts/windows/`；失败即中止。

删除：`--browser-runtime` 步骤、浏览器 zip 依赖、旧 `studio-plugin` tarball/payload 断言、旧模板路径、旧 packed-studio 假设。构建必须实际产出四个包 tarball；不能依赖预置旧包。

### 5.3 运行时工具

- 原型运行需要固定 Node/pnpm；保留 `prepare-eadp-tools`（原 `prepare-studio-tools`）的归档/校验/复用机制。
- 删除 Git/SSH 发行工具，除非实际调用方证明仍需要（本方案不需要应用管理 Git/发布）。用户仍可在系统外部使用 Git。
- 锚定 `prepare-runtime` 的准备步骤继续保留并登记 blocked #6；不得手工改缓存/装配树。
- 原型运行/安装不是沙箱执行；运行时只保证固定版本/路径，不保证项目代码安全。
- 内置知识包随插件资源装入并校验 manifest/hash；用户知识库在应用数据目录，不进入 payload/安装包，升级/重装不删除用户知识，不自动迁移格式。

## 6. 保留 / 重写 / 删除

### 保留

- `release.lock.json`、`fetch-dsh.mjs`、`desktop-build-lock.mjs`、`run-pnpm.mjs`、`desktop-processes.mjs`、`build/README.md` 锚点纪律。
- payload 的“清单 + schemaVersion + sourceDigest + 逐文件 sha256”机制；verify 的“对已装资源复核”形态。
- 品牌编辑（产品名/可执行名/AppID/协议/数据目录/安装包名/菜单托盘）、`DSH_HOME`/userData/title/commit 锚定。
- `primary-runtime-edits`（性能复用）、必要的打包/typert/Windows 适配、模板归档/解包机制。
- 仍被新 persona 引用的通用技能；不以“旧 Studio”为由误删原生会话/模型能力。

### 重写

- `prepare-studio-plugin.mjs` → `prepare-eadp-plugins.mjs`：四包构建/打包、模板/内置知识资源、patch/upstream edits 列表。
- `studio-payload.mjs` → `eadp-payload.mjs`：断言新包入口/服务、模板/内置知识资源、无 browser runtime；旧 Studio 断言删除。
- `verify-studio-distribution.mjs` → `verify-eadp-distribution.mjs`：新包/资源/运行时；仍校验实际安装产物。
- `check-repository.mjs` 模板/知识段；`dev-desktop.mjs` 的插件/输入路径；根 README/构建说明。
- `cordis.patch.yml`：新插件/preset；删除旧场景/需求 persona/studio 行。
- `desktop-policy-edits.mjs`：删除仅为协同 HTTP origin 的部分；如产品仍需要更新策略，单独说明并保留 HTTPS-only。
- `desktop-startup-edits.mjs`：复评无账号欢迎页时是否仍需要；不保留仅为旧账号流的改动。
- `studio-template-edits.mjs` → 模板归档/解包适配新路径；不保留旧 preview/check 资源。

### 删除

- `apps/collaboration-api` 整目录、`start-backend.sh`、数据库定义、协同部署/容器/环境入口。
- `packages/studio-plugin`、`packages/asset-domain` 及其 tarball/payload/verify/`DESKTOP_PACKED_EXTRA` 引用。
- `prepare-studio-browser.mjs`、`studio-browser.lock.json`、`studio-browser-runtime.md`、`studio-browser-edits.mjs`、`studio-browser-check.ts`、`studio-prototype-bridge.ts`、`studio-prototype-view.ts`、`--browser-runtime`、浏览器 zip/Chromium、`playwright-core`。
- `studio-secret-store`/秘密 IPC（无协同/发布密钥后）、旧 settings bridge/sections（使用原生设置后）。
- `native-prompt-edits`（新方案不拦截原生 prompt；若仍需要，必须登记并说明）。
- 旧模板 preview/check/synthetic 资源、旧 locale 场景/交接文案、旧场景/需求模板、pdfjs/Office 资料导入（若不再使用）。
- 旧 `packed-studio` 三包产物、旧 browser archives/prepared 目录（仅清理可重建缓存，不删用户成果）。

## 7. 锚定编辑处理

| 编辑 | 处理 |
| --- | --- |
| `desktop-brand-edits` | 保留；更新产品描述/标题/安装包文案，去掉协同/场景语义 |
| `desktop-plugin-edits` | 保留机制；改为四包/新包名；`WEB_PROFILE.bundles` 仍加载 EADP 插件 |
| `desktop-policy-edits` | 删除协同 HTTP origin 专属部分；保留必要的 HTTPS/更新策略并复评 |
| `desktop-startup-edits` | 复评；无账号欢迎页则删除或简化 |
| `primary-runtime-edits` | 保留；运行时复用与校验 |
| `prepare-runtime`/runtime manifest | 改为 `eadp-tools`（Node/pnpm）；去掉 Git/SSH（除非有实际调用） |
| `native-prompt-edits` | 删除；新方案不拦截原生 prompt |
| `studio-typert-edits`/packaging | 保留；仍服务固定上游构建 |
| `studio-template-edits` | 改为新模板路径/归档；移除旧 preview/check |
| 画布/浏览器/秘密/设置编辑 | 删除；对应能力不再存在 |

所有新增/调整编辑必须：锚点缺失即失败、用途记录 `build/README.md`、受影响构建与真实桌面验证；不得改 `.local/upstream` 或 `.local/build` 冒充源码。

## 8. 真实桌面验收

在无 collaboration-api/PostgreSQL/GitLab 的机器或隔离环境：

1. 启动最终安装产物：不弹协同登录；无协同请求/重试；首页/Workspace 列表正常。
2. 新建/打开/重启项目；需求编辑/保存/外部改动；AI 提案应用；原型创建/查看/运行/系统浏览器/停止；知识检索/引用、用户知识库新增/修改/删除与 AI 知识提案确认写入。
3. 界面不存在场景/确认/基线/交接/队列/候选/复用/发布/内嵌画布/自动验收入口。
4. 失败：依赖缺失、端口占用、原型崩溃、停止失败、系统浏览器不可用、Host 启动失败；显示实际诊断/重试，保留文件与数据目录。
5. 退出清理仅限本应用进程/临时目录；不删除 Workspace 文件、DSH 历史、模型凭据。
6. 锚点/产物校验失败即中止；修正维护源码后重建。

记录安装包标识/哈希、DSH 固定提交、插件版本、样本、操作、实际结果、日志、未验证项。构建/安装成功不等于桌面闭环。

## 9. 未验证

- 四包插件在固定 rc.2 profile 的加载/patch/slot/Typert 生成。
- 模板归档/解包/manifest 与新路径；Umi 运行端口/就绪。
- Node/pnpm 运行时准备与原型安装/运行。
- `window.open` 外开、无浏览器运行时下的原型体验。
- 删除协同/浏览器/秘密/设置编辑后的启动、设置、模型、权限行为。
- 最终安装包闭环与无协同依赖。

以上尚未执行；本文不声称发行可用或生产就绪。
