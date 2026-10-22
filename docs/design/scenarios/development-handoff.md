# 场景与需求协作开发交接

日期：2026-10-22
依据：[开发清单](development-plan.md)、[场景设计](01-scenarios.md)、[需求协同设计](../02-requirements.md)、[修正与验证记录](implementation.md)
当前分支：`backend/scenario-context-path-scope`
已推送提交：`5be1075 协同后端限制项目根文件写入范围`

本文只记录交接事实、剩余工作与已知风险，不替代开发清单和设计文档。

## 1. 本轮完成与未完成

本轮按用户决定只实施**开发清单涉及协同后端**的部分，桌面端未动。

| 项 | 状态 | 说明 |
| --- | --- | --- |
| SC03 后端路径范围 | 已完成 | `stage:"template"` 允许项目根 `CONTEXT.md`；仅更新上下文时不要求重复声明模板目录 |
| SC06 后端根目录白名单 | 已完成 | 材料/场景批次集成在项目根只放行 `CONTEXT.md`，其他根目录文件拒绝 |
| SC03 桌面/Host 三方核对与受控保存 | 未开始 | 任务 worktree 内保存、基线/修改/最新接受版比较 |
| SC04 写入提议契约与提问触发 | 已完成 | `eadp-write-proposal`、`ScenarioRecord.writeProposal`、按钮消费、过期/幂等/拒绝节流与最小卡片 |
| SC05 整篇生成与整篇写入 | 已完成 | 整篇写入复用受控服务；写入后章节/依据/待答摘要与 hash 检查撤销；需求侧未接 |
| SC06 确认文件包（Host） | 已完成 | `CONTEXT.md` 进入 `metadata.files`，与正文、正式依据同批冻结；逐文件 hash 与根目录白名单 |
| SC07 可选评审不 commit | 已完成 | `requestReview` 改走只读 `prepareContent`；评审绑定本地 HEAD 与逐文件 hash；确认时才提交一次候选 |
| SC08 确认后台持久恢复流水线 | 已完成 | 候选推送并入 prepare 步骤；丢响应查询原操作；远端头变化在 CAS 前停止；提交/worktree 仍在命令队列 |
| SC02 内置 grill 与技能快照 | 已完成 | 技能随包；场景与需求材料会话共用只读 preset、技能目录与归纳式上下文 |
| SC03 项目上下文三方核对 | 已完成 | 写入提议可目标 `CONTEXT.md`；基线/工作区/认可头比较；冲突回对话，不 commit |
| SC09—SC14 | 未开始 | 见开发清单与本文第 4 节 |
| SC15 分层验证 | 未开始 | 仅完成后端单元与类型校验 |

后端验证已执行：

- `pnpm --filter @eadp/collaboration-api typecheck` 通过。
- `src/gitlab-content.test.ts` 44 项通过；`integration`、`project-initialization`、`auth/gitlab`、`desktop-update` 共 43 项通过。
- Docker 镜像已重建并启动，`GET http://127.0.0.1:6972/health` 返回 `{"status":"ok"}`，api／db／cache 容器 healthy。
- 未连接真实企业 GitLab；未执行桌面、真实模型、双客户端或 Windows 实机验收。
- SC07／SC08 桌面/Host 验证：装配树 `tsc -b` host 与 client 通过；评审、确认与恢复均未接真实模型/GitLab。
- SC02 验证：`scenario-preset.test.mjs` 2 项、`scenario-dsh-adapter.test.ts` 6 项通过（含需求会话共用 preset 与技能目录）；真实桌面未验证技能目录挂载（dev-stage 不执行依赖安装）。`tests/scripts` 全量仍有 3 项与本轮无关的环境性失败（缺少 `.desktop-build` 目标、两处样式断言）。
- SC03 验证：`scenario-write-proposals`／`scenario-orchestration` 共 29 项通过（新增上下文提议解析与失效、成功写入并同步文件包、并发接受冲突、提问后文件变化作废）；`tests/windows-desktop` 全量 175 项通过、1 项因未配置测试数据库跳过。未做桌面交互走查，未验证真实模板发布链路。

## 2. 后端新增约束（桌面端实现时必须遵守）

后端改动位于 `apps/collaboration-api/src/gitlab-content.ts`：

- 材料与场景批次集成的 `allowedPaths` 在项目根只接受 `CONTEXT.md`；其他根目录文件即使写入 `metadata.files` 也会以 `MATERIAL_PATH_SCOPE` 拒绝。
- `CONTEXT.md` 若进入 `allowedPaths`，仍须在材料 `metadata.files` 中声明，并提供实际 SHA-256；后端会按固定提交读取并校验。
- `stage:"template"` 的受控配置集成允许 `.template/*.md`、`project.assets.json` 与根 `CONTEXT.md`。只改 `CONTEXT.md` 时 `scenarioTemplates` 可以不变；发布模板文件或清单时仍必须声明模板目录。
- 已发布模板身份不能删除，项目身份与四目录声明不能改写。
- 不新增契约字段、端点或数据库结构；`CONTEXT.md` 的项目级接受复用模板发布的独立候选、独立 worktree 与独立接受流程。

## 3. 当前实现中的旧链路（待删除）

以下链路与「写入提议＋整篇写入」冲突，属于 SC14 的删除范围，不应继续扩展：

| 位置 | 现状 |
| --- | --- |
| `packages/studio-plugin/src/shared/scenarios.ts:15,17,29` | `ScenarioWorkspace.suggestions`、`autoWrite`、`adoptScenarioSuggestions` 命令 |
| `host/application/scenario-workspaces.ts:17,53,90,95,126-135,145,153-154,260-277` | `ScenarioRecord.suggestions`/`autoWrite`、`adopt`、`setAutoWrite`、`autoWrite`、`eadp-suggestions` 解析与应用 |
| `host/application/scenario-suggestions.ts` | `eadp-suggestions` 批次解析 |
| `client/scenarios/ScenarioSuggestions.tsx` | 按条/按组/整批采纳 UI |
| `client/scenarios/ScenarioChatPanel.tsx:76-80` | 「资料与 AI 建议」折叠组、自动写入开关、建议面板 |
| `client/scenarios/ScenarioWorkspace.tsx:55,77` | `adopt`、`setAutoWrite` 动作 |
| `host/application/studio.ts:192,195` | 旧命令分发 |
| `tests/windows-desktop/scenario-orchestration.test.ts`、`scenario-documents.test.ts` | 旧建议/采纳断言 |

注意：

- `host/application/state.ts:48-56` 以「集合齐全 + 两个字段」判定记录版本。**不得为写入提议新增本地集合**，否则旧记录整体作废；提议状态应落在既有 `ScenarioRecord` 或既有任务/候选记录字段中。
- 删除 `ScenarioRecord.suggestions`/`autoWrite` 不破坏严格解析（解析只检查集合与两个字段），但必须同时删除 UI、命令、Host 方法和测试，不能留下失效开关或兼容分支。

## 4. 剩余实施顺序与入口

推荐顺序保持不变：SC04 → SC02/SC03 → SC05 → SC06/SC07 → SC08 → SC09/SC10 → SC11；SC12 在 SC05 后可并行；SC13 的入口归位可在 SC05 后并行，四态与清尾状态展示须在 SC08 后；最后 SC14、SC15。

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
- 新会话提示词已不再要求 `eadp-suggestions`；旧建议链路的解析与 UI 仍按 SC14 待删除。

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

### SC08 确认后台持久恢复流水线

- `studio.ts:609` 的 `integrate` 在车道内先 push 再 `resumeOperation`；`retryOperation`（:613）只重排 `resumeOperation`，恢复时不重推，需把 push 纳入持久步骤。
- 核对材料 commit 与 worktree 创建的当前执行位置；若仍在命令队列，在文档写明边界。
- 丢响应查询原操作；失败重试不重复接受、不阻塞 UI。

### SC09—SC11 同步与清理

- SC09：主 checkout 同步到包含本次提交的认可头；脏改不 stash/reset/clean/覆盖；失败保留“已确认待同步”。
- SC10：任务=worktree 归属单元，按任务释放会话、观察、预览、输出与继承绑定；不以全局 `dispose` 代替。入口 `host/adapters/dsh/sessions.ts:189-192`。
- SC11：`host/adapters/workspace/git.ts:48` 的 `removeWorktree` 当前只被装配在用；需覆盖任务与评审 worktree。收尾步骤逐项持久化并幂等，状态落既有集合字段。

### SC12—SC13 界面

- SC12：删除 `ScenarioChatPanel` 的「资料与 AI 建议」折叠组后，资料导入与正式依据选择必须仍有唯一可达入口；建议复用现有资料面板，由输入区按钮打开。每份资料显示已读/部分读取/失败与实际范围。
- SC13：左原生对话、右场景文件；确认检查分组承载业务完整性、待澄清项与模板结构检查开关；Git 技术信息只在按需诊断展开；删除 Frontmatter 常驻卡、独立资料区、建议区、采纳按钮与 worktree 信息；保留当前色系。
- 用户本轮明确：桌面改动后**不做视觉审查与打包校验**；下一验证者若要验收界面，需单独安排。

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

- `tests/windows-desktop/`：`scenario-documents.test.ts`、`scenario-orchestration.test.ts`、`scenario-file-observer.test.ts`、`scenario-dsh-adapter.test.ts`、`background-lane.test.ts`、`projection-lane.test.ts`、`task-recovery.test.ts`、`conversation-restoration.test.ts`、`asset-workflow.test.ts`。
- `tests/scenario-client/`：`draft-buffer.test.ts`、`document.test.mjs`、`material-editor.test.mjs`。
- `tests/scripts/`：`scenario-preset.test.mjs`、`studio-conversation-restoration.test.mjs`、`studio-task-purpose.test.mjs`。
- 后端：`apps/collaboration-api/src/gitlab-content.test.ts`、`modules/integration.test.ts`。

数据库套件需要显式配置 `STUDIO_TEST_DATABASE_URL` 或 `SCENARIO_SCHEMA_TEST_DATABASE_URL`；未配置时跳过，不计入通过。

## 6. 已知风险与未验证边界

- 评审绑定的是本地未提交快照；评审 worktree 与分支目前无人清理，须由 SC11 覆盖，不能把「登记在 tasks/reviews」当作已清理。
- 需求侧（REQ 编号、去分类、一致性对比端点/表）不在本轮范围；`docs/design/02-requirements.md` 的差距仍未实施。
- 旧建议/采纳链路仍在代码中，且 `implementation.md` 早期章节把它记为已完成；以「后续修订（本轮）」和开发清单为准，早期段落是历史事实，不是现行契约。
- 后端仅验证路径范围与单元行为；真实企业 GitLab、真实 PostgreSQL 运行库、双客户端、Windows 实机与真实模型均未验收。
- 桌面端未做视觉审查、打包校验；本轮不声称桌面可用。

## 7. 建议的下一个会话

1. SC04—SC08 已完成：写入提议、整篇写入、摘要与撤销、确认文件包、可选评审、后台恢复流水线见 `implementation.md` 对应段落。
2. SC02、SC03 已完成；下一步进入 SC09/SC10（主 checkout 安全同步、任务身份与逐任务资源释放）。
3. 每完成一个 SC 更新 `implementation.md` 并设检查点；不要在单个会话内跨过 SC08 而未验证流水线恢复。
4. 需求侧的写入提议、摘要与撤销留到阶段二需求协同设计，本轮不要为需求另建文件规则。
