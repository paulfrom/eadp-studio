# 本地需求与原型工作台改造

状态：实施设计，尚未实施。日期：2026-11-05。基线 `62d896d15edf0cf39f2a4ba549190dbfdbc01066`；工作区已有 `README.md` 修改、未跟踪的 `docs/refactoring/`，以及 `docs/` 下旧设计/ADR/发行说明的删除（`git status` 为 `D`）。本轮只新增/修订文档，不修改产品代码、不提交、不推送、不发布。

## 1. 总体目标

沿用 DSH Editor 的成熟结构：普通文件夹承载项目、Markdown 承载需求、DSH 承载原生会话。最终形成一个简单、完整、可维护的本地工作台：

1. 用户创建、打开、重新打开本地项目；无需登录、协同后端或 Git。
2. 一个项目包含多份需求 Markdown 和一个普通原型代码工程。
3. 用户直接编辑需求；AI 读取需求、提出修改，用户审阅后应用。
4. AI 根据一份或多份需求修改原型；用户查看文件、运行、停止，并在系统浏览器操作页面。
5. 固定知识库随应用发行，为需求与原型提供只读参考和可追溯出处；用户可按自己的情况新增/修改本机知识库，AI 可提议、用户确认写入。
6. 继续复用 DSH 的会话、模型、授权和设置，不自建另一套 Agent、权限或模型系统。

完成闭环：本地项目 → 需求编辑与 AI 提案 → 原型修改 → 运行与浏览器操作 → 停止及重启恢复；最终发行不依赖旧协同实现。

## 2. 产品范围

EADP 只保留需求与原型：

- 项目 = DSH Workspace（持久身份 + canonical 目录 + 会话归属），不是自建项目表。
- 需求是 `需求/` 下的普通 UTF-8 Markdown；用户可直接编辑，AI 只能提出修改，由用户审阅后应用。
- 原型是 `原型/` 下的普通代码工程；AI 可修改，用户查看文件、安装依赖、运行、停止，并在系统浏览器操作。
- 知识库由随包内置只读卡和用户可维护的本机知识卡组成；Agent 可读取/提议，不能直接写，回答带出处与版本。
- 会话、模型、授权、设置、审批继续复用 DSH；不自建 Agent、模型注册或权限系统。

删除：场景、材料确认状态、开发认领、协同任务队列、候选集成、基线、交接、复用采用、协同登录、远程后端、应用管理的 Git 流程、内嵌预览画布、随包 Chromium、自动浏览器验收。

不提供：旧 API 本地模拟、旧目录双读、数据 migration、断网 fallback、兼容层。

## 3. 本轮关键决策

| 决策 | 内容 | 理由/代价 |
| --- | --- | --- |
| 项目身份用 DSH Workspace | `WorkspaceId` + `Workspace.path`；项目文件夹不写 `.eadp/project.json` | rc.2 已有持久 Workspace 与会话归属，Editor 也这样做；避免自建注册表和“重复 ID”冲突。代价：身份是机器本地登记，复制目录即新项目 |
| 目录搬移 | 新建 Workspace + 删除旧登记；旧会话留在旧 cwd 历史，不迁移 | Workspace.path 创建后不可变，宿主无跨 Workspace 搬移接口；不通过自建注册表绕过 |
| 文件版本 | 用 `ctx.fs` 的 `FsVersion`、`replaceIfVersion`、`createIfAbsent`、`contains` | 固定宿主已有版本条件写入、原子替换、每目标锁；不自建摘要/锁 |
| 需求 AI 写入 | 预设关闭 write/edit；只允许 `eadp_requirement_propose` 写 Host 提案内存 | 用户审阅是写入授权；提案与文件版本独立核对 |
| 原型 AI 写入 | 预设开放 write/edit；guard 限 `原型/`；fs-sandbox 再限项目根 | 工具层可到子目录，OS 层只能到项目根；两层叠加，不靠 cwd/提示词 |
| AI 执行命令 | 不授予 shell/subprocess/run_code；安装/运行由用户点击 Host | shell 的 OS 沙箱只能到项目根，无法限到 `原型/`；subprocess 无沙箱 |
| 原型运行 | 只支持模板约定工程，固定 `pnpm run start`，Host 选端口、等就绪、返回 loopback URL | 不引入通用 runner/任意命令配置；运行不等于验收 |
| 系统浏览器 | 客户端 `window.open` Host 核验的 loopback URL；删除内嵌画布/浏览器运行时 | 用户明确要求系统浏览器；无官方插件打开服务，已登记 |
| 需求提案 | 首版单文件整篇提案；不做多文件原子应用/选择性 hunk | 单文件 `replaceIfVersion` 可原子完成；多文件会制造部分失败/回滚假象 |
| 草稿与提案持久化 | 草稿只在编辑器内存；提案只在 Host 内存；正常关闭前 flush，强杀可能丢最后输入 | 普通文件是唯一内容权威；不制造第二份正文/提案库 |
| 知识库 | **内置只读知识卡 + 本机用户知识库**；用户可新增/修改/删除；AI 可提议新增/修改，用户确认后 Host 写入；Agent 不能直接写 | 沿用 Editor 的“少量卡片 + 出处/版本 + 只读读取”形态；知识提案与用户知识库解决“按用户情况补充”，不作为项目正文或第二套 Agent |

## 4. 文档入口

| 文档 | 责任 |
| --- | --- |
| [evidence.md](evidence.md) | 基线、当前实现事实、Editor 参考、rc.2 宿主接口、缺口与冲突 |
| [architecture.md](architecture.md) | 包职责、依赖、项目/身份/权威状态、保存与 AI、权限与运行摘要 |
| [user-flows.md](user-flows.md) | 从启动、项目、需求、提案、原型、运行到关闭/重启的完整流程与失败恢复 |
| [permissions-runtime.md](permissions-runtime.md) | 工具通道矩阵、guard、fs 边界、原型进程、浏览器、反向验收 |
| [implementation.md](implementation.md) | 前置核实、纵向切片、删除范围、验收矩阵、检查与未验证项 |
| [eadp-shell](packages/eadp-shell.md) | 项目首页、工作台、原生会话、会话策略与上下文 |
| [eadp-requirements](packages/eadp-requirements.md) | 需求文件、编辑保存、外部改动、AI 提案、CONTEXT.md |
| [eadp-prototype](packages/eadp-prototype.md) | 原型文件、模板、依赖、运行、停止、浏览器 |
| [eadp-knowledge](packages/eadp-knowledge.md) | 内置知识卡、用户知识库、搜索/读取、工具与引用 |
| [contracts](packages/eadp-contracts.md) | 跨端合同、请求校验、slot、错误码 |
| [desktop-distribution](packages/desktop-distribution.md) | 固定宿主、插件装配、模板/运行时、发行裁剪 |
| [studio-plugin 退役](packages/studio-plugin-retirement.md) | 单体拆分、旧命令/界面/流程删除 |
| [asset-domain 退役](packages/asset-domain-retirement.md) | 旧资产模型删除与必要文件规则归还 |
| [collaboration-api 退役](packages/collaboration-api-retirement.md) | 后端、数据库、认证与调用方删除 |

## 5. 参考基准

- EADP 固定 DSH：`apps/desktop-distribution/release.lock.json` 的 `687f282e8625c6b8d11ff58211a90524be2e4317` / `0.2.1-rc.2`；不升级宿主来迁就参考代码。
- Editor 参考：`D:/project/skills/dsh-editor`，提交 `52450c6a0235d9bf07654d3fecf15f071ce45599`；它绑定 rc.5，只借机制，不复制代码/补丁/私有 RPC/root 遮蔽。
- 上游缓存 `.local/upstream/dsh/` 只作取证；新增发行编辑仍只能进入 `apps/desktop-distribution/build/`，锚点缺失即失败，并登记 `build/README.md` 与仓库缺口清单（当前 `docs/blocked-upstream.md` 缺失，见第 6 节）。

## 6. 旧文档与仓库文档的当前状态

当前工作区 `docs/` 下除本目录外的旧设计、ADR、发行说明已被删除（`git status` 显示为 `D`）。本目录是唯一现行方案入口；不自动从 Git 恢复旧文，也不把旧文与现方案拼用。仍有效的旧决定在本目录继承；被本次范围取消的旧流程不执行。若这些文件是误删，需要用户确认后再从 Git 恢复；恢复前不写回、不引用。

仓库要求的 `docs/blocked-upstream.md` 也在本次删除范围内，当前不存在。目标方案的缺口已记录在 [evidence.md](evidence.md) 第 6 节与 [implementation.md](implementation.md) 的前置表；实施前需按 AGENTS 恢复或重建该登记文件，不能因为没有该文件而跳过缺口登记。

`CONTEXT.md`、根 `README.md`、`AGENTS.md` 仍在工作区；切片 6 同步它们，本轮不修改仓库规则与领域语言。

## 7. 待提供与未验证

**待提供**

- 内置知识包的初始卡片内容与出处（少量、团队确认、标注适用范围）。用户知识库可由用户自行新增/修改，也可由 AI 提议、用户确认写入；因此不再把“完整业务文档集未提供”作为阻塞；但内置卡不能用旧产品设计文档或未标注的示例冒充业务规则。
- 原型模板是否保留现有 Umi/React/SUID 技术栈与 Mock 资源围栏；本方案沿用现有模板，仅去掉预览/检查专用链路。

**未验证（必须在真实桌面核实后才能进入下一步）**

- EADP profile 是否实际装载 `workspaceRegistry`、`workspaceController`、`ui-workspace`、`fs-sandbox`、`sandboxPolicy`。
- `sessionController.create({workspaceId,agentPreset})` / `agents.create`+`attachSession` 的实际行为；resume 时 setup/guard 是否重新执行。
- guard 是否覆盖真实模型可用的全部工具通道（含 `pwsh`、`run_code`、MCP、插件工具、子 Agent）。
- `ctx.fs` 的 `replaceIfVersion`/`createIfAbsent`/`watch`/`stat` 在 Windows 的实际行为，以及 Host 显式 sandboxPolicy 是否被接受。
- `window.open` 在固定 desktop 是否外开系统浏览器。
- Umi 开发服务器的端口注入/就绪输出、Windows 进程树停止、崩溃后孤儿识别。
- 原生会话在关闭/重启后的列表与 resume；Workspace 目录搬移后的旧会话行为。
- 真实模型下的完整闭环：需求编辑 → 提案 → 原型修改 → 运行/浏览器 → 停止 → 重启恢复。
- 用户知识库的创建/修改/删除、版本更新、外部文件变化、重启持久化；AI 知识提案的读取/生成/审阅/应用/过时/丢弃；Agent 不能直接写知识。

## 8. 完成标准

当前交付版本必须真实完成“本地项目 → 需求编辑与 AI 提案 → 原型修改 → 运行与浏览器操作 → 停止及重启恢复”的闭环，并完成内置/用户知识检索、引用与 AI 知识提案确认写入；最终发行不依赖协同后端、旧 Studio 插件、内嵌浏览器或旧业务流程。构建成功、类型检查通过都不等于桌面验收通过；未验证能力必须逐项列出，不宣称生产就绪。

生产门槛仍受仓库 `AGENTS.md` 旧“场景→需求→原型→基线→交接”链路约束；实施切片 6 必须把它替换为本地闭环门槛，并同步 `CONTEXT.md`、根 `README.md`、旧设计与发行说明。本轮不修改这些仓库规则。
