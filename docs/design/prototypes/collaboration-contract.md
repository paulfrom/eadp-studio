# 项目原型协同契约技术设计

状态：2026-10-29 本地开发队列与逐需求占用已有契约、SQL、后台及桌面实现；远端引用读取与占用释放之间的跨系统竞态仍未解决，真实桌面完整闭环尚未验收。缺口见[本地开发协议](local-development-protocol.md#2-原子领取及-commit-核验)，历史验证见[验证记录](validation-2026-10-28.md)。本文承接已确认的 Q1—Q8 及最新本地开发决定。
开发占用只约束业务开发权，不固定单需求材料版本，也不恢复前置完成门禁。
主入口：[技术设计](technical-design.md)；业务交互：[原型工作台](../03-prototypes.md)；材料规则：[需求协同](../02-requirements.md)。
以下类型、接口与事务描述协同契约及其实现边界；实现和验收状态应以当前源码、测试结果与[本地开发协议](local-development-protocol.md)为准。自动开发成果同步只核验任务受管引用并更新逐需求占用，不生成原型基线；整体原型接受仍是独立用户动作。

## 1. 已确认的职责边界

- 一个项目当前只有一个原型聚合，组织多个需求的页面、流程和 Mock；原型身份不取自某条需求或其 materialVersion。
- 多人按协作事项创建任务，各自分支并行；一个任务可跨需求，多轮沿用该任务的分支与原生会话，集成接受后结束该事项。
- 实现指令授权 AI 在本任务允许区域直接修改代码；需求 MD 修改仍走需求阶段审阅写入。代码写入授权不包含作者确认、集成接受或发布。
- 需求确认成功后自动加入本地串行开发队列；入队失败不回滚需求确认，保留可恢复入口。
- 允许本人可读取的需求草稿探索；明确草稿身份及读取范围，不将其描述为已确认材料。
- 需求依赖只作顺序和影响提示；删除原型认领、恢复、检查、集成时的前置需求完成门禁。需求关系自身的合法性校验仍保留。
- 作者确认当前整体原型成果并形成基线，记录实际涉及需求；不批量将这些需求置为 completed，也不要求先确认需求集合。
- 干净合并可按原确认继续，但必须重检新候选；冲突由 AI 协助解决后，用户须重新确认新成果。

## 2. 沿用的基础与必须替换的现状

沿用现有项目权限、固定 Git 提交、项目短事务、幂等操作表、审计和 integrations 的 prepared／accepted／aborted 协议，不新建通用工作流框架；桌面合并与后台状态核对的职责边界见 6.1。
现有证据：[集成模块](../../../apps/collaboration-api/src/modules/integration.ts)、[服务编排](../../../apps/collaboration-api/src/service.ts)、[契约](../../../packages/contracts/src/index.ts)、[SQL](../../../apps/collaboration-api/db/schema.sql)。
原型成果基线由 `studio_prototype_baselines` 承载，原型路径不再按需求版本生成基线，也不再绑定前置完成输入；旧 `studio_baselines`、`studio_occupation_inputs` 两表已删除，不保留为兼容路径。
材料设计占用、固定场景来源、材料独立确认、前置 DAG 校验、材料复用与交接自身规则继续按原职责运行。

## 3. 领域身份与关系

| 对象 | 身份与职责 | 关系及状态 |
| --- | --- | --- |
| ProjectPrototype | prototypeId，项目当前原型聚合 | projectId 唯一；currentBaselineId 指向最后接受的整体成果；不保存代码正文。 |
| PrototypeTask | prototypeTaskId，明确命名的协作事项 | 属于一个原型；owner、client、branch、taskGeneration、revision；active／cancelled／released／accepted。 |
| TaskDevelopmentRequirement | 任务实际开发需求范围 | 任务与需求多对多；首次释放不删除范围，后续纠偏在该范围内取得新 claim 代次。 |
| DevelopmentClaim | 需求排他占用 | 同项目同 requirementId 最多一个 active claim；任务占用记录 commitId 与任务受管 remoteRef，首次推送核验后释放，纠偏最终确认并核验后释放。管理员对空闲需求设置的占用不属于任务，也不授予客户端写权。 |
| TaskReferenceRequirement | 任务参考的需求 | task 与 requirement 多对多；可动态更新，只读参考不占用，不得据此实现该需求。 |
| PrototypeAcceptance | acceptanceId，作者确认并被后台接受的成果事件 | 绑定 task、integration、sourceSha、candidateSha、确认人及确认授权；只追加。 |
| PrototypeBaseline | baselineId，整体项目原型的代码基线 | 与 acceptance 一对一；绑定 prototype、commitSha、基线序号；同原型可有多个版本。 |
| AcceptanceRequirement | 当次实际涉及需求范围 | acceptance 与 requirement 多对多；保存受理时范围，不回写需求材料状态。 |
| BaselineRequirement | 基线累计关联范围 | baseline 与 requirement 多对多；冻结上个基线累计范围与本次 acceptance 范围的并集，不表示逐项实现覆盖。 |

多个 active 任务可以同时属于同一原型并开发不同需求；同一需求按 projectId＋requirementId 互斥，不按 materialVersion、用户或任务版本拆分。同一用户的不同任务也不能同时领取；编辑期不持有项目独占数据库锁。

本地自动开发、恢复和逐需求生命周期按[本地开发协议](local-development-protocol.md)执行。首次完成由 Host hook 自动 commit/push，后端核验后释放并继续下一项；纠偏重新领取并保持占用至最终确认。空闲领取不比较 commit，已占用即使 commit 相同也拒绝。管理员可在权限与审计下将标识置为占用或未占用，管理操作推进代次且不读取 Git。队列与核对仅本地保存，项目整体接受另行执行。
prototype.relatedRequirementIds 从当前基线 relatedRequirementIds 投影；task.developmentRequirementIds 是稳定任务范围，task.developmentClaims 是每需求最新一代（包括已释放代次），task.referenceRequirementIds 只表示参考。acceptance.requirementIds 冻结开发范围，参考需求不累计进基线，也不把占用或累计关联宣称为逐项实现覆盖。
任务 owner 只控制该任务现场与提交权，不宣称独占共享组件；共享文件改动在各分支隔离，最终通过 Git 合并处理。
原型当前视图由已接受基线和本人当前任务现场分别表达；其他人的私有草稿、未提交代码不能进入本人的正式成果。
任务接受后不可继续写入该任务或复用其令牌；后续事项新建任务，可在同一项目原型继续形成新基线。
task branch 名由 Host 按 prototypeTaskId 生成并经后台登记，不能把任意外部仓库或分支地址当作任务授权。
原生会话 ID 属于 Host 本地状态；后台保存任务和分支控制事实，不保存会话正文、提示词或工具日志。

## 4. 类型及白名单约束

类型继续放在 packages/contracts，以 TypeBox 和 Static 导出，沿用 object 的 additionalProperties:false、IdSchema、ShaSchema、Sha256Schema、RevisionSchema。
以下为当前契约字段；不是随意 JSON。所有数组去重，需求引用必须属于当前项目并满足当前用户读取权限。

```ts
type PrototypeTaskToken = {
  prototypeTaskId: string; generation: number; clientId: string; expectedRevision: number;
};
type DevelopmentClaimToken = { requirementId: string; claimId: string; generation: number };
type DevelopmentClaimView = DevelopmentClaimToken & {
  taskId: string | null; active: boolean; commitId: string; remoteRef: string;
};
type CreatePrototypeTaskRequest = {
  idempotencyKey: string; title: string; clientId: string;
  developmentRequirementIds: string[]; referenceRequirementIds: string[];
  commitId: string; remoteRef: string;
  writeScope: string[]; policyHash: string; instruction: { userActionId: string; summary: string };
};
type ClaimPrototypeDevelopmentRequest = {
  key: string; token: PrototypeTaskToken; requirementId: string; commitId: string; remoteRef: string;
};
type SynchronizePrototypeDevelopmentRequest = {
  key: string; token: PrototypeTaskToken; claim: DevelopmentClaimToken;
  commitId: string; remoteRef: string; release: boolean;
};
type AdminPrototypeDevelopmentClaimRequest = {
  key: string; occupied: boolean; commitId: string; remoteRef: string; reason: string;
};
type PrototypeTaskView = {
  id: string; prototypeId: string; ownerId: number; clientId: string; generation: number;
  revision: number; status: 'active' | 'cancelled' | 'released' | 'accepted';
  title: string; branch: string; startHead: string; sourceBaseHead: string;
  developmentRequirementIds: string[]; referenceRequirementIds: string[];
  developmentClaims: DevelopmentClaimToken[]; claimsDigest: string;
  writeScope: string[]; policyHash: string;
};
type PrototypeEngineeringEvidence = {
  sourceTreeHash: string; rulesHash: string; buildArtifactSha256: string;
  candidateSha: string; checks: Array<{
    name: 'engineering' | 'mock' | 'browser'; passed: true; evidenceHash: string;
  }>;
};
type PrototypeIntegrationRequest = {
  stage: 'prototype'; idempotencyKey: string; prototypeId: string; token: PrototypeTaskToken;
  sourceSha: string; sourceBaseHead: string; expectedHead: string; candidateSha: string; allowedPaths: string[];
  sourceRef: string; candidateRef: string;
  developmentRequirementIds: string[]; developmentClaims: DevelopmentClaimToken[]; claimsDigest: string;
  evidence: PrototypeEngineeringEvidence;
  authorConfirmation: {
    confirmationId: string; sourceSha: string; authorConfirmed: true;
    claimsDigest: string; mergePolicy: 'clean-merge-and-recheck';
  };
};
type PrototypeBaselineView = {
  id: string; prototypeId: string; sequence: number; acceptanceId: string;
  integrationId: string; prototypeTaskId: string; commitSha: string; relatedRequirementIds: string[];
  confirmedBy: number; acceptedAt: string;
};
```

generation 为正整数，revision 非负；title 1—200 字；开发数组为 1—100 项，参考数组为 0—100 项且不重叠；纯只读探索不创建可写任务，不要求先在 UI 选择固定需求输入包。
claimsDigest 是服务端对按 requirementId 排序的任务内每需求最新 claim token 集合计算的 SHA-256；请求须提交完整集合，后台同时核对任务 claimsDigest 和各需求在项目范围内的最新代次，不能只信自报摘要或遗漏需求。它绑定开发权，不包含材料版本／内容 hash；释放不删除任务需求范围，重新领取或管理员改标识会改变需求最新代次，使旧候选与确认失效。
首次业务代码写入及每次纠偏前，可信 Host 以真实 requirementId、task token、commitId 和任务受管 remoteRef 原子领取；范围或身份不明先只读澄清，不擅造需求，业务实现不能以空 developmentRequirementIds 起写。纯讨论、读取、检查和预览不领取也不创建可写任务。直接编辑和 AI 文件工具采用同一写入准入，参考关系不产生开发授权。
普通原型 Agent 的任何业务代码写入必须有非空开发集合及有效 claims，不设“无需求共享开发”通道；模板初始化／维护继续走专属受保护流程，不能用维护名义绕过他人占用。不同需求修改同一共享文件仍可分支并行，冲突按 Git 集成处理。此控制保证已登记开发权唯一，不能仅靠 claim 或路径自动证明代码语义未越界。
writeScope 是后台持久的任务授权路径集合，policyHash 指向服务端认可的项目／模板保护策略版本；Host 在创建时将模板可写清单与用户实现意图求交，API 再按服务端／项目保护策略核验，不接受客户端扩大保护区。
allowedPaths 是本候选实际改动范围，必须属于持久 writeScope；两者最多 3000 项、每项最多 400 字，拒绝越界路径和保护文件。不能以 integration.allowedPaths 自报授权。
instruction 只传可信 Host 捕获的真实用户动作 ID 和最多 500 字的实施意图摘要，不传提示词全文；API 记录 actor、动作及策略 hash，普通模型输出不能构造扩大授权的用户动作。
范围更新须匹配旧 token/revision，重新计算与保护策略的交集；扩大 writeScope 必须对应用户实际发送的新实现／修改指令，不另加重复确认弹窗。收窄或策略变化使旧候选失效，重新核对并检查。
sourceSha／expectedHead／candidateSha 为 40 位小写 SHA；工程、规则、产物与 evidenceHash 为 64 位小写 SHA-256。
checks 必须且仅出现一次 engineering／mock／browser，全部 passed:true；不再要求“relations 检查通过”或前置完成凭据。
authorConfirmation 由可信 Host 在作者明确确认后构造；sourceSha 必须等于本次请求 sourceSha，不接受预览页面或普通 AI 工具代发确认。
真实客户端身份取认证上下文，不接受请求自填 ownerId／confirmedBy；token 中 clientId 仍须匹配已登记的任务客户端。
工程证据只绑定工程源码、规则、构建产物与精确候选，不绑定固定需求 MD、materialVersion 或前置完成状态。
后台校验请求形状、SHA、候选引用及权限，不能凭 evidenceHash 宣称自己重跑了桌面检查、验证了合并结果或证明了业务正确性。

## 5. HTTP 接口

统一前缀 `/v1/projects/:projectId`，继续使用现有认证、错误 envelope 和项目权限检查。

| 方法与路径 | 请求 | 正常结果与含义 |
| --- | --- | --- |
| GET /prototype | 无 | 200，prototypeId、currentBaseline、本人可见任务目录及 recognizedHead；未初始化 409。 |
| POST /prototype/tasks | CreatePrototypeTaskRequest | 200，PrototypeTaskView；非空初始开发集合与任务在同一短事务登记，全领或回滚；纯只读操作不调用本接口。项目初始化时已创建唯一 prototype，本接口不懒补原型。 |
| GET /prototype/tasks/:prototypeTaskId | 无 | 200，任务控制状态；仅 owner／管理员可取完整任务信息。 |
| POST /prototype/tasks/:prototypeTaskId/development-claims | ClaimPrototypeDevelopmentRequest | 200，DevelopmentClaimView；在任务既有需求范围内原子检查并领取一个需求。空闲不读取 Git、不比较 commit；已占用返回 REQUIREMENT_ALREADY_CLAIMED。 |
| POST /prototype/tasks/:prototypeTaskId/development-claims/:requirementId/synchronize | SynchronizePrototypeDevelopmentRequest | 200，同步后的 DevelopmentClaimView；先核验真实受管 ref 等于 commitId，再以原 claim／代次更新。release=false 保持纠偏占用，release=true 仅释放该代次，不生成基线。 |
| GET /prototype/requirements/:requirementId/development-claim | 无 | 200，当前 active DevelopmentClaimView；未占用返回 null。供恢复核对，不能用历史操作回执代替。 |
| PUT /prototype/requirements/:requirementId/development-claim | AdminPrototypeDevelopmentClaimRequest | 仅管理员；不读取 Git，推进代次并审计。occupied=false 置空闲并返回 null；occupied=true 替换当前占用代次，或在空闲时创建不属于任务的管理占用并返回新标识。管理占用不授予客户端写权。 |
| PUT /prototype/tasks/:prototypeTaskId/reference-requirements | key、token、referenceRequirementIds | 200，新任务 revision 与参考范围；可空，按权限读取，不领取或释放开发 claim，不改材料正文或状态。 |
| PUT /prototype/tasks/:prototypeTaskId/write-scope | key、旧 token、writeScope、policyHash、instruction | 200，新 token/revision、服务端核验后的 scope；存在 prepared 时先完成核对，不覆盖旧候选。 |
| PUT /prototype/tasks/:prototypeTaskId/source-base | key、旧 token、原 operationId/sourceRef/sourceSha、newBaseHead | 200，后台核对当前认可头、稳定分支和原 source ref/SHA 后登记新 sourceBaseHead；桌面负责判定实际冲突及源码范围。已有 prepared／未知 Git 状态拒绝，不接受任意自报基头。 |
| POST /prototype/tasks/:prototypeTaskId/cancel | key、token、reason | 200，cancelled；撤销后台接受权，结果另含 gitRecovery: clear／unknown／reconcile-required。 |
| POST /prototype/tasks/:prototypeTaskId/admin-release | key、expectedGeneration、expectedRevision、reason | 200，released；仅管理员，撤销后台接受权并返回 gitRecovery；不承诺撤回 Git 副作用。 |
| POST /integrations | 现有 union 增加新版 PrototypeIntegrationRequest，删除旧 prototype 分支 | 200，prepared，返回 integrationId、candidateSha、prototypeTaskId。材料与模板分支继续各自契约。 |
| GET /integrations/:integrationId | 无 | 200，prepared／accepted／aborted 及固定 SHA；accepted 含 acceptanceId、baselineId。 |
| POST /integrations/:integrationId/complete | key、PrototypeTaskToken、完整 DevelopmentClaimToken[]、claimsDigest | 200，accepted 及 PrototypeBaselineView；材料／模板使用各自完成 union。 |
| POST /integrations/:integrationId/abort | key、PrototypeTaskToken | 200，aborted 但任务仍 active；仅在真实 stable 仍为 expectedHead 且项目锁内复核同一 prepared 后允许。 |
| GET /operations/:key | 无 | 200，原 action/result；只向原 actor 返回；未知 404 不等于请求失败。 |
| GET /prototype/baselines | 分页 limit／offset | 200，基线目录；按 sequence 排序，单页 1—100。 |

新原型投影不加载本地需求草稿正文。材料 versions、relations、claim、confirm 继续原接口，不为原型写入伪材料确认。
HTTP 401 表示会话失效；403 表示项目写权限、task owner 或管理员权限不足；404 表示对象不存在或对该用户不可见。
HTTP 422：INVALID_REQUEST、PROTOTYPE_PATH_SCOPE、CHECKS_REQUIRED、CHECK_CANDIDATE_MISMATCH、INVALID_REQUIREMENT_SCOPE、INVALID_DEVELOPMENT_REF。
HTTP 403：WRITE_SCOPE_EXPANSION_UNAUTHORIZED；409：TASK_POLICY_CHANGED。合并冲突、候选树错误和验证器不可用由桌面合并流程报告，不再作为后端错误码。
HTTP 409：TASK_REVISION_CONFLICT、STALE_PROTOTYPE_TASK、INTEGRATION_PENDING、INTEGRATION_HEAD_CHANGED、UNRECOGNIZED_GIT_HEAD、IDEMPOTENCY_CONFLICT。
HTTP 409：REQUIREMENT_ALREADY_CLAIMED、STALE_DEVELOPMENT_CLAIM、DEVELOPMENT_COMMIT_MISMATCH；占用冲突只返回当前用户可见的需求和事项摘要，不暴露他人草稿。
HTTP 409：GIT_COMPLETION_UNVERIFIED、SOURCE_CANDIDATE_MISMATCH、CONFIRMATION_SOURCE_MISMATCH；响应 details 仅含可公开对象、状态和预期 revision/SHA。
网络超时、503 或请求中断不得统一翻译为“未接受”；Host 必须查原操作和原 integration，保留有限恢复入口。
逐需求领取、参考范围与 write-scope 更新都在项目短事务检查任务不存在 prepared 或尚未核对的 Git 操作，未收敛返回 INTEGRATION_PENDING；只读搜索与读取观察不修改任务 revision。旧数组扩领和通用关系解除接口已删除，不提供无约束解除开发 claim 的入口。

## 6. 事务顺序与并发集成

1. 需求确认后先持久化本地逐需求队列，到实际执行时才创建后台事项和领取；补充实施指令也先保存本地操作。Host 取得项目 recognizedHead 作为 commitId；后台验证权限及 writeScope/policyHash，在同一项目短事务登记 task、稳定需求范围、唯一 branch、任务受管 remoteRef 和全部初始 claims。已有任一需求被别的任务领取则全部回滚；成功后 Host 才创建 worktree 和原生会话。只读探索不创建可写任务。
2. 自动开发只写本任务分支；每次首次开发、纠偏和恢复写入前，Host 查询当前后端事实并核实 active claim／代次。首次完成 hook 自动 commit/push，后端核验任务 remoteRef 后以 release=true 同步；纠偏重新领取，AI 完成以 release=false 同步，最终确认再以 release=true 同步。自动同步不进入 prepared、不生成 baseline。
3. Host 保留多轮任务分支历史，从后台登记的 sourceBaseHead（初始 startHead，或桌面冲突恢复后登记的新基头）与用户看到的精确工程树归一构造新单提交 source；第一父=sourceBaseHead，原型树与作者所见一致，非原型树来自基头。作者确认该 sourceSha 与 confirmationId，不重写原任务分支历史；先持久化并上传不可变 source ref，确认远端对象可读，再进入合并。
   当前授权代码无变化时不创建相同代码基线，也不冒充新增实现覆盖；开发占用的保留与释放按[本地开发协议](local-development-protocol.md)区分首次开发及纠偏，不再绑定整项任务结束。
4. Host 获取 recognizedHead 作为 expectedHead；若等于 sourceBaseHead，candidate=source；否则合并 expectedHead/source，验证父关系、实际路径和候选树，保留原 source 授权并全量重检新 candidate。冲突后先登记最新 head 为新 sourceBaseHead，在其上归一新 source 并由用户重新确认。
5. 候选生成后上传其不可变 candidate ref，复核原 source ref；两个对象均按 SHA 可见后才 prepare，API 只验证权限、稳定头、候选 ref/SHA 和当前状态证据。source 先于合并上传，因此冲突发生在 prepare 前时，source-base 接口也能核对原 source 引用，不依赖尚未存在的集成；全程不会先推进 stable。
6. API 在项目短事务锁项目行，再读 task，校验 active、owner/client/generation/revision、expectedHead 和幂等键；核对完整开发范围、每需求最新 claimId／generation／task 归属及 claimsDigest；项目无其他 prepared 才写 prepared，并冻结该代次集合。首次自动释放的最新代次可用于核对同一已上传成果，旧代次不能替代。
7. 返回 prepared 后，Host 按 expectedHead 条件推送稳定分支至精确 candidate；普通 push 成功不能直接显示已接受。
8. complete 在事务外确认真实稳定分支恰为 candidate、候选 ref/SHA 未变化；随后短事务重检项目头、task fencing、integration prepared，以及与 prepared 一致的全部最新 claim 身份／代次／归属和 claimsDigest；管理员改标识或重新领取会使旧 prepared 失效，不能只在 prepare 校验一次。
9. 同事务写 acceptance 及本次 developmentRequirementIds，写 baseline 及“上一基线 relatedRequirementIds ∪ 本次开发需求”的累计关联；更新 prototype.currentBaselineId、project.recognizedHead，任务 accepted、令牌失效、全部开发 claims 关闭，集成 accepted，保存幂等结果与审计。
10. 提交成功后 Host 才显示基线；本机收尾独立重试，不撤销已接受成果，也不覆盖新任务的本地内容。

项目锁只覆盖数据库状态接受，Git、模型、构建及浏览器检查均在事务外；多任务编辑并行，prepared／accepted 按项目串行。
逐需求成果同步当前先读取任务远端引用再进入数据库释放事务；两步之间引用仍可变化，代次检查或条件推送均不能单独消除该竞态。服务端引用写入约束与占用释放的协调尚未实现和验证，具体缺口见[本地开发协议](local-development-protocol.md#2-原子领取及-commit-核验)。
两人同时开发 R1：A 先提交领取事务后 B 得到 REQUIREMENT_ALREADY_CLAIMED；同用户的 A/B 两任务结果相同。A 领 R1＋R2、B 领 R2＋R3：只有一个完整集合获领，失败者连无冲突的 R1 或 R3 也不保留，避免部分领取后互相等待。失败事务不遗留新任务或半套 claims。
开发占用沿用 [PostgreSQL 部分唯一索引](https://www.postgresql.org/docs/current/indexes-partial.html)与[短事务行锁](https://www.postgresql.org/docs/current/explicit-locking.html)；持久 claim 无 TTL，不因退出、断网、模型取消或心跳丢失自动过期，不引入 Redis 锁。人工取消或管理员修改标识提供显式恢复路径。管理员修改须核验权限、记录审计并失效旧 claim 代次，不增加 Git 核验前置；后台标识空闲后可原子重新领取，不能复活旧 token。
另一任务先推进认可头：本任务旧 candidate 作废，按新头重建并重检；不能静默覆盖稳定分支或重用旧 evidence。
干净合并只包含原作者变更与已经接受的项目成果；Host 须验证候选树确为该合并结果，不能只用“source diff 与 candidate diff 字面一致”规则误拒合法合并。
最终 baseline 固定本次代码与已认可成果组成的完整项目源码；候选第一父必须等于 expectedHead，其他成员未接受分支、私有草稿和未提交代码不得混入。
出现冲突时停止自动集成，保留原 source 和冲突现场；AI 只在任务授权范围解决，解决后形成新 source、新 confirmationId，作者重新确认，再重检与提交。
同任务替换 prepared 先调用 abort 收敛原操作：stable=expectedHead 才可 abort；stable=candidate 应补 complete／结果核对；其他头或未知必须 reconcile，不允许覆盖 prepared 或改任务 revision 掩盖已推送事实。
并发竞争失败返回明确 409，Host 刷新后继续；不无限自旋，不以长项目锁阻止其他成员编辑。
sourceRef/candidateRef 由 Host 以已登记 prototypeTaskId 和 operationId 生成，限定在当前项目 `refs/heads/studio-private/<prototypeTaskId>/<operationId>/{source,candidate}`；沿用标准 GitLab 权限，不放宽保护规则，不得 update／force 重写或推进 stable。可见性仍由 GitLab 项目权限控制，“私有操作 ref”不承诺绕过项目成员权限隔离。
Host 先将 ref 名、准确 SHA、sourceBaseHead 和上传进度写入本地 operation；push 响应未知先查询同名 ref 是否精确匹配，再重试原操作。上传失败／不可见不得 prepare，远端这些 ref 也不代表业务 accepted。
后台记录并核对 ref→SHA，不读取原型代码内容；ref 保留到任务接受及必要追溯满足，由明确保留策略再清理，不能提前删除触发 GC；abort／release 后仍保留原 refs 定位晚到 push，不以 ref 存在冒充正式成果。

### 6.1 桌面合并与后台状态核对

2026-10-29 用户明确将原型合并及结果验证全部归入桌面 Host。Host 使用固定 Git 运行工具和三方合并策略构造 source/candidate，核对父关系、真实共同祖先、实际变更路径、非原型区域和候选树，并对精确 candidate 重新执行工程检查。冲突判定、冲突现场恢复及冲突后重新确认也在桌面完成，不由协同后端重算。

协同后端不安装或调用 Git，不读取原型 tree/blob，不请求 merge-base，也不执行 `merge-tree`。后端只核对有效会话与仓库权限、任务 owner/client/generation/revision、完整开发 claims、当前认可头、稳定分支头，以及 source/candidate 私有引用是否精确指向登记的 SHA。引用和 SHA 可见只表示候选状态可核对，不表示后台重新证明合并结果。

prepare 登记 prepared 状态后，Host 才以 expectedHead 为条件推进稳定分支；complete 先确认稳定分支已到 candidate，再在项目短事务内复核任务和 claims、写入接受记录与原型基线、结束开发占用并更新认可头。Git 与数据库仍不假装原子，未知结果按原 operation/integration 恢复。

冲突后的 source-base 更新只登记桌面已确认的冲突处理前提：当前认可头等于 newBaseHead、稳定分支保持一致、原 source ref 指向登记的 sourceSha。后端不再判断是否真实冲突或计算 mergeBaseSha；这些事实由桌面合并现场和恢复记录保存。

## 7. fencing、分叉与未知结果恢复

task token 必须同时匹配 prototypeTaskId、generation、clientId、revision、owner。写入须匹配当前有效开发 claim；prepare 与 complete 分别核对完整需求范围的最新 claim 集合，包括仍为最新的已释放代次及其成果，不能沿用被其他事项重新领取后失效的代次。客户端重新登录不自动转移任务所有权。纯只读会话不具有需求业务写权。
admin release 在项目短事务中递增 generation/revision、置 released、关闭全部开发 claims、abort 该任务 prepared，并审计原因；取消同样原子失效旧任务与其全部 claims，不能仅释放需求而保留原任务接受权。
开发占用生命周期及纠偏结束条件见[本地开发协议](local-development-protocol.md)。claims、token、digest、scope 和 prepared 校验应遵循该生命周期，不能沿用失效授权提交已释放需求的过期改动；实际并发行为仍须通过当前版本验证。
管理员释放不删除本地 worktree、未提交代码或会话；需要继续时从认可头新建任务、重新领取并显式挑选仍有授权的改动，重新检查确认，不自动整树导入旧现场，不复活旧 token。
释放与 complete 竞争由同一项目行锁决定：先接受则保留 accepted；先释放则 complete 拒绝。Git 已推但未接受时进入分叉核对。
cancel／release 只原子撤销后台接受权，数据库锁不能撤回旧客户端已经发出的 Git 网络副作用；Git 读取与释放事务之间也可能出现竞态。
释放后发现实际头为候选或其他非认可头时，返回 reconcile-required；Git 状态未知返回 unknown。原 prepared 请求和 SHA 保留供核对，不能把 aborted 当作“Git 未发生”，也不能显示已经安全撤回全部成果。
gitRecovery=clear 只描述本次观测未见分叉；后续 prepare／发布仍核对真实 Git 头，晚到 push 造成分叉时必须阻断并走受保护 reconcile。
abort 的项目锁只原子结束 prepared、保留 active 任务，不撤回已经发出的 Git 网络请求；锁前观测 head 与锁内状态复核之间可能晚到 push，后续仍按保留的原 ref/SHA 核对并 reconcile，不能承诺外部原子撤销。
prepared 后进程重启：恢复 task、integration 和本地 operation 记录，先查原 key；不重新创建任务、确认或基线。
创建／重新领取响应未知：先查原 key、当前 task 和当前完整 claims，允许按原请求同 key 核对／重试，不能换 key 重领；404 不证明在途事务失败。幂等历史结果用于定位，不代表其中旧 token 仍有效；恢复可写会话前必须重查当前任务与 active claim／代次，撤销或不匹配则停止写入并保留现场。
实际分支为 expectedHead：可恢复原候选检查及条件推送；为 candidate：只补 complete；为其他 SHA：停止写入并报告分叉。
分叉沿用受管理员保护的 reconcile 入口，核对实际头与修正内容；不能仅把任意实际头标为已接受代码或自动形成原型基线。
complete 已接受但响应丢失：原幂等键返回原 baseline；新 key 查询同 accepted integration 也返回其既有接受结果，不生成第二份基线。
同 key 换 actor、action 或请求字节指纹返回 IDEMPOTENCY_CONFLICT；新候选、新范围或重新确认用新 key，旧记录只读。
同一作者确认遇到干净合并重试可关联同 confirmationId；真正成果变更必须重新确认，不能把旧用户授权延伸到 AI 新写的业务代码。
没有本地现场时后台只能报告任务及接受事实，不能声称已恢复全部会话、未提交文件或检查进程。

### 7.1 一次实现指令的跨步骤恢复（R08，待整体确认）

复用 Host 既有 operation 持久记录串联真实用户动作，不增加后台工作流。父 operation 保存 userActionId、账号／client／project／task 身份、原始明确指令的本地引用、规范化目标开发集合与 scope、policyHash、固定子操作键、messageOperationId、已完成步骤及 nextAction。指令正文只在账号隔离的本地状态保存，不传入后台操作摘要；各 HTTP 子操作仍按自己的原请求字节和幂等键校验。

| 步骤 | 外部动作前必须落盘 | 成功后的检查点及恢复 |
| --- | --- | --- |
| 本地入队 | 原始指令引用、需求身份、队列位置与待执行操作 | 需求确认后先持久入队；串行槽可用时才创建或领取，冲突和网络失败保留队列及输入。 |
| 创建／重新领取 | 原 token（已有事项时）、真实 requirementId、commitId、remoteRef 与固定 create／claim key | 保存返回任务或单需求 claim／代次后再进入下一步；未知先查原 key 和当前事实，不发另一创建或领取请求。空闲领取不查询 Git。 |
| 完成 hook 与成果同步 | 原 run／claim 代次、commit、push 和后端同步阶段 | 已 commit 不重复提交，已 push 不重复推送；响应未知先查原 operation 与真实 ref。首次 release=true，纠偏 AI 完成 release=false，最终确认 release=true。 |
| 准备现场与会话 | 已获授权任务身份、固定 branch／worktree 定位、会话创建尝试及可核对标识 | 分别保存现场、sessionId 和恢复结果；崩溃核对既有对象，不覆盖现场或静默多建会话。原生创建是否可可靠核对，须在 PT03 的固定宿主适配实现和恢复验收中核实；当前尚未验证。 |
| 派发 | 同一 messageOperationId 及派发阶段 | 仅在当前 task、完整 claims 与 scope 两项授权均核对有效，且本机串行执行槽可用时发送；发送前持久化 sending，按原生可信回执判定投递。队列规则见桌面运行时 §4.1。 |

已成功的步骤不因后续失败重跑。恢复时先读当前任务事实；其他操作已改变 revision 时，不把历史响应 token 写回当前许可，也不修改原请求后沿用旧 key。先结清原步骤结果，再按当前事实补齐尚未满足的授权；确需形成新请求时保存其独立 key、原因及与原动作的关系，不以新 key 绕过未知结果或重复领取。新业务意图是新的用户动作，不能覆盖原恢复记录。
父操作未完成不代表后端整体失败或整体回滚；界面保留指令并说明停在领取、授权、现场、排队或投递核对中的哪一步，技术 key／token 仅入诊断。用户可重试未完步骤或明确结束事项；不会因恢复失败自动 cancel。首次指令投递未知不能用“继续”创建替代消息，需先核对原 messageOperationId；原生能力边界见桌面运行时 §4.4。

## 8. SQL 当前定义与不变量

| 表或约束 | 当前定义 |
| --- | --- |
| studio_prototypes | id PK，project_id UNIQUE FK，current_baseline_id 同原型 FK；项目初始化事务创建。 |
| studio_prototype_tasks | prototype/project FK；owner/client/generation/revision/status/title/branch/start_head/source_base_head/write_scope/policy_hash/claims_digest；project+id、project+branch UNIQUE；不设每原型 active 唯一限制。 |
| studio_prototype_task_requirements | project/task/requirement 同项目 FK；保存稳定开发范围，首次释放不删除，纠偏只能在该范围内重新领取。 |
| studio_prototype_development_claims | claim id PK；project/requirement 同项目 FK；task 可空，非空时为同项目任务 FK；generation、commit_id、remote_ref、active、审计及结束原因；(project_id,requirement_id) WHERE active 部分唯一，同项目同需求的 generation 唯一。 |
| studio_prototype_task_references | project/task/requirement 同项目 FK；task_id+requirement_id PK；只读参考关系，不保存正文或完成标记。 |
| studio_integrations／studio_prototype_integrations | 保留一项目一个 prepared 约束及固定候选状态；自动开发同步不写这些集成表。 |
| studio_prototype_acceptances／studio_prototype_baselines | 仅在整体原型明确接受事务写 acceptance、baseline 和需求范围；自动上传成果不产生记录。 |
| studio_operations／audit | 项目幂等键绑定 actor/action/requestHash 和有限结果；管理员改标识另记原因、旧代次和替换代次，不嵌入需求正文。 |

任务 active claim 必须指向同项目的 active task 和 requirement 类型实体；task 结束时不得遗留其 active claim。管理员可将空闲需求置为不属于任务的管理占用，不凭该记录授予客户端开发权。新 claim 在项目锁内按该需求最大 generation 加一，普通重新领取使用新 claimId；管理员修改已有占用时推进 generation，并在关联任务时更新其 claimsDigest，使旧 hook 和旧 prepared 同时失效。关闭记录仅供审计，不能据历史成功回执复活开发权。
材料 design occupation 与开发 claim 独立，不交叉互斥或共用代次。baseline、acceptance、accepted integration 必须同项目／同原型／同 candidate；任务 accepted 必须有唯一 acceptance，released/cancelled 不得生成新 acceptance。

规范 schema 直接替换，不提供 migration、旧协议 fallback 或双写层；删除过时实现不授权删除未提交代码、会话和纠偏现场。

## 9. 草稿诊断、基线与发布边界

Host 可在本地记录本轮实际读到的 requirementId、草稿／已确认状态及内容 hash，用于提醒内容后来发生变化；后台不保存草稿正文或额外需求文件副本。
诊断 hash/status 只表示读取观察，不证明后台能复现当时草稿全文，不替代材料已确认事实，也不成为开工、恢复或接受门禁。
正式可复现成果是基线 commitSha 中已接受的原型代码；接受时冻结的开发需求集合提供追溯，不承诺复现作者当时全部私有材料上下文，也不证明该集合逐项实现完成。
后续材料确认可能推动 project.recognizedHead，而 prototype.currentBaseline.commitSha 保持不变；两者在返回值和诊断中分别表达。
发布沿用独立授权与现有发布入口，绑定 baselineId 和其准确 commitSha，不能把较新的 recognizedHead 偷换为发布代码源。
发布时如需核对认可头，必须同时说明其用于并发／一致性控制；材料头变化不应把未接受原型代码带入产物，也不伪造新基线。
本文不新增部署目标、远端启停、流水线或生产发布授权；部署实施与真实产物校验仍属于原发布职责和后续验收范围。

## 10. 实施验证要求

直接按设计工作包实施，将能力验证并入实现与验收，不设置独立技术验证前置环节。PT01 覆盖领域、存储与并发不变量，PT02 覆盖固定 Git 及隔离候选验证器，PT03 覆盖原生会话与跨步骤恢复，PT06 覆盖确认集成及下游；PT08 汇总当前交付版本的完整桌面闭环证据。以下为待执行要求，不能据此声称能力已实现或已验收。

契约检查覆盖额外字段拒绝、跨项目范围、token 重放、旧材料占用冒充开发 claim、遗漏／伪造 claimsDigest、幂等换输入、伪造 scope／用户动作／合并树与旧检查证据；覆盖逐需求释放、重新领取、旧授权失效和旧成果集成冲突，不能只测正常请求。
数据库检查覆盖两人抢同需求、同用户双任务互斥、多需求事项创建时 R1＋R2 对 R2＋R3 全领或回滚、逐需求重领冲突、参考读取不占用、材料版本变化不绕过互斥、prepare/complete 双重 claims fencing、release/complete 竞争、同候选重复完成、延迟约束整体回滚及材料头推进后基线不变。
Host／桌面闭环覆盖首次业务写前自动领取、范围不明只读澄清且不擅造需求、空开发集合不得创建可写任务或业务起写、模板维护不成为普通 Agent 绕过占用通道、未知领取结果与旧幂等 token 恢复、取消后旧现场不可提交、干净合并重检、共享文件冲突重新确认、Git 成功后台未知、接受后收尾失败与重启恢复；需求草稿更新仅提示，材料状态保持独立。
本地浏览器设计稿应演示抢占冲突、参考读取、释放后旧授权失效和保留现场；历史设计稿中的动态扩领演示不代表当前协议支持扩展既有任务开发范围。浏览器交互验证不证明数据库并发、真实桌面或协同验收。
当前交付桌面、真实原生模型、Host、指定协同服务 `100.119.183.44`、Git／持久化及桌面结果必须共同验证；静态设计、fixture 或 API 局部通过均不能宣称整体已验收。
