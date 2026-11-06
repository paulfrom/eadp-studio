# 实施切片与验收

状态：实施计划，尚未执行。证据见 [evidence.md](evidence.md)；流程见 [user-flows.md](user-flows.md)；权限见 [permissions-runtime.md](permissions-runtime.md)。

## 1. 实施原则

- 先建立可运行的需求与原型纵向链路，再删除被替换的旧源码。开发期旧代码可以暂存，但最终发行只装配新实现，不保留新旧双模式、旧 API 模拟或 fallback。
- 每个切片必须能在真实桌面观察到行为；构建成功、类型检查通过不等于切片完成。
- 切片前置核实失败时登记仓库缺口清单（当前 `docs/blocked-upstream.md` 缺失，见 README 第 6 节），受影响能力不宣称完成；不靠 cwd、提示词、UI 隐藏或应用内互斥补称权限保证。
- 仓库不新增测试代码或测试命令。每切片执行根 `pnpm check`、受影响构建和真实桌面操作/样本；最终执行 `pnpm build:desktop` 并在安装产物上验收。
- 本轮只完成文档，不修改产品代码、不提交/推送/发布。实施前重新记录 HEAD 与工作区变更，保护唯一未提交成果与活动任务。当前工作区 `docs/` 下旧设计/ADR/`blocked-upstream.md` 为删除状态；不自动恢复，见 README 第 6 节。

## 2. 前置核实（切片 0，不交付产品行为）

在任何代码改动前，用固定 rc.2 源码和真实桌面核实：

| 项 | 核实方法 | 记录/失败处理 |
| --- | --- | --- |
| Workspace 服务 | 在 EADP profile 中确认 `workspaceRegistry`、`workspaceController`、`ui-workspace`、`fs-sandbox`、`sandboxPolicy` 已装载 | 未装载：记录缺少的 bundle/服务；不自建项目注册表替代 |
| 会话绑定 | `sessionController.create({workspaceId,agentPreset})` 或 `agents.create(meta.cwd)+attachSession`；session cwd realpath = workspace.path | 失败：改用 setup 显式注册；仍失败登记阻塞 |
| 会话恢复 | 关闭/重启后 `Workspace.sessionIds`/`sessionQuery` 可列出；resume 时 guard/context 重新注册 | 无法恢复：记录实际错误；不伪造历史 |
| guard 覆盖 | 真实模型调用 read/write/edit/glob/grep/pwsh/run_code/spawn_agent/MCP/插件工具 | 任一通道未覆盖：记录工具名；受影响验收不通过 |
| `ctx.fs` | `resolve/contains/stat/readText/writeText(replaceIfVersion/createIfAbsent)/watch`；Host 显式 sandboxPolicy | 行为不符：记录并调整；不得声称跨外部进程原子 |
| 工具 schema | `defineTool` output schema/render；对象 `additionalProperties`；`required:true` | 不满足即修正，不进入工具接入 |
| 浏览器打开 | `window.open(hostLoopbackUrl)` 是否外开系统浏览器 | 失败：登记 blocked；不恢复内嵌画布 |
| 原型运行时 | 模板 Umi 端口注入/输出 URL；Node/pnpm 选择；Windows 进程树停止 | 失败：记录实际行为，调整端口/停止策略，不伪报成功 |
| 知识内容 | 内置初始卡片的出处/适用范围/版本；用户知识库的创建/修改/删除 | 内置内容未定：可用少量确认卡片；用户可自行补充，不再把完整文档集作为阻塞；不能用示例冒充业务规则 |

## 3. 纵向切片

### 切片 1：本地项目工作台骨架

**用户可观察行为**

- 首次启动不出现协同登录，不要求后端/Git；首页显示 Workspace 列表（可为空）。
- 新建/打开项目；重启后从官方 Workspace 列表重新打开；同一目录别名不重复登记；目录丢失显示不可访问与重新定位/移除。
- 工作台显示需求/原型两个空页签与原生会话；模型/设置使用 DSH 原生界面；创建/恢复一个项目会话并能聊天。
- 不出现场景、基线、交接、协同任务入口。

**影响模块与前置接口**

- `contracts`：`ProjectId`（WorkspaceId 字符串）、`SessionRole`、slot 名、基础错误码。
- `eadp-shell` Host：`agent/created`/resume 时按 cwd 解析 Workspace，注册 guard 与动态上下文；活动文档登记；会话角色/preset。
- `eadp-shell` Client：首页、工作台布局、原生会话承载；官方 `ctx.workspaces`/`ctx.uiWorkspace`/`ctx.slots`/`ctx.remote`；requirements 客户端 `flushActive` 接口占位（实现前为空实现）。
- `desktop-distribution`：新插件装配的最小骨架；仍可暂用旧 build 脚本的通用部分，但新面板是唯一入口。

**删除的旧实现**

- 新装配中移除协同登录、ProjectDialog 的 namespace/GitLab 语义、旧阶段导航（场景/需求/基线/交接）、旧设置中的协同账号/连接/模板项。
- 旧 `StudioService.command` 不再作为新面板入口；旧业务代码在切片 6 删除前不进入发行。

**检查与真实桌面验收**

- `pnpm check`；受影响插件构建；启动开发桌面。
- 无协同服务/无网络启动；新建项目（空目录/已有文件目录）；打开已有项目；重启后重新打开；别名；目录删除后重新定位/移除；原生会话创建/恢复；模型选择/设置可用。
- 失败：Workspace 创建失败、目录不可读、会话创建失败，均显示实际原因；不自动重建/清空。

**失败恢复与退出条件**

- 目录丢失：保留登记与提示；重新定位成功后才删除旧登记；失败保留旧登记。
- 会话创建/恢复失败：保留项目，允许新会话；不删除历史。
- 退出：以上真实桌面行为通过，且无登录/后台协同重试；否则不进入需求切片。

### 切片 2：需求编辑与保存（无 AI）

**用户可观察行为**

- `需求/` 文件树；新建/打开/改名/删除 Markdown；无 `需求/` 时按需创建。
- 编辑正文，自动保存；中文 IME 正常；切换文档/项目/关闭前离场保存；外部改动可检测；保存失败保留输入。
- `CONTEXT.md` 作为独立背景入口，可创建/编辑，不进入需求列表。
- 重启后正文一致；不需要登录/协同/Git。

**影响模块与前置接口**

- `eadp-requirements` Host：`ctx.fs` 读/版本/写；`createIfAbsent`/`replaceIfVersion`；Node fs 目录/改名/删除；路径 containment；拒绝根外/敏感/保护路径。
- `eadp-requirements` Client：文件树、编辑器、`DraftBuffer`（去掉场景 metadata）、IME 组字、外部改动提示、离场 flush；实现 `flushActive` 客户端服务。
- `eadp-shell`：切换/关闭前调用 `flushActive`；活动文档登记。
- `contracts`：RequirementEntry/Document、FileVersion、ContextDocument、错误码。

**删除的旧实现**

- `MaterialEditor` 的场景/需求 metadata/模板/来源/确认字段；`RequirementWorkspace` 的来源/候选/门禁；`RequirementMetadataForm`、`RequirementGates`、`RequirementSourcePanel`、`RequirementCandidatePanel`。
- `RequirementSaves` 的远端三阶段/占用/revision/idempotency；`requirement-sources`、`requirement-candidates`、`scenario-*` 的保存/确认调用链。
- 需求模板绑定、`ScenarioFrontmatter`/`eadp-metadata` 解析、材料文件类型映射。
- 保留并抽象 `DraftBuffer`/`useDraftBuffer` 的草稿/外部改动/串行保存能力，删除场景字段。

**检查与真实桌面验收**

- 新建/改名/删除/子目录；中文连续输入、组字中切换；快速切换文件；外部编辑器改动；磁盘/权限失败；重启；CONTEXT 创建/编辑/外部改动。
- 失败样本：版本过时、文件被外部删除、目录只读、文件名非法/已存在；均保留输入与原文件。
- `pnpm check` + 受影响构建。

**失败恢复与退出条件**

- 保存失败：状态“未保存”，输入保留，重试可用；不更新已保存版本。
- 外部改动：干净可刷新；脏文档显示差异，不静默覆盖。
- 离场失败/组字中：阻止切换/关闭并说明；强杀例外。
- 退出：以上通过，且无旧 metadata/模板/确认入口；否则不进入 AI 提案切片。

### 切片 3：AI 需求提案

**用户可观察行为**

- 选中需求 → 需求会话（`eadp-requirements` preset）读取当前需求（工具返回 path/text/version）。
- AI 生成单文件提案；审阅面板显示目标、摘要、行级差异、基于版本；用户应用/丢弃。
- 应用前核对版本、草稿、组字、活动项目；过时拒绝覆盖；应用后编辑器基准更新。
- AI 不能直接写需求/CONTEXT；删除旧聊天代码块解析/确认门禁后仍完整可用。
- CONTEXT.md 支持同样提案；目标固定，不扩成任意根目录写入。

**影响模块与前置接口**

- `eadp-requirements` Host：`eadp_requirements_list/read`、`eadp_requirement_propose` 工具；提案内存；`applyProposal`/`discardProposal`；版本核对；`defineTool` output schema/render。
- `eadp-shell` Host：在 agent setup/`agent/created` 注册 guard/动态上下文；需求角色只读。
- `eadp-shell` Client：提案面板/差异渲染；调用 `applyProposal`；处理迟到回包。
- `contracts`：RequirementProposal、ProposalDiff、请求/错误形状。
- 前置：切片 0 的 guard/fs 核实；切片 2 的保存/草稿能力。

**删除的旧实现**

- 聊天 `eadp-write-proposal` 代码块解析、`hasWriteProposal`/`parseWriteProposal`、`ScenarioWriteProposalCard`/`WriteReceiptCard` 的聊天协议。
- `material-confirmations`、`material-write-changes` 的章节确认/选择性应用、`ReviewPanel`、`RequirementGates`、来源/候选/拆分/一致性调用。
- 需求确认、材料确认、模板/场景绑定、写入回执等旧状态/命令/契约。
- 旧 `session/prompt-admission` 拦截如不再需要则一并删除（新方案不拦截原生 prompt）。

**检查与真实桌面验收**

- 真实模型读取当前需求并生成提案；未点击应用前文件不变；应用后文件变化、版本更新；丢弃不变。
- 脏草稿、组字中、保存飞行中、应用期间新输入、迟到保存回包、过时版本、外部改动；逐项验证保留草稿/提案与拒绝覆盖。
- CONTEXT 不存在/已存在/外部改动/提案创建/应用冲突。
- `pnpm check` + 受影响构建。

**失败恢复与退出条件**

- 提案生成失败/未读/版本不符：不生成；保留聊天与输入。
- 应用失败/过时/组字：不写；保留提案与草稿；可重新生成。
- 重启：提案丢失；文件与聊天历史保留；可重新生成；不宣称提案持久化。
- 退出：真实模型闭环与竞态样本通过；否则不进入原型切片。

### 切片 4：原型创建、文件查看、运行与停止

**用户可观察行为**

- 原型页；从模板创建 `原型/`（不覆盖非空目录）；只读文件树/文本查看；敏感/依赖/构建文件过滤；大小上限。
- 依赖安装（用户点击、固定 pnpm、`--frozen-lockfile`）；运行（固定 `pnpm run start`、Host 选端口、真实就绪）；系统浏览器打开 loopback URL；停止进程树。
- 端口占用、依赖缺失、启动超时、进程崩溃、停止失败均显示实际原因与重试；重启后状态为 stopped。
- 不出现内嵌画布/自动浏览器验收/任务队列/基线/发布。

**影响模块与前置接口**

- `eadp-prototype` Host：`ctx.fs` 只读列表/读取；模板复制；Node/pnpm 运行时；受管进程启动/停止/输出；端口/就绪；运行状态表；孤儿记录。
- `eadp-prototype` Client：文件树/查看、安装/运行/停止/打开浏览器、日志/诊断。
- `eadp-shell`：原型页 slot；退出时让 prototype Host 停止自有进程。
- `contracts`：PrototypeEntry/Content、RunState、RunLog、错误码。
- 前置：进程原语、模板打包、Umi 端口/就绪核实、`window.open` 核实。

**删除的旧实现**

- `prototype/preview.ts` 的 synthetic preview/实例就绪端点；`checks.ts` 的 typecheck/lint/build/浏览器检查；`generation.ts` 的 task identity/sourceSha/inputHash；`check-journal`、`build-workspace`、`publication`、`snapshot`。
- `PrototypeCanvas`、`PrototypePreview`、`PrototypeWorkbench` 的队列/候选/复用/画布/自动验收；`PrototypeEditor`/DirectoryTree 中写编辑与任务依赖。
- `browser-provider/scope/runtime/attachments`、`browser-check`、`desktopPreviewCanvas`、`studio-prototype-bridge/view`、`prepare-studio-browser`、`studio-browser.lock`、Chromium 资源。
- Git worktree/任务占用/基线/发布/复用/交接收悉相关原型调用。

**检查与真实桌面验收**

- 创建原型（空/非空目录）；查看大文件/二进制/隐藏敏感文件/越界路径/链接；安装依赖（成功/失败）；运行（成功/端口冲突/依赖缺失/超时/崩溃）；系统浏览器可操作；停止（正常/失败/重复）；切换项目/关闭应用；重启；孤儿识别。
- `pnpm check` + 受影响构建。

**失败恢复与退出条件**

- 失败保留工程/日志/上次文件；不自动重装/改锁/杀未知进程；不伪报 running。
- 停止失败显示 PID/日志并允许重试；退出只结束自有进程树；强杀孤儿按 pid+启动时间核对。
- 退出：浏览器真实可操作、停止真实生效、失败可诊断；否则不进入原型 AI 切片。

### 切片 5：原型 AI 修改与知识库（内置 + 用户）

**用户可观察行为**

- 原型会话（`eadp-prototype` preset）读取需求/知识，按用户指令修改 `原型/`；文件查看/运行反映变化。
- 原型 AI 不能写需求/CONTEXT/其他项目/保护目录；shell/run_code/MCP/插件工具被拒；越界有明确原因。
- 知识库页签：搜索内置与用户知识；内置卡只读，用户卡可新增/修改/删除；用户填写标题、出处、范围、标签、正文。
- AI 可提议新增/修改用户知识卡；提案在知识库页签审阅，用户应用后才写入；内置卡不可被 AI 修改。
- 知识库搜索/读取/引用：命中带 packId/packVersion/documentId/source/scope；未命中与损坏分开；引用可追溯。
- 用户新增/编辑知识卡后，搜索/引用立即可用；AI 提案应用后同样更新；重启后用户卡仍在（未应用提案丢失）；Agent 不能直接写知识。
- 需求会话也能读取知识；知识不自动写入需求。

**影响模块与前置接口**

- `eadp-prototype` Host/Client：原型会话策略、文件刷新、运行联动；不新增代码提案。
- `eadp-requirements` Host：需求读取/提案工具可供原型会话使用；提案仍只写 Host 内存。
- `eadp-knowledge`：内置包 manifest/卡片；用户包存储/manifest/hash/version；搜索/读取工具；`eadp_knowledge_propose` 提案/应用；知识库 UI；`eadp.knowledge.view` slot。
- `eadp-shell` Host/Client：原型角色 guard、动态上下文；知识页签/active；不读写知识卡。
- `contracts`：KnowledgePack/Card/Draft/Proposal/Reference/Hit/Read、错误码、slot。
- 前置：内置初始卡片来源确认、用户知识库存储根/UI、AI 提案/应用与 guard 反向核实。

**删除的旧实现**

- `prototype-collaboration`、`prototype-candidates`、`prototype-integrations`、`prototype-baseline-workspace`、`prototype-material-context`、`prototype-requirement-identities`、`prototype-runtime-repair`、`remote-merges`、`candidate-merges`。
- `prototype-browser-tools`、`prototype-runtime-tools`、`prototype-material-tools`、`prototype-requirements`、`scenario-sources`、`consistency-*`、`reviews`、`handoff-*`。
- 场景/交接/基线/候选/复用/发布/自动浏览器相关 UI、命令、契约与资源。
- 旧资料导入（pdfjs/Office-to-PDF）；知识包首版只收 Markdown，不保留旧资料上传/转换链路。

**检查与真实桌面验收**

- 真实模型读需求→改原型→刷新/运行→浏览器可见；反向矩阵（需求写入、CONTEXT、其他项目、保护目录、链接、shell、run_code/MCP、子 Agent、未绑定会话）逐项记录工具名/结果/前后摘要。
- 知识：内置卡搜索/读取/引用；用户卡新建/编辑/删除；AI 提案新增/修改→用户应用/丢弃/过时；中文短语/混合词/单字/零命中/同标题/续读/超长/取消；包损坏/版本不符；外部文件变化/重启；Agent 无知识直接写入。
- `pnpm check` + 受影响构建。

**失败恢复与退出条件**

- 越界拒绝不修改目标；工具不可用记录为“不可用”，不冒充“已验证拒绝”。
- 知识损坏只影响知识能力；需求编辑/原型运行继续；用户知识表单失败保留内容。
- 退出：真实模型下的原型修改与权限反向样本通过；内置卡可读 + 用户卡可增改删/引用/重启 + AI 提案需用户确认后才写入；否则不进入退役切片。

### 切片 6：旧实现退役与发行

**用户可观察行为**

- 最终安装包只包含新插件；无协同登录/场景/确认/基线/交接/任务队列/候选/复用/发布/内嵌画布/自动浏览器入口。
- 无 collaboration-api/PostgreSQL/GitLab 依赖；无随包 Chromium；无应用管理 Git。
- 完成完整闭环：本地项目 → 需求编辑与 AI 提案 → 原型修改 → 运行/浏览器 → 停止 → 重启恢复；知识检索/引用与用户知识库（含 AI 提案确认写入）可用。
- 文档、领域语言、检查脚本、发行说明与实际一致。

**影响模块与前置接口**

- 全包；`desktop-distribution` 的插件装配/模板/运行时/payload/verify；根 `scripts`、`pnpm check`；`cordis.patch.yml`；品牌/启动/运行时/打包锚定编辑；`docs`、`CONTEXT.md`、根 `README.md`、`AGENTS.md`。
- 前置：切片 1–5 真实桌面通过；旧成果已保护；最终 build 产物可安装。

**删除的旧实现**

| 范围 | 删除 |
| --- | --- |
| 包 | `packages/studio-plugin`、`packages/asset-domain`、`apps/collaboration-api` |
| 后端 | `db/schema.sql`、`start-backend.sh`、部署/容器/环境入口、协同 API 客户端/认证/凭据键 |
| 契约 | 场景/确认/基线/交接/成员/占用/任务/候选/复用/发布/旧 API schema；保留/新增需求、原型、知识、文件、slot 契约 |
| 发行装配 | `prepare-studio-browser.mjs`、`studio-browser.lock.json`、`studio-browser-runtime.md`、`studio-browser-edits.mjs`、`studio-browser-check.ts`、`studio-prototype-bridge.ts`、`studio-prototype-view.ts`、`--browser-runtime` 步骤、browser archives/packed-studio 旧产物 |
| 锚定编辑 | `native-prompt-edits`（若不拦截 prompt）、`studio-secret-store`/密钥 IPC、settings bridge/sections、画布/浏览器相关编辑；保留品牌、插件装配、运行时资源、打包/typert、必要的启动编辑，并逐条复评 |
| 资源 | 旧 locale 场景/交接文案、场景/需求模板、旧 skills 中不再被新 persona 引用的部分、模板 preview/check 脚本、playwright/pdfjs/undici 等旧依赖 |
| 模板 | 原型模板移到 `packages/eadp-prototype/assets/`；保留 `pnpm run start` 所需工程与锁；移除 `__eadp_preview_ready`/synthetic-only/preview 脚本；更新 manifest 与 `pnpm check` 路径 |
| 文档 | 旧设计顶部历史说明/新入口；根 README/CONTEXT/AGENTS/发行说明/仓库缺口清单同步 |

**检查与真实桌面验收**

- `pnpm check`；`pnpm build:desktop`；最终安装包在无 collaboration-api/PostgreSQL/GitLab 的环境启动；不弹登录/无协同请求。
- 完整闭环 + 中断/失败/恢复样本（见第 6 节）；安装产物中的插件入口、模板、运行时、资源校验通过。
- 旧用户项目/数据目录不在安装/启动时清理；DSH 会话历史与模型凭据保留。

**失败恢复与退出条件**

- 锚点或产物校验失败：中止构建，修正维护源码后重建；不绕过校验、不手工改缓存/装配树。
- 安装/启动失败：保留日志与数据目录，给诊断；不清空 profile 掩盖。
- 退出：最终安装包完成闭环且无旧协同依赖；文档/规则同步；未验证项列明。否则不宣称交付完成。

## 4. 删除范围与依赖

- **必须删除**：协同 HTTP/认证/凭据、场景/确认/基线/交接/任务队列/候选/复用/发布、应用管理 Git/worktree/冲突合并、内嵌画布/浏览器运行时/自动浏览器验收、仅服务旧 API 的 schema/HTTP 状态/远端客户端/配置。
- **保留/抽取**：受管进程原语（抽取到 prototype）、路径/敏感文件/扫描限额策略、`DraftBuffer`/离场保存、行级 diff、诊断日志、模板 manifest/归档机制、品牌编辑、运行时资源准备、打包/typert 适配。
- **不保留**：向后兼容层、旧 API 本地模拟、双目录读取、数据 migration、断网 fallback、空实现/假成功。
- 删除前按引用核查实际调用方，不能只删菜单；旧设计文档标注历史，不继续作为现行规范。
- 旧用户成果保护与旧代码退役分开：先只读列出研发仓库外的用户项目、未提交正文、原型文件和活动任务；只保全无法从 Git/锁定制品重建的成果；不复制缓存/node_modules。旧项目由用户手工整理到 `需求/`、`原型/`；不开发导入器。旧会话历史归 DSH，不因删除业务任务而删除消息；活动任务先记录已落盘文件与未完成动作再停止。

## 5. 验收矩阵

| 场景 | 操作 | 必须观察 |
| --- | --- | --- |
| 首次启动无协同 | 断网/无 collaboration-api 启动 | 正常进入首页；无登录、无后台协同重试；模型请求失败如实报告 |
| 新建项目 | 新建空目录/已有文件目录 | Workspace 登记；不预建/不移动文件；需求/原型空状态正确 |
| 重新打开 | 关闭/重启后打开最近项目 | 同一 Workspace；需求正文一致；会话可恢复；运行状态 stopped |
| 别名/复制/搬移 | 链接别名、复制目录、移动目录 | 别名复用；复制为新 Workspace 不串用；搬移新建登记删旧，旧会话不迁移且如实说明 |
| 目录丢失/移除 | 外部删除目录；从最近移除 | 不可访问 + 重新定位/移除；不重建；移除只删登记；运行/轮次处理正确 |
| 需求创建/改名/删除 | 正常与冲突/非法名 | 文件实际操作；失败保留原名/原文件 |
| 中文编辑 | 连续输入、组字中切换/关闭/应用 | 不丢输入、不半段提交；必要时阻止离场 |
| 外部改动 | 外部编辑器改干净/脏文档 | 干净刷新；脏文档保留草稿并给选择；不静默覆盖 |
| 保存失败 | 只读/磁盘满/权限 | 输入保留、状态未保存、可重试；不更新基准 |
| AI 提案 | 真实模型读取→提案→应用/丢弃 | 未应用不落盘；应用后版本更新；丢弃不变；差异/出处可核对 |
| 提案竞态 | 脏草稿/组字/飞行中保存/新输入/迟到回包/过时 | 不覆盖新输入；保留草稿与提案；过时拒绝并可重新生成 |
| CONTEXT | 不存在/存在/外部改动/提案创建 | 无隐式创建；创建不覆盖并发文件；不进入需求列表 |
| 原型创建/查看 | 空/非空目录；大文件/二进制/敏感/越界 | 不覆盖非空；只读正确；过滤/截断/错误清楚 |
| 原型运行 | 安装/运行/浏览器/停止 | 真实页面可操作；真实停止；URL 为本次 loopback |
| 运行失败 | 依赖缺失/端口占用/超时/崩溃/停止失败 | 实际原因 + 日志 + 重试；不伪报；不杀未知进程 |
| 切换/退出 | 运行中切项目/关应用/强杀重启 | 旧进程归属清楚；退出停止自有进程；重启不恢复 running；孤儿可识别 |
| 原型 AI | 真实模型改原型 | 成功且浏览器可见；需求/CONTEXT/其他项目/保护目录/shell 被拒；目标不变 |
| 知识 | 内置卡搜索/读取/引用；用户卡新建/编辑/删除；AI 提案新增/修改→用户应用/丢弃/过时；零命中/损坏/版本不符/外部改动/重启 | 出处/版本正确；用户卡保存后可用；AI 提案未应用前不变；Agent 不能直接写；不阻断编辑/运行 |
| 最终发行 | 安装包启动、无旧服务 | 无协同/旧插件/浏览器运行时；完整闭环通过；旧文件/历史保留 |

## 6. 竞态与恢复样本

1. **草稿 + 提案**：脏草稿时让 AI 生成提案 → 应用前继续输入/组字 → 应用应拒绝或保留新输入；不得覆盖。
2. **在途保存**：自动保存飞行中点击应用 → 等待保存；若期间又有新输入，应用失败并保留输入；旧保存回包不得覆盖应用结果。
3. **提案过时**：生成后外部修改/用户手动保存 → 应用返回过时；保留提案、草稿、磁盘新内容；可重新生成。
4. **迟到回包**：切换项目/重定位后旧保存/提案/运行回包到达 → 按 workspaceId/epoch 丢弃；不写入新项目。
5. **重复/别名/搬移**：两个真实目录、同目录别名、目录搬移 → 身份/会话/进程不串用；旧请求不重定向。
6. **CONTEXT**：不存在、创建、编辑、外部改动、AI 提案、应用冲突 → 同需求规则；不扩为任意根文件写入。
7. **原生工具越界**：真实模型经 write/edit/read/glob/grep/pwsh/run_code/MCP/插件工具尝试写需求/CONTEXT/其他项目/保护目录 → 每个可用通道拒绝；记录工具名/结果/前后摘要。
8. **原型进程**：端口占用、依赖缺失、启动超时、崩溃、停止失败、强杀重启 → 真实状态/日志/重试；只结束自有进程树。
9. **关闭/重启**：flush 失败阻止关闭；强杀后重启 → 文件/Workspace/会话恢复；运行 stopped；草稿/提案丢失如实说明。

## 7. 检查、构建与证据

- 每切片：`pnpm check`；受影响插件构建（Host→Client 顺序、Typert 生成）；真实桌面启动。
- 最终：`pnpm build:desktop`；在安装产物上执行第 5/6 节闭环与失败样本。
- 仓库不新增测试代码/测试命令；不恢复旧测试体系；不照搬 Editor 测试脚本。
- 证据记录：仓库提交、安装包标识/哈希、DSH 固定提交与版本、插件版本、真实模型/Provider、样本项目与文件、操作步骤、实际结果、日志路径、未验证项。未知服务版本写“未知”，不猜测。
- 本轮只改文档：`pnpm check` 已通过（396 跟踪文件、48 模板哈希、`releaseReady=false`）；未修改产品代码/构建输入，因此没有受影响的构建需要执行；这不构成新实现或桌面验收。

## 8. 文档与规则同步（切片 6）

- 根 `README.md`、`CONTEXT.md`、`AGENTS.md`：移除协同/场景/确认/基线/交接/任务/浏览器验收叙述；项目结构表改为新包；生产门槛改为本地闭环；保留“真实桌面、固定版本、唯一成果保护、无兼容层”等仍有效规则。
- 旧设计文档：当前工作区已删除（见 README 第 6 节）；不从 Git 自动恢复，不继续以现行规范出现。若用户确认恢复，再补历史说明与新入口。
- 仓库缺口清单（当前 `docs/blocked-upstream.md` 缺失，需按 AGENTS 恢复/重建）：删除已消失的绕过（协同策略/秘密 IPC/设置桥/浏览器视图/消息准入等）；新增/保留 Workspace 路径不可变、会话存储路由、`ctx.fs` 无目录操作、subprocess 无沙箱、系统浏览器打开、默认 bundle、运行时资源、构建适配。
- `apps/desktop-distribution/build/README.md`：逐条记录保留/新增锚定编辑的用途、锚点、失败行为；锚点缺失即失败。
- 开发/构建脚本说明、模板 manifest、`pnpm check` 目标、发行说明同步；不保留指向旧包/旧模板路径的入口。

## 9. 未验证项（交付前必须逐项核对）

- 固定 profile 是否装载 Workspace/fs-sandbox/sandboxPolicy；会话创建/恢复的 cwd/attach 行为。
- guard 对真实模型全部工具通道的覆盖；agent scope guard 在 resume/子 Agent 的行为。
- `ctx.fs` 版本写/watch/stat/显式 sandboxPolicy 的 Windows 实测。
- `window.open` 外开；Umi 端口注入/就绪输出；进程树停止/孤儿识别；原型运行不受 DSH 沙箱的边界呈现。
- 原生会话关闭/重启后的列表/resume；Workspace 搬移后的旧会话/旧请求行为。
- 内置知识包初始内容、用户知识库存储/UI、AI 知识提案/应用、索引、中文检索、引用/版本/损坏样本。
- 真实模型完成需求提案与原型修改的完整闭环；中断/失败/恢复样本。
- 最终安装包无协同/旧插件/浏览器运行时；旧用户文件/DSH 历史/模型凭据保留。

以上未验证项未通过前，不宣称切片完成、不宣称生产就绪。
