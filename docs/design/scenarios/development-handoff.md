# 场景与需求协作开发交接

日期：2026-10-22
依据：[开发清单](development-plan.md)、[场景设计](01-scenarios.md)、[需求协同设计](../02-requirements.md)、[修正与验证记录](implementation.md)
当前分支：`main`
本轮基线：`06ba48a`（SC02—SC12 已合并至 main）；SC13/SC14 与 Linux 验证在本轮完成

本文只记录交接事实、剩余工作与已知风险，不替代开发清单和设计文档。

## 1. 本轮完成与未完成

SC02—SC14 已实现。SC15 的 Linux 自动化、类型检查及本地 Git 验证已执行；数据库/API 集成有失败项，真实协同双客户端、Windows 实机和真实模型仍未验收，因此本阶段开发与验收没有整体完成。

| 项 | 状态 | 说明 |
| --- | --- | --- |
| SC02 内置 grill 与技能快照 | 已完成 | 技能随包；场景与需求材料会话共用只读 preset、技能目录与归纳式上下文 |
| SC03 项目上下文三方核对 | 已完成 | 写入提议可目标 `CONTEXT.md`；基线/工作区/认可头比较；冲突回对话，不 commit |
| SC03 后端路径范围 | 已完成 | `stage:"template"` 允许项目根 `CONTEXT.md`；仅更新上下文时不要求重复声明模板目录 |
| SC04 写入提议契约与提问触发 | 已完成 | `eadp-write-proposal`、`ScenarioRecord.writeProposal`、按钮消费、过期/幂等/拒绝节流与最小卡片 |
| SC05 整篇生成与整篇写入 | 已完成 | 整篇写入复用受控服务；写入后章节/依据/待答摘要与 hash 检查撤销；需求侧未接 |
| SC06 确认文件包（Host） | 已完成 | `CONTEXT.md` 进入 `metadata.files`，与正文、正式依据同批冻结；逐文件 hash 与根目录白名单 |
| SC06 后端根目录白名单 | 已完成 | 材料/场景批次集成在项目根只放行 `CONTEXT.md`，其他根目录文件拒绝 |
| SC07 可选评审不 commit | 已完成 | `requestReview` 改走只读 `prepareContent`；评审绑定本地 HEAD 与逐文件 hash；确认时才提交一次候选 |
| SC08 确认后台持久恢复流水线 | 已完成 | 候选推送并入 prepare 步骤；丢响应查询原操作；远端头变化在 CAS 前停止；提交/worktree 仍在命令队列 |
| SC09 主项目安全同步 | 已完成 | 接受后后台快进主 checkout；脏目录/异分支/失败记为“已确认待同步”并可重试 |
| SC10 任务身份与逐任务释放 | 已完成 | 会话按 worktree 归属；只释放目标任务句柄、观察与预览 |
| SC11 安全 worktree 清理 | 已完成 | 归档工作区改动与忽略文件（SHA-256）、保留归档引用、删临时分支；步骤持久化且幂等，覆盖评审 worktree |
| SC12 附件入口与资料状态 | 已完成 | 原生输入区附件按钮打开共用资料面板；场景与需求共用资料服务，固定依据保留真实读取状态与范围 |
| SC13 页面精简与状态展示 | 已完成 | 身份、模板固定版本与审计信息已归位；确认检查集中分组；Git 诊断按需展开；写入提议和本机收整状态可见 |
| SC14 删除旧场景协议 | 已完成 | 批次解析/应用、自动写入、采纳 UI/命令/状态及专属测试已删除；保留整篇写入提议和共享附件入口 |
| SC15 分层验证 | Linux 层已执行，整体未完成 | 类型检查、后端单元、Host/客户端及本机 Git 用例通过；数据库/API 集成存在已记录失败；真实协同双客户端、Windows 实机与真实模型仍未验收 |

后端验证已执行：

- `pnpm --filter @eadp/collaboration-api typecheck` 通过。
- `src/gitlab-content.test.ts` 44 项通过；`integration`、`project-initialization`、`auth/gitlab`、`desktop-update` 共 43 项通过。
- Docker 镜像已重建并启动，`GET http://127.0.0.1:6972/health` 返回 `{"status":"ok"}`；api 容器 healthy，数据库与缓存使用本机共用的 PostgreSQL 与 Redis 实例，编排不再自建这两个容器。
- 本轮再次执行 `./start-backend.sh` 重建并重启协同 API；`GET /health` 返回 `{"status":"ok"}`，`eadp-collaboration-api-1` 状态为 healthy。
- 未连接真实企业 GitLab；未执行桌面、真实模型、双客户端或 Windows 实机验收。
- SC07／SC08 桌面/Host 验证：装配树 `tsc -b` host 与 client 通过；评审、确认与恢复均未接真实模型/GitLab。
- SC02 验证：`scenario-preset.test.mjs` 2 项、`scenario-dsh-adapter.test.ts` 6 项通过（含需求会话共用 preset 与技能目录）；真实桌面未验证技能目录挂载（dev-stage 不执行依赖安装）。`tests/scripts` 全量仍有 3 项与本轮无关的环境性失败（缺少 `.desktop-build` 目标、两处样式断言）。
- SC03 验证：`scenario-write-proposals`／`scenario-orchestration` 共 29 项通过（新增上下文提议解析与失效、成功写入并同步文件包、并发接受冲突、提问后文件变化作废）；`tests/windows-desktop` 全量 175 项通过、1 项因未配置测试数据库跳过。未做桌面交互走查，未验证真实模板发布链路。
- SC09—SC11 验证：装配树 `tsc -b` host/client 通过；新增 `task-settlement.test.ts` 3 项（真实临时 Git 仓库）覆盖主目录快进、脏目录待同步、未跟踪/忽略文件归档与幂等收整；`tests/windows-desktop` TS 用例 179 项中 178 通过、1 项因未配置测试数据库跳过。未在真实桌面、真实 GitLab 与 Windows 实机验证本机收整，未连接真实模型。
- SC12 验证：装配树 `tsc -b` host/client 通过；客户端与相关脚本用例 36 项通过，含新增附件组件行为验证；`tests/windows-desktop` TS 用例 183 项中 182 通过、1 项因未配置测试数据库跳过。组件测试的 dialog 行为使用 jsdom shim；未做视觉审查、打包校验或真实桌面/模型验收。
- 本轮 Linux 验证：contracts、asset-domain、collaboration-api 类型检查通过；后端源码单元测试 92 项通过；装配树 Host/Client 类型检查通过；`tests/windows-desktop` 180 项中 179 通过、1 项因该 Host 套件未配置数据库跳过；客户端与脚本 41 项通过，含 3 项场景状态组件验证。Host 用例覆盖真实临时 Git 仓库的主目录快进、脏目录保护、worktree 归档与重试幂等。
- Host 测试使用临时普通 Git 仓库；本轮未执行开发清单要求的临时 bare 仓库集成（首次 push、远端 CAS 与 complete 丢响应恢复），该项仍未验收。
- 数据库/API 集成失败：`backend-lifecycle.test.ts` 在新建项目返回阶段失败，诊断为 `repository.projectView` 查询 schema 已明确删除的 `studio_categories` 表；项目状态被保存为创建中，API 返回 503。该遗留分类路径同时涉及需求分类，按当前范围未在本轮扩展修改。
- `scenario-schema.test.mjs` 在 PostgreSQL 上 9 个子用例通过、1 个失败：`result='cancelled'` 且 `failure_code=NULL` 的 CHECK 表达式产生 SQL UNKNOWN，PostgreSQL 将其视为通过；测试预期拒绝该记录。该一致性比较属阶段二范围，未在本轮调整。
- Linux 未验证临时 bare Git 集成、真实企业 GitLab、真实双客户端、Windows 宿主、真实模型或视觉/打包效果；这些项目仍为未验收。

## 2. 后端新增约束（桌面端实现时必须遵守）

后端改动位于 `apps/collaboration-api/src/gitlab-content.ts`：

- 材料与场景批次集成的 `allowedPaths` 在项目根只接受 `CONTEXT.md`；其他根目录文件即使写入 `metadata.files` 也会以 `MATERIAL_PATH_SCOPE` 拒绝。
- `CONTEXT.md` 若进入 `allowedPaths`，仍须在材料 `metadata.files` 中声明，并提供实际 SHA-256；后端会按固定提交读取并校验。
- `stage:"template"` 的受控配置集成允许 `.template/*.md`、`project.assets.json` 与根 `CONTEXT.md`。只改 `CONTEXT.md` 时 `scenarioTemplates` 可以不变；发布模板文件或清单时仍必须声明模板目录。
- 已发布模板身份不能删除，项目身份与四目录声明不能改写。
- 不新增契约字段、端点或数据库结构；`CONTEXT.md` 的项目级接受复用模板发布的独立候选、独立 worktree 与独立接受流程。

## 3. SC14 旧建议链路清理（已完成）

已删除与「写入提议＋整篇写入」冲突的建议批次协议及全部运行入口：

| 原位置 | 删除结果 |
| --- | --- |
| 共享场景契约与 `ScenarioRecord` | 删除建议批次类型、投影字段和自动写入状态；本地集合布局未变 |
| Host 场景编排与命令分发 | 删除建议解析、字符范围应用、显式采纳、自动写入及两条旧命令 |
| `scenario-suggestions.ts`、`ScenarioSuggestions.tsx` | 两个只服务旧批次流程的模块已删除 |
| `ScenarioChatPanel` 与样式 | 删除建议区、采纳按钮、自动写入开关及专属 CSS；保留写入提议卡、拆分候选与附件入口 |
| 旧协议测试 | 删除只覆盖批次解析/应用/自动写入的测试与 `work/validation/native-adoption/` 专用原生采纳探针；保留提议、候选、评审、修复和附件测试 |

活跃提示词统一描述结论归纳与整篇写入提议。`ScenarioDocumentService` 只保留统一受控保存与 hash 冲突处理，不存在旧协议兼容分支。

## 4. 剩余实施顺序与入口

SC13 页面精简和 SC14 旧链路清理已完成。剩余工作是处理已记录的数据库/API schema 不一致，并继续执行 SC15 的真实双客户端、Windows 实机与真实模型验收；真实环境验收不能由本地类型检查或自动化用例替代。

### SC04 写入提议契约与提问触发（已完成）

开发清单要求：提议记录包含 ID、目标、baseHash、模板固定引用、`CONTEXT.md` hash、依据集合、创建时间；AI 输出不能形成提议或伪造 ID；否认、未答、歧义一律不写。

实施前必须先确定以下工程细节，否则会写出不可判定或可被 AI 绕过的逻辑：

1. **AI 如何表达“是否写入”的提问**。建议沿用现有文本协议模式新增 `eadp-write-proposal` 块，只承载目标与依据 ID；Host 解析后自行生成提议 ID 和全部 hash，忽略 AI 给出的任何 ID/授权字段。
2. **讨论结论如何形成可判定 ID**。提议的依据 ID 集合需要 Host 可核对；建议由同一协议块给出本轮结论 ID，Host 校验其属于当前会话轮次。
3. **提议存哪里**。优先放进 `ScenarioRecord`（例如 `writeProposal` 字段），不新增本地集合。
4. **过期判定**。正文 hash、模板固定引用、`CONTEXT.md` hash、依据集合任一变化即作废；重复消费只生效一次。
5. **触发与节流**。本轮出现新明确结论，或阻断性待澄清清空且核心规则/验收已声明；同一结论被拒后不再问，直到出现新结论。

相关入口：`host/application/scenario-workspaces.ts`（会话回调与记录）、`shared/scenarios.ts`（命令/视图类型）、`host/application/scenario-documents.ts`（受 hash 约束的写入）。

### SC02 内置 grill 与技能快照接入（已完成）

- 快照原文复制到 `assets/skills/`（grilling、grill-with-docs、domain-modeling 与 LICENSE/SOURCE.json），装配时随插件发行；`grill-with-docs` 桩仍调用另外两个技能。
- 场景会话运行时挂载唯一技能目录（`includeDefaultRoots:false`），不读取项目根或用户机器技能；`domain-modeling` 维护业务项目根 `CONTEXT.md`，ADR 产出关闭。
- 场景与需求材料会话共用 `eadp-scenario` preset、技能与归纳式规则：只归纳结论与提问，不写正文。需求会话由 Host 提供当前材料、baseHash、元数据与正文的只读上下文。
- 新会话使用结论归纳和整篇写入提议；旧建议批次协议、解析与 UI 已由 SC14 删除。

### SC03 项目上下文受控保存与三方核对（已完成）

- 写入提议卡可目标项目根 `CONTEXT.md`（唯一路径），仍由用户按钮消费并校验提问时的 `CONTEXT.md` hash。
- 三方比较：任务 worktree HEAD、工作区文件、认可头版本；冲突即拒绝并回对话，不 rebase、不改 expectedHead 重试。
- 保存只在任务 worktree 原子落盘、不 commit，随后把新 hash 同步进场景 `metadata.files`，避免 SC06 确认拒绝。
- 项目级接受仍走模板发布的受控配置链路；研发仓库自身的 `CONTEXT.md` 不受影响。

### SC05 整篇生成与整篇写入（已完成）

- 复用 `client/scenarios/ScenarioWorkspace.tsx:43-46` 的 flush → 命令 → receive 边界、`client/scenarios/DraftBuffer.ts:32,49` 的缓冲，以及 `host/application/scenario-documents.ts` 中带 `expectedHash`、按文件串行写入与冲突双份的保存能力。
- 一次整篇写入，无条目、无分段、无第二次保存确认；写入后给变更摘要与基于本地差异的撤销。
- 撤销是一次新的受 hash 检查写入；流式未完成/取消/失败不产生半篇正文。
- 场景与需求共用同一写入服务。

### SC06 确认文件包（已完成）

- 正文、`CONTEXT.md` 固定引用、选定正式依据在同一候选提交内冻结。
- 复用 `metadata.files` 与 `.eadp/evidence/<sha256>`；后端已限制根目录只放行 `CONTEXT.md`。
- 候选父为认可头，逐文件 hash 精确匹配；完整 diff 仍由服务端校验。

### SC07 可选评审不 commit（已完成）

- `requestReview` 改走 `prepareContent`（`studio.ts`），只读本地任务快照，不提交、不跑工程检查、不写远端。
- 评审绑定 `head` + 逐文件 `{ path, sha256 }` + `inputHash`；worktree 以 HEAD 创建后复制未提交字节（`adapters/workspace/snapshot.ts`）。
- 报告接受前核对快照字节；AI 辅助确认时重算同一指纹，`candidateSha` 只在确认时产生。
- 评审 worktree 与任务登记留给 SC11 统一清理；本轮未新增清理入口。

### SC08 确认后台持久恢复流水线（已完成）

- 候选 push 已并入 prepare 持久步骤，恢复不再跳过首次推送；丢响应查询原操作，远端头变化在 CAS 前停止。
- 材料 commit 与 worktree 创建仍在命令队列；此边界已记录，不声称所有 Git 操作都在后台车道。
- 失败重试不重复接受、不阻塞 UI，具体实现与验证见 `implementation.md`。

### SC09—SC11 同步与清理（已完成）

- SC09：接受后在后台车道快进主 checkout 到认可头；脏目录、异分支与快进失败记为“已确认待同步”，可经 `syncMainCheckout`／`retryTaskSettlement` 重试，不 stash/reset/clean。
- SC10：`sessions.ts` 新增 `releaseWorktree`，只释放目标任务句柄；观察器按 worktree 解除；预览仅随原型任务停止。
- SC11：新增 `task-maintenance.ts`；归档全部工作区改动与忽略文件（SHA-256 清单），保留 `refs/eadp/archive/<project>/<task>`，删除临时分支；步骤逐项落盘且幂等，覆盖任务与评审 worktree。

### SC12 附件入口与资料状态（已完成）

- `conversation.input.left` 注册附件按钮，点击打开复用的资料面板；无会话、恢复中或恢复失败时也保留同一入口，其他会话不展示此按钮。旧折叠组资料入口已删除，旧 AI 建议功能已由 SC14 整体删除。
- 场景与需求使用同一 `MaterialConversation`、资料面板与 `MaterialSources` 服务，保留导入、已读/部分读取/失败、实际范围、重试和正式依据选择；需求资料操作前先 flush 手工编辑，保存失败不继续。旧建议 UI 与协议已由 SC14 删除。
- 图片的已读状态仍以原生 `read_image` 成功结果为依据，校验任务归属、占用与原始 hash；PDF/Office 保留实际读取范围和限制。已确认依据从固定 `reading-*.json` 恢复真实状态，缺失或校验失败明确显示无法验证。
- 沿用现有本地集合、资料目录和受 hash 约束的文档写入服务；未新增需求侧写入提议或撤销。

### SC13 页面精简与状态展示（已完成）

- 身份编号/名称、模板固定引用、本地草稿或固定版本状态与审计时间集中呈现；业务完整性、待澄清项和模板结构检查归入确认检查分组。
- Git 分支、HEAD 与工作树状态仅在按需诊断展开；写入提议显示待回答、失败可重试、已写入或已拒绝；任务显示草稿、已确认待同步、已确认待清理、本机收整完成。
- 保留唯一附件入口与当前色系；普通界面不显示 worktree 信息或机器协议。本轮完成组件/Host 自动化及装配树类型检查，没有 Linux 原生桌面可视化验收或打包校验。

### SC14 删除旧场景协议（已完成，2026-10-22）

- 已删除旧建议解析与范围应用、自动写入、采纳命令及 UI；`ScenarioDocumentService` 只保留统一受控保存。
- 保留需求候选、独立评审、修复与共享附件流程；没有新增或删除本地状态集合。
- 验证：Host/Client `tsc -b` 通过；`tests/windows-desktop/*.test.ts` 179 通过、1 项因未配置测试数据库跳过；客户端与相关脚本 41 项通过；活跃源码/测试无旧协议引用。

## 5. 验证入口

仓库根执行：

```sh
pnpm --filter @eadp/collaboration-api typecheck
cd apps/collaboration-api && ./node_modules/.bin/tsx --test src/gitlab-content.test.ts
```

桌面/Host 代码测试（按 implementation.md 记录，需先有装配树）：

```sh
node apps/desktop-distribution/build/prepare-studio-plugin.mjs --dev-stage
cd .local/build/dsh
node node_modules/typescript/bin/tsc -b packages/eadp/studio-plugin/tsconfig.host.json packages/eadp/studio-plugin/tsconfig.client.json
```

可复用测试入口：

- `tests/windows-desktop/`：`scenario-documents.test.ts`、`scenario-orchestration.test.ts`、`scenario-file-observer.test.ts`、`scenario-dsh-adapter.test.ts`、`background-lane.test.ts`、`projection-lane.test.ts`、`task-recovery.test.ts`、`conversation-restoration.test.ts`、`asset-workflow.test.ts`、`task-settlement.test.ts`。
- `tests/scenario-client/`：`draft-buffer.test.ts`、`document.test.mjs`、`material-editor.test.mjs`、`material-attachments.test.mjs`。
- `tests/scripts/`：`scenario-preset.test.mjs`、`studio-conversation-restoration.test.mjs`、`studio-task-purpose.test.mjs`。
- 后端：`apps/collaboration-api/src/gitlab-content.test.ts`、`modules/integration.test.ts`。

数据库套件需要显式配置 `STUDIO_TEST_DATABASE_URL` 或 `SCENARIO_SCHEMA_TEST_DATABASE_URL`；未配置时跳过，不计入通过。

## 6. 已知风险与未验证边界

- 评审绑定的是本地未提交快照；评审 worktree 现随同实体接受由 SC11 收整，但尚未在真实桌面验证。
- 需求侧（REQ 编号、去分类、一致性对比端点/表）不在本轮范围；`docs/design/02-requirements.md` 的差距仍未实施。
- SC15 尚未完成真实协同双客户端、Windows 实机与真实模型验收；数据库/API schema 不一致和 CHECK NULL 行为见本轮 Linux 验证记录。
- 后端仅验证路径范围与单元行为；真实企业 GitLab、真实 PostgreSQL 运行库、双客户端、Windows 实机与真实模型均未验收。
- SC12 的入口可达性已有组件级验证；桌面端未做视觉审查、打包校验与实机交互验收，本轮不声称桌面可用。

## 7. 建议的下一个会话

1. 修复或按设计删除遗留分类 API 与数据库映射，并修正一致性比较结果的 CHECK NULL 行为；需求分类语义仍按阶段二设计核实。
2. 继续按 SC15 矩阵验证真实协同双客户端、Windows 实机与真实模型；未执行项保持未验收。
3. 需求侧的写入提议、摘要与撤销仍属阶段二，本轮不为需求新增另一套文件规则。
