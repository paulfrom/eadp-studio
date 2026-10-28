# 原型桌面与 Host 运行时技术设计

状态：2026-10-27 设计，已实施（commit 68f269c／a94405d）；未验收部分见[验证记录](validation-2026-10-28.md)。本文件不表示真实桌面闭环已通过。

范围：项目原型界面、协作事项、原生会话、私有工程、检查预览、精确确认与失败恢复。
沿用固定 DSH、现有专用 Host/client 插件及随包原型模板，不升级宿主、不开放任意终端。本轮补充拟增加 CodeMirror 6、独立锁定的稳定版 Playwright 及其配对 Chromium，详见[技术选型与本地浏览器验证](technology-and-browser-validation.md)；不能继续声称桌面零新增依赖。协同服务新增的受限 Git 验证工具见[协同契约](collaboration-contract.md#61-后台验证候选树)。
业务交互见[原型工作台设计](../03-prototypes.md)，视觉见[原型工作台](../../dseign/原型交互工作台.html)。

## 1. 已确认的业务边界

- 项目统一呈现一个原型；多人通过各自协作事项的分支并行工作，再受控集成。
- 一个事项可以跨多个需求和页面；多轮沿用工程现场及原生会话，确认集成后结束事项。
- 需求依赖作为提醒，不要求前置需求完成才能开始原型。
- 用户明确实现指令允许 AI 在 Host 授权的代码范围内直接写入；需求 Markdown 仍走材料审阅流程。
- 原型整体基线与各需求完成状态分别维护，确认原型不批量完成需求。
- 可读取当前项目本人有权读取的需求草稿，并如实注明草稿；材料更新只提醒，不重绑现场。
- 需求确认后只提供进入原型和准备指令的入口，实现指令由用户发送，删除自动实现。
- 干净合并自动重新检查后继续原确认；冲突经 AI 解决形成新成果，必须由用户重新确认。

用户随后要求明确同需求不能被两人同时开发：在独立分支之外，新增按需求身份排他的开发占用。开发需求与参考需求分别维护；同一任务可跨需求并动态扩领，材料版本不锁定、前置完成仍只提示。

## 2. 界面与事项选择

主界面保持项目原型、持续对话、预览／代码及可折叠输出四个区域，不增加固定需求输入面板。
增加轻量“我的协作事项”入口，显示本人未结束事项、最后活动与待恢复提示；切换事项才切换现场。
入口放在会话区或下拉选择中，主标题始终为项目原型，不被事项或单需求名称替代。
需求集合、文件、页面和聊天话题的选择只改变阅读焦点，不创建事项、占用、分支或会话。
需求关联分别呈现项目需求目录、当前事项实际涉及需求、基线历史涉及需求；三者都不自动证明实现覆盖。
项目目录用于发现材料，事项涉及记录本次实际协作范围，基线历史涉及保留接受时的关联说明与来源。
首次明确实现时，Host 识别实际开发需求并原子领取成功，再创建可写事项现场及推导持久 scope；不新增许可弹窗。已被占用时显示开发者与事项，保留本轮输入，不发送可写实现指令；身份不明确时先只读澄清，不擅自建需求。
现有 scope 内后续实现直接沿用授权与现场，无需另按确认按钮；用户明确扩大实现范围的指令才更新 scope。
纯讨论、需求阅读和准备指令不取得代码写权限；不为每条消息新建任务。
项目认可成果可直接只读查看、检查与预览，不隐式认领；只有进入实现才需要可写事项。
当前显示的工程来源在状态条说明为“项目已接受版本”或“我的协作事项”，细节放诊断入口。
事项切换前处理未保存缓冲；拒绝以切换、关闭面板或退出丢弃唯一草稿。
集成接受后界面展示新基线和事项已结束；继续编辑通过新事项从新的认可头开始。

## 3. Client 与 Host 契约

以下为已实现的命令契约，命名以 `shared/prototype.ts` 为准；所有写命令携带 operationId。
客户端不提供任意工作目录、命令字符串、占用所有者或可信权限字段，Host 从当前账号与项目推导。

| 命令 | 关键输入 | 结果与副作用 |
| --- | --- | --- |
| `savePrototypeInstructionDraft` | operationId、指令草稿 | 保存可编辑的指令草稿及拟授权范围，不发送模型。 |
| `startPrototypeCollaboration` | projectId、operationId、明确指令、拟授权范围 | Host 保存真实指令及跨步骤 operation，领取、授权并准备现场；无其他运行事项则直接派发，有运行事项则入队保存首次指令，不派发。 |
| `extendPrototypeDevelopment` | prototypeTaskId、operationId、明确扩范围指令、目标完整开发集合 | 后台按需求 ID 原子扩领，全成或回滚；成功返回完整 claim token 集合、claimsDigest 及新任务 revision，再允许新增业务写入。 |
| `continuePrototypeCollaboration` | prototypeTaskId、operationId、指令 | 校验活动 token 后发送到原会话，不新建事项。 |
| `queryPrototypeMessage` | prototypeTaskId | 查询未知模型消息的实际结果，不重发、不制作替代候选。 |
| `readPrototypeConversation` | prototypeTaskId | 返回恢复后的原生会话内容；只读，不重发未知消息。 |
| `readPrototypeQueue` | 可选 projectId | 返回本机当前账号跨项目队列、当前选择及待恢复位置；只读，不调度。 |
| `selectPrototypeQueueItem` | prototypeTaskId、operationId | 串行核对当前运行是否 settled，再切换事项和现场；不发送模型。 |
| `reorderPrototypeQueue` | operationId、稳定事项引用的完整顺序 | 校验本人本机队列后持久化顺序；不重新授权、不启动下一项。 |
| `pausePrototypeQueueItem` | prototypeTaskId、operationId | 保存恢复位置，取消当前模型并等待 settled；保留事项及全部开发 claim。 |
| `resumePrototypeQueueItem` | prototypeTaskId、operationId、明确继续指令 | 核对现场、未知操作及有效 claim 后，在原会话开始新一轮；不重发历史未知请求。 |
| `listPrototypeDirectory` | 工程引用、相对目录、cursor、limit | 返回受控子项、只读／保护属性、工程与观察版本、截断及下一游标；不递归遍历客户端路径。 |
| `searchPrototypeFiles` | 工程引用、文字 query、相对范围、cursor、limit | 在同一受控文件集内搜索，返回路径、行列、有限片段与文件 hash；不执行 shell 或任意正则。 |
| `readPrototypeDiff` | 工程引用、Host 发放的比较基准、相对范围、cursor、limit | 返回真实文件增删改及受限文本 hunks、两侧 hash 和截断信息；不接受任意 ref 或磁盘路径。 |
| `readPrototypeFile` | 工程引用、相对路径、可选行范围 | 返回受限正文、hash、只读／保护属性、工程与观察版本；二进制仅返回允许展示的元信息。 |
| `savePrototypeFile` | prototypeTaskId、path、expectedHash、正文 | 比较磁盘 hash 后原子保存；冲突返回当前 hash 与读取入口。 |
| `mergePrototypeConflict` | prototypeTaskId、path、两侧 hash 与正文、最终正文 | 显式解决编辑冲突后落盘，保留双方输入。 |
| `readPrototypeBuffer`、`savePrototypeBuffer`、`clearPrototypeBuffer` | prototypeTaskId、path、缓冲内容 | 未保存缓冲的读取、持久化与清除；不覆盖磁盘内容。 |
| `endPrototypeTask` | prototypeTaskId、operationId | 先核对未决集成结果，再释放有效授权，保留未接受代码、缓冲及会话定位。 |
| `checkProjectPrototype`、`startProjectPrototypePreview`、`stopProjectPrototypePreview` | prototypeTaskId、operationId | 任务工程的受控检查与预览实例；必要时受控安装／检查后启动，不触发模型。 |
| `checkPrototypeBaseline`、`startPrototypeBaselinePreview`、`stopPrototypeBaselinePreview` | baseline 来源（commitSha）、operationId | 已接受基线的检查与预览实例；只读，不认领。 |
| `selectPrototypePreview` | 可选预览来源 | 切换当前预览选择，不用旧 URL 覆盖当前选择。 |
| `preparePrototypeConfirmation` | prototypeTaskId、operationId | 固定候选、范围、检查证据并返回确认摘要和确认摘要 hash。 |
| `readPrototypeCandidateFile` | operationId、path | 读取已准备候选中的单个文件。 |
| `checkPrototypeCandidate` | operationId、checkOperationId | 对已准备候选运行检查，结果绑定该候选。 |
| `confirmPrototype` | operationId、expectedSummaryHash | 只确认所见精确候选。 |
| `submitPrototypeCandidate` | operationId、checkOperationId | 提交已确认候选进入集成。 |
| `adoptPrototypeBaseline` | operationId、基线来源、targetTaskId、调整说明 | 以已接受基线为起点采用到目标任务。 |

工程引用是 Host 发放的项目认可版本或 prototypeTaskId，不是客户端传入的 filesystem path。
统一结果包含 operationId、当前 revision、业务状态及可恢复错误；路径与原始日志进入诊断字段。
错误码区分权限失效、文件冲突、工程变化、检查失败、确认过期、远端头变化和结果未知。
重复 operationId 绑定同一规范化请求，不允许改正文、路径范围或候选后复用原键。

| 结果片段 | 最小内容 | 消费规则 |
| --- | --- | --- |
| `state`（每次命令返回） | 项目投影、revision、认可头、当前基线、事项与队列摘要 | 以命令返回的完整投影为准，按 revision 丢弃旧投影。 |
| `prototypeFiles` | 受控读取结果（目录、搜索、diff、正文）及观察版本 | 过期观察版本须重新读取，不覆盖未保存缓冲。 |
| `prototypeConversation` | 原生会话内容 | 只读回读；选中不等于已读。 |
| `prototypeCandidateFile` | 候选文件正文与元信息 | 只在 prepare 之后读取。 |
| `prototypeBuffer` | 未保存缓冲的内容与基准 hash | 用于恢复编辑现场，不当作磁盘事实。 |
| `prototypePreview` | 预览实例、工程指纹、运行状态、受管 URL | 只更新匹配实例，不用旧 URL 覆盖当前选择。 |
| `prototypeQueue` | 本机账号队列 revision、稳定事项引用及顺序、当前选择、本地调度状态 | 完整投影覆盖旧 revision；项目过滤不改变跨项目运行上限。 |

上述片段由 Host 持久状态投影产生，随命令答复返回；客户端不以自行推断的 accepted 或权限代替 Host 事实。
原生模型输出仍通过 DSH 会话承载，不复制一套模型消息、审批与取消协议。

## 4. 协作事项与原生会话

事项保存 projectId、prototypeTaskId、ownerId、clientId、token、baseHead、branch、worktree、sessionId 和授权范围。
同时保存 developmentRequirementIds、referenceRequirementIds、完整 DevelopmentClaimToken 集合与 claimsDigest；恢复须读取当前服务端 active claims，不能仅用旧幂等回执恢复已释放开发权。
token 统一为 prototypeTaskId／generation／clientId／expectedRevision，不复用材料 occupationId；owner 从认证上下文取得。
服务端权威校验 token 和 owner，不信任客户端声明，不从目录存在推断有效。
后台事项 status 统一为 active、cancelled、released、accepted；preparing／paused／integrating 仅描述本地工作、会话或操作阶段。
后台 integration 状态为 prepared、accepted、aborted；unknown 只表示本地尚不知道外部结果，不是后台事实。
检查失败、模型取消和应用退出不自动释放事项；本地暂停保留现场，不影响其他人的分支。
后台接受始终校验有效 token 并 fencing 旧代次；Host 观测撤销立即停止会话，拒绝后续工具写入。
断网或已在途写入可能无法即时撤回，保留产生的代码且不能声称被接受；不新增每文件强制联网许可流程。
创建事项先持久化 operationId，再申请占用；响应丢失先查询原操作，不重新申请另一 token。
任务及初始开发集合在同一后端事务创建，至少一个真实需求 ID，草稿也可领取；任一需求被别的任务占用则整批回滚。同一用户的两个任务同样互斥。首次模型业务写入和直接编辑前都执行相同准入；参考需求和空开发集合不授予业务写权限。
扩领只允许增加开发需求，活动任务不能通过删关联、降级参考或只改 scope 释放单项开发权；接受／取消／管理员释放时同事务结束全部 claim。跨需求共享组件仍依代码范围及 Git 合并管理，不因此取得他人需求开发权。
私有 worktree 从协同服务认可头创建，先确保固定提交本机可读，再创建分支并登记实际路径。
worktree 路径限定在账号／项目的受管根目录，使用 prototypeTaskId，拒绝链接与客户端自报路径。
工程基底来自认可代码头；需求草稿不复制进工程作为自动固定依据，也不修改认可头。
准备中崩溃按原 operationId、token、分支和路径继续核对；已有异样现场停止并提供诊断，不覆盖重建。
首次实现创建 DSH 原生 session；后续对话、文件切换和重复打开复用同一 sessionId。
恢复先核对账号、项目、事项状态、token 代次、工程路径与分支，再检查原生日志是否存在。
沿用 `agentPresets.resolve/mount` 和官方 `agents.create/resume`，恢复原投影中的模型选择与 preset。
模型消息发送前保存 messageOperationId 和 sending；发送失败或中断结果未知时查询原生日志。
只有找到对应可信消息标识才能判定已发送；无法证明未发送时保留 unknown，不自动重发。
原生会话无法恢复时保留现场与原日志定位，不能静默建立新会话并声称上下文连续。

### 4.1 本机持久队列与串行运行

用户已确认默认串行、手动继续或切换，重启仅恢复现场，不自动重发模型。
队列的一项就是一个协作事项，可以包含多个开发需求；不按已读材料或每个需求自动拆项。
队列执行权威属于本机账号与稳定 clientId；后台只权威管理 task、claim 和 accepted 等协同事实。
一个账号在后台可以有多个 active 事项，已领取而待排队的事项仍持有无 TTL 的开发 claim。
同需求开发排他、开发集合只增不减仍按协同契约执行；本地暂停和重排均不释放 claim。
后台 status 不新增 queued、running 或 paused，避免把本机调度状态混入协同业务状态。
本机当前账号跨项目最多一个事项执行 AI 实现；项目切换不能绕过该上限。
普通读取、投影刷新、登录和恢复均不触发调度，也不根据队首顺序自动发送模型。
模型一轮结束只进入 awaiting-user，不代表后台 accepted，也不自动启动下一事项。
暂停、待核对或等待用户时可以手动选择其他事项；明确继续指令仍遵守用户指令才启动模型的边界。
切换前取消当前生成并等待 settled；未知在途调用先核对，不启动第二个针对同现场的写入。
重排只改变本地顺序与队列 revision，不改变后台 task revision／claimsDigest，不扩大 scope，也不将此前授权解释为自动继续授权。

首次指令入队与派发（R11，待整体确认）：Host 在账号串行入口内先保存用户动作、指令及固定 messageOperationId，再完成创建、初始 claims／scope 和现场准备。当前没有其他运行事项且无未收敛执行时，首次明确发送直接派发，不要求第二次继续；已有运行事项时，另一事项创建成功即持久入队，首次指令保持 pending，当前执行不被抢占。创建／扩领失败保留输入及恢复操作，不把尚未创建成功的操作伪装为有效事项队列项。
待开始项通过用户手动选择并继续才派发原来保存的首次指令，沿用原 messageOperationId；选择本身不发送，也不要求用户重输该指令。新增补充意图单独保存，不改变原待投递请求或重用其键。调度锁内重新核对当前运行及授权，防止两个同时发送争抢执行槽。准备现场失败保留已创建事项与占用，通过原 operation 补齐，不另领一项。模型结束、刷新及重启均不自动派发 pending 首次指令；重启须用户手动继续，已经 sending 的指令先核对投递，不当作 pending 重发。跨步骤记录与 token 接续见[协同契约 §7.1](collaboration-contract.md#71-一次实现指令的跨步骤恢复r08待整体确认)。

复用账号隔离 StudioStore，新增本地 taskQueue 与 currentSelectedTask，不另建分布式队列或 Redis／BullMQ。
每项只保存恢复需要的有限元数据；代码正文、模型历史和后台事实分别留在原有责任层。

| 本地字段 | 作用 |
| --- | --- |
| 稳定事项引用、order | 以 projectId／prototypeTaskId 定位事项，保存本机排序；不复制需求作为队列身份。 |
| localDispatchState | 表达 queued、running、awaiting-user、paused、recovery-required 等本地阶段，与后台 status 分离。 |
| runId、messageOperationId | 区分用户明确启动的一轮与待核对消息；重试沿用原操作身份，不能仅比对消息正文。 |
| 已确认事件 seq／消息标识 | 保存 Host 已确认消费的位置；真实 ack／eventId 来自原生协议，不能由客户端猜测。 |
| nextAction、待恢复操作引用 | 指向继续、核对、冲突处理或收尾入口；Git／文件操作正文仍在各自持久记录中。 |
| currentSelectedTask | 保存账号当前选择；选择恢复不等于授予执行许可。 |
| workspaceViewState／draftRefs | 保存预览或代码视图、已打开文件、当前文件及光标位置，并引用编辑缓冲和未发送输入；不复制一套工程文件，恢复缓冲仍核对原磁盘 hash。 |

会话、工作树、branch、base/ref 及授权身份沿用事项记录，不再复制一套可独立漂移的任务实体。
队列修改及 current／reorder／pause／continue 命令由 Host 串行校验后持久化，再发布投影。
保存沿用同目录临时文件与 rename；读取失败保留诊断，不能用空队列掩盖原记录损坏。
其他设备只能看到后台占用事实，不能声称拥有本机队列、未提交代码或可无缝恢复的 worktree。

### 4.2 关闭与重启恢复次序

正常关闭先持久化队列、代码编辑 buffer、原生输入草稿及待恢复操作；不靠退出时才创建恢复记录。
Host 进入关闭阶段后停止接收新的开始／切换／写入命令；在途写入收敛后再次保存最终状态，避免首轮保存后又产生未记录变更。
随后取消模型并等待可核对的结束，flush 原生会话与本地状态成功后，才关闭受管进程及应用。
保存或 flush 失败保留界面和输入并显示原因，不把退出成功或请求已接受当作保存成功。
退出不额外 commit／push／确认，不删除 worktree，不释放后台事项或开发 claim。
崩溃后将原 running 标记 recovery-required；只承诺恢复已确认落盘内容，最后未落盘击键和模型 token 不保证完整。
恢复生成现场不等于恢复生成线程；在途工具和模型请求不能从进程内断点继续。

1. 登录同一账号并加载稳定 clientId，读取队列、当前选择及恢复记录，不运行模型。
2. 查询后台 task 和当前 claim generation；accepted 仅执行独立收尾，released／cancelled 现场只读保留。
3. 校验原 worktree、branch、base/ref、脏文件及当前写权限；认可头推进不覆盖现场，不 reset 到最新 head。
4. 核对 sending 消息、Git 推送及文件工具未知结果，以真实回执、日志事件和外部事实判定，不盲重发。
5. 通过官方 preset mount 与 resume 恢复原 session、历史、原生输入及编辑 buffer；磁盘 hash 冲突保留两份内容。
6. 显示恢复到的位置、未知操作和继续入口；用户发送明确继续指令后才开始新的 turn。
7. 按需重建检查与预览实例，浏览器创建新 generation；不复用无法确认归属的旧活进程或旧页面状态。

原 worktree 或 session 缺失时保留队列项与诊断，不静默新建会话，也不重新 clone 覆盖唯一现场。
历史请求不能证明未发送时维持待核对；不能为绕过未知状态创建第二个写入同现场的执行者。
普通会话恢复不重新绑定需求版本；材料更新仍是提醒，不改变既定事项开发集合与工程基底。

### 4.3 已实现的队列、退出协议与恢复入口

本机持久队列、退出协议与桌面崩溃恢复已实现；下列位置以当前源码为准，真实桌面闭环仍未验收。

| 已实现机制 | 源码位置 | 事实 |
| --- | --- | --- |
| 队列与调度 | `host/application/prototype-collaboration.ts`、`shared/prototype.ts` | 按账号隔离的跨项目队列、当前选择、`localDispatchState` 与 `nextAction`；默认串行，用户手动继续或切换，项目过滤不改变运行上限。 |
| 记录与保存 | `host/application/state.ts` | 项目管理、事项、候选、操作、评审、采用、初始化、材料预留、模板操作、场景、修复与一致性对比按账号隔离，串行 temp／rename 落盘。 |
| 退出收敛 | `host/adapters/dsh/sessions.ts`（`settlePrototype`、`dispose`） | 关闭时取消模型、等待 idle、flush 原生会话；未收敛即中止关闭并保留事项与现场，不伪报已保存。 |
| 崩溃恢复 | `client/prototype/PrototypeWorkbench.tsx`、`host/application/prototype-collaboration.ts` | 原 running 标记 `recovery-required`；恢复先查询后台与未知操作，用户明确继续后才开始新一轮。 |
| 会话恢复 | `host/adapters/dsh/sessions.ts` | 通过官方 preset mount 与 resume 恢复原 session 与投影；不重发未知消息。 |
| 后台车道 | `host/application/background-lane.ts` | 进程内串行与去重执行器，不作为持久业务队列或恢复权威。 |
| 接受后收尾 | `host/application/task-maintenance.ts` | 独立收尾记录承接资源释放、归档与 Git 清理；不以模型结束替代 accepted。 |

方案沿用持久状态机、原生会话日志及 Git worktree 的成熟分工，不把模型输出历史当业务队列。
上游缓存中原生 conversation 按 session 保存 localStorage 草稿，原生持久化以 flush 为耐久屏障，崩溃开放轮次以 interrupted 收尾；这些源码能力仍须在当前装配版本验证，不承诺最后事件完整或原请求自动续跑。

### 4.4 原生恢复能力的未知边界（待固定宿主验证）

messageOperationId 是 Host 的业务身份，不因写入本地记录就成为 DSH 已支持的幂等消息键。PT03 事项与原生队列的实现和验收须分别核实：创建 session 的可靠身份与结果查询、发送请求与原生日志消息 ID 的稳定关联、ack 的确切含义和耐久位置、事件 seq 重放范围、取消是否涵盖在途工具并达到 settled、flush 成功所覆盖的内容，以及 resume 是否可能重放执行。请求被接收、模型已结束、日志已落盘是不同事实。
若固定宿主只能恢复历史而不能证明某消息未发出，则该消息保持 unknown，展示历史及诊断定位，不自动重发、不用新 session 或新 messageOperationId 绕过。仅在可信协议事实证明未投递且旧调用已收敛时，才可恢复原发送步骤；确认已投递则标记该步完成，后续新的继续指令另开 turn。取消请求返回不等于 settled，取消未知时不能抢占执行槽开启另一实现。若不能证明 flush 耐久或 session 创建结果，明确相应恢复能力未验证，不承诺无损退出或静默补建；这是技术能力缺口，不增加业务确认按钮替代。
本节仅列待验证契约，不声称已有原生 ack／message ID 注入或可靠查询 API；直接按设计在 PT03 中实现并核对这些能力，不设独立技术验证前置环节。实现中发现固定宿主不能满足目标时，记录证据、受影响契约和未完成项；涉及改变既定路线或业务决定时再提请用户决定，不能实现猜测协议或将缺口记为验收通过。

## 5. AI 上下文与实际读取证据

原型会话读取当前工程、当前指令和本人可读的项目材料，不要求选定唯一需求及固定版本。
Host 提供可访问材料目录和读取工具，不把目录清单或摘要自动记为模型已读取正文。
需求草稿与已确认材料均显示状态、材料标识、实际内容 hash 和读取时间；版本号仅在实际存在时显示。
每次读取记录内容 hash、范围、来源状态和会话；图片只在成功返回可用图像后记为已读。
读取草稿需在读取前后验证当前权限；不得借服务器已同步摘要读取他人私有草稿。
本人草稿只从 Host 已登记且归属本人、同一项目的材料工作区只读提供，不扫描其他成员或未登记私有现场。
材料后来更新时提示差异及查看入口，不替换历史读取记录、不重绑事项、不阻止继续实现。
AI 实际读取 hash 用于说明当时理解了哪些内容，不证明未提交草稿可以从 Git 重新取得。
正式基线保证代码提交可重现；对未提交材料只保留合规读取证据与状态说明，不宣称材料快照可重现。
需求冲突或规则不明时提出问题；原型代码授权不扩展到修改需求 MD、确认材料或改变需求完成状态。
删除现有 requirement 接受后自动 `prompt` 路径，仅产生进入原型和准备指令的提示。

## 6. 文件查看、编辑与写入保护

文件树、搜索、变更卡和检查问题统一通过 Host 路径解析定位当前工程，不读取研发仓库缓存。
工程读取拒绝逃逸链接、Git 元数据、凭据及工程外文件；大文件和二进制按现有文件能力处理。
文本编辑缓冲按账号、项目、事项和路径隔离，保存原始 hash、编辑内容与脏状态。
保存前比较磁盘 expectedHash；不匹配保留本地缓冲，展示磁盘差异后由用户选择合并内容。
AI 写入与用户保存使用同一范围校验、文件并发控制及同目录临时文件原子替换。
保存与 Agent 写入围绕同一路径串行化；锁内重新比较 hash，避免验证后覆盖并发成果。
模型请求和确认前要求相关未保存内容先保存；其他缓冲可以保留，但明确不计入磁盘工程成果。
退出和切换提供保存／保留草稿／明确放弃；保留草稿仍按原 hash 恢复，不无条件覆盖磁盘。
普通代码授权由事项允许范围与模板可写范围取交集，Host 不信任模型声明的扩大范围。
业务写入还要求该任务持有非空的有效开发 claim 集合；新指令包含新需求时先扩领再允许该范围写入。Host 观测占用撤销后拒绝后续工具写与直接保存；离线或在途写不能即时撤回，但旧代成果不得被后台接受。
保护 package/lock、构建配置、AGENT.md、全局布局、Mock 初始化、预览脚本及网络围栏。
扩大代码范围由用户明确实现指令授权，Host 推导同一事项的 scope 更新并记录 revision，不增加每轮许可弹窗。
该指令不得扩展到模板维护、shell 或 Git 权限；无法从明确指令确定范围时才询问缺少的业务信息。
保留现有文件工具 guard 及子 Agent 相同目录继承；未知工具默认拒绝，不向预览页面暴露 Host 命令。

### 6.1 目录、搜索与 diff 的受控读取（R12，待整体确认）

四类查询共用 Host 文件解析器、工程归属与过滤规则；每次请求校验账号／项目和工程引用，只读 baseline 绑定 baselineId／commitSha，事项绑定 prototypeTaskId／generation／磁盘观察标识。返回工程来源、实际版本／观察标识、各文件内容 hash 与完整／截断标记；可变事项不是全工程原子快照，不把查询时间或 Git HEAD 当脏工程版本。分页游标绑定查询和观察版本，变化时返回工程已变化并要求重查，不拼接新旧页。目录／搜索列表不产生“正文已读”证据，diff 仅记录实际返回的两侧片段。

所有路径须为规范相对路径，拒绝绝对路径、`..`、NUL、逃逸符号链接和受管根外目标；拒绝 Git 元数据、凭据和秘密文件，排除依赖、缓存与构建产物目录。过滤先于目录投影、内容搜索和 diff，不能借文件名、错误、片段或删除侧正文泄漏被过滤内容。保护但可读的模板文件可标记只读；保护写入和保密读取不能混为一项权限。读取过程重新校验解析后的对象，拒绝遍历中替换链接造成的逃逸。

提议统一上限：目录每页最多 200 项，搜索每页最多 100 处、query 最多 200 字且只作文字匹配；单文件正文最多 1 MiB，超过时仅返回元信息或显式行范围；单次正文／diff 响应最多 1 MiB，diff 每页最多 100 文件和 2000 行。Host 同时限制总扫描文件数与执行时间，达到上限返回 truncated、原因及可用继续入口，不以部分结果宣称“无匹配／无变化”。二进制、超限或不可读项不返回伪正文；超限文件的行范围读取仍受单次字节上限约束。具体常量在实现与 shared 契约同处定义，不由客户端取消限制。

diff 比较基准由 Host 提供：事项可比较登记的 sourceBaseHead／明确选择的已接受基线与当前磁盘成果；认可快照只比较本人有权读取的固定已接受版本。返回 base／target 的准确身份、增加／删除／修改／重命名标记和两侧 hash；删除侧、重命名前路径同样经过过滤，不执行外部 diff driver／textconv。未保存编辑缓冲由编辑器明确标为本地草稿，不能混入磁盘 diff 或基线变化卡；空 diff 与截断／过滤／错误分别表达。客户端不通过 Node、任意磁盘遍历或任意 Git ref 绕过此服务。

## 7. 工程检查与预览实例

检查由 Host 固定 allowlist 编排，随包 Node、pnpm、Git 与平台进程管理执行，不要求用户装工具。
保留 frozen install、typecheck、lint、build 和 Electron 静态浏览器／Mock／网络保护检查。
安装前校验模板保护文件与锁文件，工作目录绑定受管工程；禁止任意脚本名和 shell 字符串。
检查 operation 持久化工程引用、开始／结束时间、每步退出码、日志引用和失败原因。
工程指纹包含源码文件集合 hash、模板版本／保护文件 hash、锁文件 hash、工具版本及检查器版本。
记录构建产物 hash、固定候选 SHA（若已有）和浏览器证据；不能只比较 Git HEAD 复用脏工程检查。
复用前重新算工程和产物指纹；运行时文件变化、规则变化、工具变化或产物丢失立即失效。
重启后可复用完整且仍匹配的已完成证据；running 记录标为待核对，不能自动标成功。
检查与预览本身不认领事项、不创建模型会话、不发送模型请求；只读认可版本使用独立受管运行目录。
无事项时，按已接受提交建立本机隔离源码快照，业务源码只读；依赖安装、构建缓存与产物留在隔离运行现场。
隔离运行现场不是协作事项，不申请 token、不建立可写业务分支，也不向用户业务工程安装依赖或写构建文件。
文件查看同样读取已接受快照，不将业务工程当前未提交内容混入已接受版本；运行失败保留诊断并可重建隔离现场。
删除旧 `relations` 对固定需求 hash 或前置需求完成的阻断门禁，改为非阻断关联诊断，不伪造关系检查通过证据。
每个工程最多一个活动预览，项目认可版本与不同事项使用各自 previewId 和进程实例。
端口由 Host 从 loopback 可用端口分配并保留进程关联，遇占用重新分配，不固定全局 4173。
启动核对随机 instance、dist、synthetic-only ready 回执，再执行隔离 Electron 浏览器保护检查。
预览进程记录 pid／实例标识、工程指纹与 URL；重启后无法验证归属则视为停止，不误杀未知进程。
工程修改后保留旧预览并标明旧成果；重新运行构建新实例，成功后切换，不把旧预览当最新结果。
停止仅作用于对应 previewId，取消／超时回收该次受管进程树；失败保留源码和诊断。
浏览器技术保护检查不证明业务交互正确，作者仍需核对跨页面流程与需求预期。

### 7.1 本地浏览器业务验证

保留已有 Electron 私有 IPC 保护检查；新增的真实交互验证使用专属 Playwright／Chromium，由固定 DSH 的 SessionResources、受限 stdio MCP provider 和附件管道接入原生会话。新增适配器只负责会话与预览归属、权限和结果编排，不自行实现 locator、等待、截图或断言引擎；不原样开放上游 alpha provider 的完整工具。

受管浏览器服务挂载在原生会话创建／恢复之前，实际 Chromium 进程按打开受管预览的操作启动，不为纯讨论强制启动浏览器。工具仅作用于当前验证 run、previewId／generation、产物 hash 及精确 loopback origin；目标是带代次的任务现场，或 baselineId／commitSha 的已接受只读快照。后者不携写任务 token、不领取需求，不因自动验证创建可写事项；不接桌面全局 9222、不访问用户日常浏览器。

工具集合限定定位、点击、填写、选择、按键、等待、可见内容断言、DOM／可访问性快照、截图和诊断读取；Host execution guard 按当前会话及该集合精确放行，继续拒绝任意代码执行、文件访问、安装、任意 CDP endpoint 和跨任务 target。读取截图须走原生附件存储及支持图像模型；模型不支持图像时明确“未看图”，不把截图生成当成视觉核对。

本地验证按具体需求用例运行，记录操作、预期和实际、截图、console/pageerror、允许／拒绝网络记录及 trace。内存 requestMock 的调用不产生真实 HTTP，不能伪造为 HAR 请求。新浏览器须另装默认拒绝的网络围栏，不能假定继承 Electron session 的保护。完整流程、分发成本及 PT05B 实现与验收要求见[选型与浏览器验证](technology-and-browser-validation.md)。

## 8. 精确候选、集成与恢复

准备确认前核对有效事项 token、磁盘状态、允许路径和当前工程指纹，再固定本事项候选提交。
候选保存 sourceSha、sourceBaseHead、candidateSha、expectedHead、changedPaths、工程／产物指纹、检查证据及确认摘要 hash。
Host 以任务 sourceBaseHead 和当前精确授权原型树构造单提交 source，第一父为该 base，归一前后原型树不变。
只生成独立不可变 source 引用，不重写原多轮事项分支历史，也不混入未授权或未接受的其他成果。
客户端确认必须带候选标识与摘要 hash；本事项额外业务代码变化、授权范围变化或冲突修正使原确认失效。
作者确认还绑定完整 claimsDigest；prepare 与 complete 核对当前任务全部 active 开发 claim 及独立代次，不能遗漏或只检查本次新增项。后台接受同事务形成基线并关闭全部开发占用；需求材料状态不随之改变。
原作者确认同时绑定 sourceSha、自身 diff 及干净合并后重新技术检查的策略，允许以下受控派生 candidate。
sourceBaseHead 等于 expectedHead 时 candidate 等于 source；认可头推进时构造干净合并 candidate，父顺序为 expectedHead／source。
作者确认 source 后先持久化操作及不可变 source ref／SHA 并上传，再计算合并；生成 candidate 后持久化并上传 candidate ref。两个对象均可读、完整请求与幂等键落盘后才 prepare。
上传答复未知先查询原 ref 与 SHA；不以重推新内容或重新归一 source 替代原操作。
Git 私有 ref 上传成功只显示待同步；只有后台 prepared 后才条件推进 stable，prepare 与 complete 均校验 token 与 revision。
认可头变化时在受管集成现场合并最新认可成果，保留原 source、candidate 与事项分支可定位。
干净合并仅加入已接受成果，保留可核对的原作者 sourceSha 和自身 diff；派生 candidate 重检有效后自动继续原确认。
机器校验越权路径、混入未接受变更或检查失败时停止；不声称可以自动识别业务语义变化，也不另设此隐形门禁。
作者可自主核对跨事项交互和语义；该自主核对不变成每次干净合并必须重确认的流程。
出现冲突时先展示涉及文件；用户已授权的冲突 AI 处理只写冲突范围，不取得任意工程维护权限。
AI 解决后以最新认可头归一新 source，再构造候选、重新检查并展示变更，等待用户重新确认，原确认不能继续提交。
无法解决、取消或检查失败保留合并现场及原候选，重试从原 operation 恢复，不用新候选冒充原结果。
响应未知先查询原 operation／integration 回执及实际远端头；只在明确未发生时继续原请求。
取消事项若已有 prepared 集成或推送结果 unknown，先核对后台结果；后台已 accepted 则按接受收尾，不显示 cancelled。
撤销一次提交但保留事项调用新增 `POST /integrations/:id/abort`；不把单次 integration 中止等同于事项取消。
stable 已为 candidate 时不能当作尚未推送而取消，先查原接受结果；abort 后晚到的 push 仍须按实际 ref 与操作记录 reconcile。
integration prepared 期间禁止变更正式事项的需求关联或授权 scope；先解决原集成，再受控更新事项。
无代码变化处理（R09，待整体确认）沿用[协同契约 §6](collaboration-contract.md#6-事务顺序与并发集成)：只查看既有基线时仍为 active 并保留全部 claims，界面说明事项仍在开发；明确选择结束才调用 cancel，核对未决集成后保留现场并释放全部占用，不制造 accepted 或相同代码新基线。
后台 accepted 才更新原型基线并结束事项；各需求完成状态保持独立，不能由集成代码推断。
accepted 后本机主检出同步、会话释放、预览处理和现场收尾分别记录结果，失败独立重试。
未接受、取消或授权失效事项不自动删除；唯一草稿、未合入代码与会话定位必须保留。
已接受现场清理前确认无新草稿和未合入提交；必要的唯一成果归档校验后才清理，不复制可重建依赖。

## 9. 模块职责

| 模块 | 当前职责 |
| --- | --- |
| `client/studio` 与 `client/prototype` | 项目成果、我的事项、文件缓冲与运行输出分组件；原型工作台为 `client/prototype/PrototypeWorkbench.tsx`。 |
| `shared/prototype.ts` | 文件来源、命令与结果、队列项与原生消息身份的唯一契约定义。 |
| `shared/studio.ts` | `TaskView`（第 41 行）以 `purpose` 区分 `material`／`split`／`prototype`／`handoff`／`review`，并携带 `prototypeBaseline`、`cleanup`、`handoff`、`split` 等绑定；事项不再以单需求输入为身份。 |
| `host/application/studio.ts` | 命令分派与应用组合；原型命令分派到独立应用模块，不在此实现业务算法。 |
| `host/application/prototype-collaboration.ts` | 事项 token、worktree、会话接续、队列与取消；复用账号 scope 与后台 lane。 |
| `host/application/prototype-candidates.ts`、`prototype-integrations.ts` | 候选固定／检查／确认／提交与集成恢复。 |
| `host/adapters/dsh/sessions.ts` | 官方 preset／model／session 恢复、事项上下文读取、消息操作核对；关闭收敛在 `settlePrototype`／`releaseWorktree`／`dispose`（约 286–315 行），失败时中止关闭并保留现场。 |
| `host/adapters/platform/execution-guard.ts` | 真实 Agent 身份绑定、路径校验、事项授权交集与文件并发控制。 |
| 原型浏览器适配与受限服务 | 复用固定 DSH SessionResources／stdio MCP／附件生命周期；内核独立锁定稳定 Playwright，按事项及预览代次限制动作和目标，不放行全部 MCP 工具。 |
| `host/prototype/template.ts` | 模板保护校验改为事项身份／代码提交绑定，不再要求单 requirementId。 |
| `host/prototype/checks.ts`、`preview.ts` | 校验算法保持不变；证据持久化与实例管理在应用层，避免全局缓存／端口。 |
| `host/composition.ts` | 仅装配依赖，不承载检查缓存、预览实例或运行编排。 |
| `host/application/fixed-candidates.ts` | 材料候选继续服务材料；原型候选由独立模块按事项范围固定。 |
| `host/application/git-integrations.ts` | 幂等查询、条件推送与 accepted 恢复；原型合并重检与重新确认分支由原型集成模块复用。 |
| `task-maintenance.ts` | 复用接受后独立收尾，不能提前删除未接受事项或唯一成果。 |

现有 `PrototypeStartup`、单需求 `inputHash` 门禁及旧 claim/check 隐式创建任务路径直接替换，不留兼容入口。
协议、持久状态与界面同步切换；旧开发数据按唯一成果保护规则处理，不添加 migration 或 fallback。

## 10. 后续实现验证边界

按设计工作包直接开发，真实能力核对与相应实现、失败恢复及验收同步进行：PT03 覆盖固定宿主会话与队列，PT04 覆盖编辑器与文件，PT05 覆盖内嵌预览，PT05B 覆盖受管浏览器与发行装配；不另设独立技术验证前置阶段。各工作包未完成的真实运行检查保留为未验收，不能以局部检查替代 PT08 的完整桌面闭环。

先覆盖事项多轮接续、跨需求草稿读取说明、文件并发保存、保护区拒绝、检查证据失效与实例隔离。
补充 R08／R11：逐步注入创建／扩领响应丢失、扩领成功但 scope 失败、scope 成功而现场失败、发送前后崩溃及两次并发首次发送，核对原操作键、完整 claims、新 revision、保留指令和无重复派发；有运行事项入队后，轮次结束与重启均不自动派发。补充 R09 的无变化查看仍占用与明确结束走 cancel，补充 R12 的路径逃逸、过滤、分页中变更、超限截断、二进制及删除侧过滤；这些均为后续验证要求，本轮未执行。
再覆盖干净合并重检、冲突重新确认、推送后响应丢失、token 撤销、重启恢复和 accepted 后收尾失败。
最终按当前交付版本完成真实桌面 → 原生真实模型 → Host → 指定协同服务 → Git／持久化闭环。
协同联调固定现有配置指向的 `100.119.183.44` 服务；本设计不授权远端修改或产品运行。
局部检查、模板构建与静态页面均单独报告；未完成真实桌面闭环的部分明确记为未验收。
