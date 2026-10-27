# 原型桌面与 Host 运行时技术设计

状态：2026-10-26 技术设计草案，整体设计待用户最终确认；本文件不表示源码已实现或桌面已验收。

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

以下为替换现有单需求命令的目标契约，命名在 shared 中统一定义；所有写命令携带 operationId。
客户端不提供任意工作目录、命令字符串、占用所有者或可信权限字段，Host 从当前账号与项目推导。

| 命令 | 关键输入 | 结果与副作用 |
| --- | --- | --- |
| `openPrototype` | projectId、可选 prototypeTaskId | 返回项目原型投影或本人事项；只读，不认领。 |
| `preparePrototypeInstruction` | projectId、关注需求／文件、意图 | 返回可编辑指令草稿及拟授权范围，不发送模型。 |
| `startPrototypeCollaboration` | projectId、operationId、明确指令、拟授权范围 | Host 校验并建立事项、token、私有 worktree 和原生会话。 |
| `extendPrototypeDevelopment` | prototypeTaskId、operationId、明确扩范围指令、目标完整开发集合 | 后台按需求 ID 原子扩领，全成或回滚；成功返回完整 claim token 集合、claimsDigest 及新任务 revision，再允许新增业务写入。 |
| `continuePrototypeCollaboration` | prototypeTaskId、operationId、指令 | 校验活动 token 后发送到原会话，不新建事项。 |
| `restorePrototypeSession` | prototypeTaskId | 核对事项与现场后恢复原生会话，不自动重发未知消息。 |
| `readPrototypeQueue` | 可选 projectId | 返回本机当前账号跨项目队列、当前选择及待恢复位置；只读，不调度。 |
| `selectPrototypeQueueItem` | prototypeTaskId、operationId | 串行核对当前运行是否 settled，再切换事项和现场；不发送模型。 |
| `reorderPrototypeQueue` | operationId、稳定事项引用的完整顺序 | 校验本人本机队列后持久化顺序；不重新授权、不启动下一项。 |
| `pausePrototypeQueueItem` | prototypeTaskId、operationId | 保存恢复位置，取消当前模型并等待 settled；保留事项及全部开发 claim。 |
| `resumePrototypeQueueItem` | prototypeTaskId、operationId、明确继续指令 | 核对现场、未知操作及有效 claim 后，在原会话开始新一轮；不重发历史未知请求。 |
| `readPrototypeFile` | 工程引用、相对路径 | 返回正文、hash、只读／保护属性；二进制返回元信息。 |
| `savePrototypeFile` | prototypeTaskId、path、expectedHash、正文 | 比较磁盘 hash 后原子保存；冲突返回当前 hash 与读取入口。 |
| `checkPrototype` | 工程引用、operationId | 返回受控工程检查 operation，不认领、不触发模型。 |
| `startPrototypePreview` | 工程引用、operationId | 必要时受控安装／检查后启动对应实例，不触发模型。 |
| `stopPrototypePreview` | previewId | 仅停止该工程实例，幂等返回已停止结果。 |
| `preparePrototypeConfirmation` | prototypeTaskId、operationId | 固定候选、范围、检查证据并返回确认摘要和确认摘要 hash。 |
| `confirmPrototype` | prototypeTaskId、candidateId、expectedSummaryHash、确认方式 | 只确认所见精确候选，返回集成 operation。 |
| `queryPrototypeOperation` | operationId | 查询本地记录及协同幂等回执，不制作替代候选。 |
| `cancelPrototypeCollaboration` | prototypeTaskId、operationId、原因 | 先核对未决集成结果，再释放有效授权，保留未接受代码、缓冲及会话定位。 |

工程引用是 Host 发放的项目认可版本或 prototypeTaskId，不是客户端传入的 filesystem path。
统一结果包含 operationId、当前 revision、业务状态及可恢复错误；路径与原始日志进入诊断字段。
错误码区分权限失效、文件冲突、工程变化、检查失败、确认过期、远端头变化和结果未知。
重复 operationId 绑定同一规范化请求，不允许改正文、路径范围或候选后复用原键。

| 投影／事件 | 最小内容 | 消费规则 |
| --- | --- | --- |
| `prototypeStateChanged` | projectId、revision、认可头、当前基线、事项摘要 | 按 revision 更新，丢弃旧投影。 |
| `prototypeFileChanged` | prototypeTaskId、path、hash、来源 | 标记编辑冲突和检查过期，不覆盖未保存缓冲。 |
| `prototypeContextRead` | sessionId、资料标识、状态、hash、实际读取范围 | 仅实际读取成功后产生；不得把选中视为已读。 |
| `prototypeOperationChanged` | operationId、阶段、结果、诊断引用 | 重连先查询完整投影，再接续事件。 |
| `prototypePreviewChanged` | previewId、工程指纹、运行状态、受管 URL | 只更新匹配实例，不用旧 URL 覆盖当前选择。 |
| `prototypeQueueChanged` | 本机账号队列 revision、稳定事项引用及顺序、currentSelectedTask、本地调度状态、nextAction | 完整投影覆盖旧 revision；项目过滤不改变跨项目运行上限。 |

事件由 Host 持久状态投影产生，不作为客户端自行推断 accepted 或权限的依据。
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

### 4.3 当前源码可复用能力与未实现边界

以下行号来自当前源码核对，仅证明相应局部机制；本节目标队列、退出协议及桌面崩溃恢复尚未实现或验收。

| 当前证据 | 可复用事实与限制 |
| --- | --- |
| [state.ts](../../../packages/studio-plugin/src/host/application/state.ts)（54–58 行）、[账号目录与保存](../../../packages/studio-plugin/src/host/application/state.ts)（102–160 行） | 已保存 tasks／operations 等，按账号隔离并串行 temp／rename；尚无上述业务 taskQueue。 |
| [TaskView](../../../packages/studio-plugin/src/shared/studio.ts)（46 行） | 已有 sessionId、worktree、inputHash 等身份；现有单需求约束仍须按本设计替换。 |
| [BackgroundLane](../../../packages/studio-plugin/src/host/application/background-lane.ts)（16–47 行） | Promise／Map／Set 提供进程内串行与去重，不是持久业务队列；复用执行器，不将其当恢复权威。 |
| [恢复入口](../../../packages/studio-plugin/src/host/application/studio.ts)（556–580 行）、[客户端恢复](../../../packages/studio-plugin/src/client/components/NativeConversation.tsx)（19–24 行） | 已先做 Host 身份核对再 retain；当前旧输入版本／hash 门禁不能原样沿用为新原型重绑要求。 |
| [原生会话适配](../../../packages/studio-plugin/src/host/adapters/dsh/sessions.ts)（69–77 行）、[resume 与事件重放](../../../packages/studio-plugin/src/host/adapters/dsh/sessions.ts)（137–175 行） | 可恢复原 session 与投影；仍需真实消息操作标识、确认位置及未知投递核对。 |
| [退出等待](../../../packages/studio-plugin/src/host/application/studio.ts)（114–124 行）、[会话释放](../../../packages/studio-plugin/src/host/adapters/dsh/sessions.ts)（217 行） | 已有等待后台工作和释放 handle；不足以证明完整关闭保存／flush 协议。 |
| [材料输入关闭处理](../../../packages/studio-plugin/src/client/scenarios/useDraftBuffer.ts)（13–17 行） | 当前 beforeunload 只尝试 flush；不是代码 buffer 或强杀无损恢复的证据。 |
| [固定操作记录](../../../packages/studio-plugin/src/host/application/git-integrations.ts)（30–53 行）、[远端结果核对](../../../packages/studio-plugin/src/host/application/git-integrations.ts)（139–150 行） | 已有先落盘、原幂等操作查询与条件推送模式，原型仍须接入完整恢复流程。 |
| [接受后收尾](../../../packages/studio-plugin/src/host/application/task-maintenance.ts)（25–27 行）、[逐步保存](../../../packages/studio-plugin/src/host/application/task-maintenance.ts)（48–64 行） | 可复用独立收尾记录，不能用模型结束替代 accepted。 |

方案沿用持久状态机、原生会话日志及 Git worktree 的成熟分工，不把模型输出历史当业务队列。
上游缓存中原生 conversation 按 session 保存 localStorage 草稿，原生持久化以 flush 为耐久屏障，崩溃开放轮次以 interrupted 收尾；这些源码能力仍须在当前装配版本验证，不承诺最后事件完整或原请求自动续跑。

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

本地验证按具体需求用例运行，记录操作、预期和实际、截图、console/pageerror、允许／拒绝网络记录及 trace。内存 requestMock 的调用不产生真实 HTTP，不能伪造为 HAR 请求。新浏览器须另装默认拒绝的网络围栏，不能假定继承 Electron session 的保护。完整流程、分发成本和最小 POC 见[选型与浏览器验证](technology-and-browser-validation.md)。

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
后台 accepted 才更新原型基线并结束事项；各需求完成状态保持独立，不能由集成代码推断。
accepted 后本机主检出同步、会话释放、预览处理和现场收尾分别记录结果，失败独立重试。
未接受、取消或授权失效事项不自动删除；唯一草稿、未合入代码与会话定位必须保留。
已接受现场清理前确认无新草稿和未合入提交；必要的唯一成果归档校验后才清理，不复制可重建依赖。

## 9. 模块职责与替换点

| 模块 | 保留与目标调整 |
| --- | --- |
| `client/studio` 与独立原型组件 | 替换单需求原型 actionBar；项目成果、我的事项、文件缓冲与运行输出分组件。 |
| `shared` | 定义工程引用、事项投影、文件 hash 并发、检查／预览／集成状态，不复用材料确认输入。 |
| `application/studio.ts` | 仅命令分派与应用组合；移除 `prototypeTask` 的单 entity 输入与自动启动逻辑。 |
| 独立原型事项 application 模块 | 负责事项 token、worktree、会话接续与取消；复用现有账号 scope 和后台 lane。 |
| `adapters/dsh/sessions.ts` | 保留官方 preset/model/session 恢复；增加事项上下文读取和消息操作核对。 |
| `adapters/platform/execution-guard.ts` | 保留真实 Agent 身份绑定及路径校验，接入事项授权交集与文件并发控制。 |
| 原型浏览器适配与受限服务 | 复用固定 DSH SessionResources／stdio MCP／附件生命周期；内核独立锁定稳定 Playwright，按事项及预览代次限制动作和目标，不放行全部 MCP 工具。 |
| `prototype/template.ts`、`generation.ts` | 保留模板保护校验，改为事项身份／代码提交绑定，不再要求单 requirementId。 |
| `prototype/checks.ts`、`preview.ts` | 保留校验算法，拆出持久证据仓库和实例管理，避免全局缓存／端口。 |
| `composition.ts` | 仅装配依赖；移出检查缓存、预览实例及运行操作编排，不扩展成统一大类。 |
| `fixed-candidates.ts` | 材料候选继续服务材料；原型候选由独立模块按事项范围固定。 |
| `git-integrations.ts` 与合并模块 | 复用幂等查询、条件推送和 accepted 恢复，明确原型合并重检与重新确认分支。 |
| `task-maintenance.ts` | 复用接受后独立收尾，不能提前删除未接受事项或唯一成果。 |

现有 `PrototypeStartup`、单需求 `inputHash` 门禁及旧 claim/check 隐式创建任务路径直接替换，不留兼容入口。
协议、持久状态与界面同步切换；旧开发数据按唯一成果保护规则处理，不添加 migration 或 fallback。

## 10. 后续实现验证边界

先覆盖事项多轮接续、跨需求草稿读取说明、文件并发保存、保护区拒绝、检查证据失效与实例隔离。
再覆盖干净合并重检、冲突重新确认、推送后响应丢失、token 撤销、重启恢复和 accepted 后收尾失败。
最终按当前交付版本完成真实桌面 → 原生真实模型 → Host → 指定协同服务 → Git／持久化闭环。
协同联调固定现有配置指向的 `100.119.183.44` 服务；本设计不授权远端修改或产品运行。
局部检查、模板构建与静态页面均单独报告；未完成真实桌面闭环的部分明确记为未验收。
