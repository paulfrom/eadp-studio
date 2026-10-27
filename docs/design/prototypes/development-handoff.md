# 需求协同到原型展示：设计审核与执行交接

日期：2026-10-27。审核对象为当前工作区，源码 HEAD 为 `476c1391ca5f53ee0d8b03de3e64e5df039e77eb`；包含尚未提交的原型设计成果，不能仅凭 HEAD 重现本次全部设计输入。

> **当前接手入口：先读[第 11 节](#11-开发进展与下一步接续2026-10-27)及[工程问题清单](implementation-issues.md)。** 第 1—10 节保留此前设计审核和当时的状态；其中“从 PT01 开始”、工作包均待开发及旧检查结果不是当前工作区状态。当前源码和设计均有未提交改动，整体实现尚未完成。用户最新要求是先完成整体结构设计和开发：本轮不构建、不测试、不执行验证，不设置研发门禁或阻断项；工程逻辑问题集中记录在问题清单。既定业务权限和现场保护职责仍由实现承担，不用新增确认流程替代业务判断。

**执行方向：按现有设计直接进入 PT 工作包开发。** 核心差距是项目级原型设计与单需求产品实现不一致；内嵌预览、固定宿主恢复能力及后台合并验证随对应工作包实现并验证。用户要求不设独立 POC 阶段，局部检查不代替真实桌面验收。

本次完成设计／源码静态审核、执行规划及交接；没有修改产品源码、数据库、依赖或远端服务，没有提交／推送，没有启动产品或真实模型。真实桌面闭环仍为**未验收**。原审核没有实施产品功能；本次按用户要求调整开发顺序，不代表授权修改远端或发布。

## 1. 接手入口与依据顺序

接手者先读本文，再按工作包读取必要文件，不必重放全部聊天。

| 入口 | 责任及使用方式 |
| --- | --- |
| [AGENTS.md](../../../AGENTS.md) | 开发、分工、状态保护和真实桌面验收规则。 |
| [领域语言](../../../CONTEXT.md) | 需求、原型、事项、开发占用、队列、确认和基线的语义。 |
| [需求协同](../02-requirements.md) | 材料独立确认、审阅写入、固定场景来源及进入原型边界。 |
| [原型工作台](../03-prototypes.md)、[交互稿](../../dseign/原型交互工作台.html) | 用户操作、深色 AI 风格、预览／代码组织；交互稿仅有模拟能力。 |
| [ADR-0008](../../adr/0008-project-prototype-parallel-collaboration.md) | 已记录业务决定及架构方向；不代表详细方案已整体确认。 |
| [技术设计](technical-design.md) | 总体架构、PT01—PT08、PA01—PA43。 |
| [协同契约](collaboration-contract.md) | 新事项／claim／接受模型、事务、SQL 替换及未知结果恢复。 |
| [桌面运行时](desktop-runtime.md) | 原生会话、持久队列、文件、检查、预览及关闭恢复。 |
| [技术选型与浏览器验证](technology-and-browser-validation.md) | CodeMirror、稳定 Playwright／Chromium、分发成本及实现验证。 |
| [里程碑](../../milestones.md) | 阶段及下游关联入口；旧指标措辞见 R07，不能直接照搬为完成语义。 |

事实优先级：用户已明确决定 → 当前设计及领域定义 → 当前源码／可重跑结果。源码与设计不一致时记录实施差距，不以旧实现覆盖新决定；仍待确认的技术方案不冒充已确认业务规则。

本次工具清单未暴露 codebase-memory-mcp，因此代码发现按仓库规则回退 `rg` 和源码读取；后续工具可用时恢复图工具优先。历史记录仅帮助定位，本文关键实现判断已回到当前文件核对。

## 2. 已确定的产品边界

1. 一个项目原型组织多项需求的页面和 Mock，需求目录、当前事项开发范围及基线历史关联分别表达；均不自动证明实现覆盖。
2. 多人按协作事项独立 worktree／分支并行；同需求的开发权由后台互斥，一个事项可以开发多项需求并动态扩领。参考阅读不占用开发权。
3. 需求确认成功只提供进入原型和准备指令；用户实际发送实现指令才开始开发。纯查看、讨论、检查、预览不能隐式创建可写任务或请求模型实现。
4. 允许本人有权读取的需求草稿探索；明确实际读取内容和状态。材料更新只提醒影响，不重绑工程、不自动改代码、不要求重新确认材料才能探索。
5. 需求依赖只提示原型实现顺序；关系的同项目、无重复、自引用和环检查保留，原型不再要求前置需求已有完成证据。
6. 明确实现指令授权 Host 范围内代码写入；需求 Markdown 仍走审阅写入。代码写入、作者确认、后台接受和发布是不同动作。
7. 本人本机账号跨项目默认一次运行一个 AI 实现事项，手动继续／切换。排队、暂停、退出不释放开发占用，模型结束不自动开始下一项。
8. 作者确认整体原型成果，后台接受后形成独立原型基线；不把相关需求批量置为完成。正式基线固定成果代码，不固定下一轮的需求输入包。
9. 干净合并已接受成果后重检，继续原确认；冲突修复产生新成果，必须重新给用户确认。未知结果先查询原操作，accepted 后收尾独立重试。
10. 继续使用固定 DSH、原生模型、Host、现有协同服务、Git 及随包 Umi 模板。原型是页面和合成数据演示，不等同于真实业务后端或生产系统。

以上来自当前设计对既有决定的记录；本次审核没有新增业务门禁，也没有批准尚待整体确认的技术提案。

## 3. 审核发现与处理要求

这里的 P1 表示实施中须解决的重大差距；P2 表示需补齐的契约、展示或交接项。实现差距与设计缺口分别标注，不把尚未实测的风险当作已复现故障。

| 编号 | 等级／性质 | 当前证据与影响 | 必须交付的处理结果 |
| --- | --- | --- | --- |
| R01 | P1，实现差距 | [studio.ts](../../../packages/studio-plugin/src/host/application/studio.ts) 684、693—707、753—757、808—817 行仍按单个已确认需求认领，并在接受后自动打开会话、发送实现提示；574—579 行恢复仍校验材料版本及前置完成。与需求协同“用户发送才实现、草稿探索”冲突。 | 替换为事项身份与明确指令启动；打开／检查／预览只读；删除自动发送、单需求 inputHash 及前置完成门禁。验 PA01、PA02、PA05、PA36—PA43。 |
| R02 | P1，实现差距 | [integration.ts](../../../apps/collaboration-api/src/modules/integration.ts) 68—74、103—110 行及 [schema.sql](../../../apps/collaboration-api/db/schema.sql) 837—850 行仍将接受及基线绑定单需求／材料版本，并更新 completedVersion。UI 无法单独修正这个模型。 | contracts、领域、SQL、仓储、API 及投影同次替换；原型 acceptance／baseline 独立；任务、完整 claims、认可头及幂等结果原子接受。验 PA12—PA23、PA28—PA32。 |
| R03 | P1，设计缺口＋现有阻断 | [03-prototypes.md](../03-prototypes.md) §2.3 要求内嵌预览；[preview.mjs](../../../packages/studio-plugin/assets/prototype-template/scripts/preview.mjs) 14—17 行明确 `frame-ancestors 'none'`。当前 [topbar/items.tsx](../../../packages/studio-plugin/src/client/topbar/items.tsx) 57 行及 [StudioTopbar.tsx](../../../packages/studio-plugin/src/client/components/StudioTopbar.tsx) 49 行仅提供外开链接。设计尚未选定真实内嵌载体。 | 按内嵌承载设计实现并在固定宿主验证；明确原型页面与工作台／Node／preload／IPC 的隔离、几何布局、销毁恢复、导航及弹窗策略。不得直接移植模拟 iframe 或全局放宽 CSP。 |
| R04 | P1，关键技术待验证 | [collaboration-contract.md](collaboration-contract.md) §6.1 拟新增 Linux Git 验证器，仅重建原型子树合成提交；目前没有 Host／服务端同策略树一致性结果，Dockerfile 也未声明 Git。 | 在 PT02 实现中用固定版本对照验证共同祖先、重命名、删除、冲突、材料头推进和恶意候选；记录真实 SHA 与合成 SHA 区别、资源上限及失败拒绝行为。不能仅凭 Host 声明 clean 放行。 |
| R05 | P1，实现差距＋宿主能力待验证 | [desktop-runtime.md](desktop-runtime.md) §4.1—4.3 已定义持久队列／关闭协议，但当前仅有 tasks／operations、进程内 BackgroundLane 和会话 resume；没有完整队列、可靠消息操作核对及退出保存协议的本轮运行证据。 | 在 PT03 实现账号跨项目串行入口、逐步持久化、正常关闭及崩溃恢复，并核对固定宿主的 message ID／ack／事件位置、取消 settled、flush 与 resume。不能只在页面禁用按钮。 |
| R06 | P1，下游连带差距 | [studio.ts](../../../packages/studio-plugin/src/host/application/studio.ts) 895—918 行生成交接仍读取 baseline.entityId／version；[integration.ts](../../../apps/collaboration-api/src/modules/integration.ts) 58—60 行仍要求交接引用 completed requirement；[reuse.ts](../../../apps/collaboration-api/src/modules/reuse.ts) 26、37—39 行仍依赖 prototypeBaselineId／prototype confirmation。 | 基线模型切换时同步交接、原型包复用及发布消费者；显式使用 baselineId／准确 commitSha。材料复用仍用材料固定版本。不能先删除 completion，再把消费者留到最终联调补救。 |
| R07 | P2，指标语义歧义 | [milestones.md](../../milestones.md) 110 行将“原型验证（验收完）”映射到原型确认；新设计明确作者接受不证明逐需求业务验证。199—207 行的“需求覆盖率”又有自己的场景关联口径。 | 区分作者确认、后台接受、工程检查、实际业务用例结果和关联统计。已有场景关联占比不能改称需求实现覆盖率；无可靠取数显示未统计，不能从基线关联集合生成验收绿灯。 |
| R08 | P1，运行时契约待展开 | 领取／扩领、write-scope 更新和模型发送是分步操作；[collaboration-contract.md](collaboration-contract.md) §5—§7 定义各步幂等，但需要明确一次用户指令跨步骤失败后的本地恢复位置。 | 用既有 operation 记录串联真实用户动作、任务创建／扩领、scope、现场创建、消息发送；每步先落盘并传递新 token。两项授权均核对完成才派发；扩领成功而 scope 失败时保留已领取事实，只补未完步骤，不偷偷缩减 claims／换 key／重发模型。 |
| R09 | P2，边界未闭合 | [technical-design.md](technical-design.md) PA23 规定无代码变化不新建基线，但活动任务 claims 又只增不减，接受才结束任务。无变化确认后任务是否仍活动没有独立说明。 | 推荐明确为：查看已有基线保留 active 及占用，界面说明仍在开发；用户选择结束事项时沿 cancel 路径释放全部 claims、保留现场。不得把打开基线当 accepted 或暗中释放占用。此为设计中的具体技术方案，并非新增已确认的业务决定，不新增状态或伪基线。 |
| R10 | P2，设计稿及测试覆盖差距 | [03-prototypes.md](../03-prototypes.md) §3 明确交互稿尚未补齐事项选择与并发冲突；现有 23 项 DOM 检查覆盖三需求演示，不覆盖服务端开发互斥、队列或真实预览。 | 设计稿补事项／队列、占用冲突、扩领失败、源版本与现场标识；对应替换旧固定需求测试。模拟测试与产品验收分别记录。 |
| R11 | P2，队列入队契约待展开 | [desktop-runtime.md](desktop-runtime.md) §3 的 start 建立任务／现场／会话，§4.1 又要求当前事项运行时可保留其他待开始事项；尚未明确首次实现指令如何入队及何时派发。 | 推荐：本人当前无运行事项时，首次明确发送即领取、建现场并派发，无第二次继续按钮；已有运行事项时，创建成功的另一事项入队，首次指令持久保存但暂不派发，用户手动切换／继续时才执行。两种路径共用原 messageOperationId；不因当前轮结束或重启自动派发。此为设计中的具体技术方案，并非新增已确认的业务决定。 |
| R12 | P2，文件读取契约待展开 | [desktop-runtime.md](desktop-runtime.md) §2、§6 要求文件树、搜索与真实 diff，但 §3 命令表目前只展开单文件读／写。 | 在同一受控文件服务补目录投影、搜索和 diff 查询；限制相对路径、结果数量、文件大小、二进制及凭据过滤，返回明确工程／版本标识。不能由客户端遍历任意磁盘补齐。 |

补充静态风险：[repository.ts](../../../apps/collaboration-api/src/persistence/repository.ts) 156 行向 `studio_occupation_inputs` 插入数据未提供 `project_id`，而 schema 775 行为 NOT NULL。尚未做数据库复现，不能称为已复现故障；该表已列入直接删除范围，不为旧原型前置模型补兼容层。

已复核并收窄的两点：里程碑末尾“严格串行”指研发阶段顺序，不能据此否定已允许的草稿探索；场景关联占比可以独立存在，问题是命名及取数边界，不应一概删除统计能力。

## 4. 成熟模式核对与开发验证

2026-10-27 重新查阅官方资料，而非只沿用旧方案中的产品描述：

| 模式 | 官方证据 | 本项目采用边界 |
| --- | --- | --- |
| 对话旁查看代码和预览 | [Bolt Code view](https://support.bolt.new/building/code-view)、[Preview controls](https://support.bolt.new/building/preview-controls) | 借鉴查看／编辑和预览布局，保留既有 AI 风格；不推导 Bolt 已替本项目解决多人 claim、Git 接受或桌面隔离。 |
| 合并后审阅和验证 | [VS Code merge conflicts](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts) | 冲突解决后仍检查结果；成熟编辑器负责差异呈现，Git 负责真实合并，业务确认仍由用户完成。 |
| 自动化和浏览器成对锁定 | [Playwright Browsers](https://playwright.dev/docs/browsers)、[Trace viewer](https://playwright.dev/docs/trace-viewer) | 使用稳定工具的定位／断言／trace，随包配对浏览器；不能从 Chromium 验证推定 Electron 桌面闭环通过。 |

本次只读 npm registry 核实 `playwright@1.61.1`、`@codemirror/view@6.43.15`、`@codemirror/merge@6.12.3` 可取得对应元数据，许可证分别为 Apache-2.0、MIT、MIT；Playwright 声明 Node >=18。入口见[Playwright 元数据](https://registry.npmjs.org/playwright/1.61.1)、[view 元数据](https://registry.npmjs.org/@codemirror/view/6.43.15)、[merge 元数据](https://registry.npmjs.org/@codemirror/merge/6.12.3)。这只证明版本元数据存在，没有安装，也没有验证浏览器 archive、配对 revision 或运行兼容性；后续仍须按锁文件与官方 browsers.json 核对。

按用户要求，不设置独立技术验证阶段。下列工作随对应开发包实现并验证，样本和记录方式见[开发验证样本](implementation-validation.md)：

| 工作包 | 开发中的验证 |
| --- | --- |
| PT02 | 固定 Windows／Linux Git 的合并策略、候选父关系与子树结果，覆盖重命名、冲突、材料头推进和拒绝样本。 |
| PT03 | 核对原生会话发送、取消、关闭和恢复，以及 message ID／ack／flush 的实际能力；不能证明结果时保留 unknown。 |
| PT04 | 核对编辑、中文输入、文件并发、冲突保护和现场恢复。 |
| PT05 | 验证固定宿主内嵌隔离、布局、焦点、导航及实例销毁恢复。 |
| PT05B | 验证配对浏览器、业务用例、网络围栏和附件；候选发行包阶段验证干净机离线安装。 |

以上均尚未执行。发现固定路线无法满足目标时记录证据并回到设计处理；不伪造结果、不静默升级宿主、不信任 Host 的单方合并声明。开发和验证不得擅自修改指定协同服务或真实数据，真实桌面验收仍按第 7 节执行。

## 5. 执行工作包与交付顺序

沿用现有 PT 编号，按设计从 PT01 开始开发；各工作包同时完成相关检查。工作包局部检查完成不等于阶段验收通过，不做临时单需求新旧双轨、migration 或 fallback。

| 工作包 | 责任／文件所有权 | 输入依赖 | 必须形成的具体成果及退出条件 |
| --- | --- | --- | --- |
| PT01 协同领域及存储 | 执行代理 A；`packages/contracts/`、`packages/asset-domain/`、`apps/collaboration-api/src/`、`apps/collaboration-api/db/` | 已有设计；冻结身份及事务规则 | 新 prototype/task/claim/acceptance/baseline；项目初始化创建唯一 prototype；部分唯一索引、多需求全领或回滚、完整 fencing、三种 integration 分支、幂等／审计／投影；同步规范 schema、schema-model 和受影响 ERD／说明。旧字段在对应消费者切换时删除。 |
| PT02 后台候选验证 | 执行代理 A；Git 内容适配器、独立验证模块、Dockerfile／运行锁及许可清单 | PT01 | 固定 Linux Git，验证真实父关系及子树计算；事务外受限进程，超时／缺对象／冲突拒绝；临时对象清理及负向样本可重跑。禁止借此授权部署远端。 |
| PT03 事项与原生队列 | 执行代理 B；Host application、state、DSH adapters、shared 的事项投影 | PT01 契约冻结 | 持久事项、跨项目单实现调度、只读材料访问与实际读取证据、scope/claims、先落盘再副作用；首次发送、扩领、多轮、暂停、退出、恢复、撤销和未知消息可核对。移除旧自动实现。 |
| PT04 文件与编辑 | 执行代理 B；独立原型文件服务、shared 文件契约、client 原型代码组件 | PT03 | 真实文件树／正文／diff；统一 Agent 与人工保存路径、hash 并发及原子保存；保护区拒绝、持久缓冲、未保存选择及冲突恢复。CodeMirror 使用既定版本路线。 |
| PT05 工程证据与预览 | 执行代理 B；`host/prototype/`、composition、维护的桌面 build 适配 | PT03 | 拆出持久检查证据及按工程实例管理；只读认可快照与本人事项分别运行；受管端口、instance、构建／工具指纹；内嵌及外开同构建，失败与旧预览状态真实。 |
| PT05B 浏览器正式接入 | 执行代理 B；受限 provider、附件与证据、runtime lock／发行装配 | PT04、PT05 | Playwright／Chromium 精确配套；run/session/build/origin 绑定、负向围栏、步骤断言和可读 trace；保留 Electron 技术保护检查。候选安装包阶段完成发行验证。 |
| PT06 确认集成及下游 | A 负责 API 接受／复用契约；B 负责 Host 候选／集成／交接／发布适配；主 Agent 整合 | PT02、PT04、PT05 | source 归一、上传、prepare、CAS、complete、干净合并重检／冲突新确认；unknown、abort/release 竞争、accepted 后收尾。同步改 generateHandoff、原型包复用、发布源及基线读取，准确区分 recognizedHead 与 baseline.commitSha。 |
| PT07 工作台贯通 | 执行代理 B；client 独立原型组件、需求进入原型动作、shared 事件消费 | PT03—PT06、PT05B | 项目原型／我的事项与队列、需求集合、预览／代码／输出和整体确认；原生输入真实发送受控；切需求不切现场，切事项才切现场。重连读完整投影，不从事件猜 accepted。 |
| PT08 删除核对及真实交付 | 主 Agent 验收；A/B 在各自所有权内修正 | PT01—PT07、PT05B | 清除旧协议及测试残留，完成 PA01—PA43 和补充用例；指定服务双客户端、真实模型、真实桌面、安装包与失败恢复证据齐全后再判断验收。任何未执行项保持未验收。 |

执行期间最多两个 Sol 执行代理。A/B 是职责槽位，不能理解为所有工作包同时启动；同一文件只有一名所有者。shared 契约由主 Agent 指定单一所有者发布，消费者按冻结版本实现，不互相覆盖。PT06 交叉文件在开工时逐文件划定；任何代理都不得回滚现有未提交成果。

上表保留原先的依赖关系，供定位接口和文件所有权；不把工作包顺序、验证或发行阶段设置为本轮开发门禁。当前代码进度和实际下一步以第 11 节为准。

## 6. 替换与状态保护清单

实施不是把旧 task 增加一个数组字段。每个工作包同时更新契约、领域校验、持久状态、投影、调用者和测试，不能交付半套新身份。

| 直接替换／删除 | 必须保留的职责 |
| --- | --- |
| 单需求 PrototypeStartup、prototypeTask(entity)、固定 inputHash／材料版本／前置完成准入 | 事项真实身份、独立现场、有效开发 claims、受管规则加载及保护文件校验。 |
| 旧 prototype purpose 的材料 occupation、studio_occupation_inputs 及前置生产完成投影 | 材料 design occupation；需求固定场景来源及关系 DAG 约束。 |
| completedVersion／completions／completionConfirmationId／completedIntegrationSha／FixedVersion.prototypeBaselineId | 材料独立固定版本；原型独立 acceptance／baseline；材料与原型状态分别展示。 |
| 全局 preview、固定 4173、仅内存 checkResults 以及伪 relations 通过证据 | 工程指纹与真实检查结果、按工程实例的受管进程／端口、有效产物和准确来源。 |
| 需求接受后自动生成实现消息；check／preview 隐式可写任务与会话 | 进入原型入口、可编辑指令草稿、用户发送授权、只读认可成果检查与运行。 |
| 交接／复用／发布通过单需求 completion 反查基线 | 显式 baselineId／commitSha；纯材料复用继续遵循材料资格与固定来源。 |

本次开始时已存在：`CONTEXT.md`、`docs/design/02-requirements.md`、`docs/milestones.md` 的修改，以及未跟踪 ADR-0008、03-prototypes、prototypes 子文档和工作台 HTML/CSS/JS。它们是当前设计输入，本次不清理、不回滚。

后续 schema／状态切换前先识别实际账号现场、活动任务、未提交代码和草稿，形成最小保护清单；Git 或锁定依赖可重建部分不惯例备份。确有唯一成果才保留原件及 hash／恢复用途；不将保护原件实现成旧协议自动迁移、兼容读取或 fallback。旧开发数据如何处置必须有具体对象和授权，不能直接对现有协同库执行重建。

## 7. 验证计划和真实桌面验收

### 7.1 现有可重用入口

以下是后续实现验证入口，不表示本次全部执行。测试路径／脚本必须先核对当前文件；已删除旧语义的测试同步改写，不能拿旧断言绿灯证明新行为。

```powershell
# 仓库与契约局部检查
node scripts/check-repository.mjs
pnpm --filter @eadp/contracts typecheck
pnpm --filter @eadp/asset-domain typecheck
pnpm --filter @eadp/collaboration-api typecheck

# Studio 先装配，再在装配树使用真实 tsconfig，不能从维护源码猜路径
node apps/desktop-distribution/build/prepare-studio-plugin.mjs --dev-stage
# cwd=.local/build/dsh；依赖和 lib 已准备后执行
node node_modules/typescript/bin/tsc -b packages/eadp/studio-plugin/tsconfig.host.json packages/eadp/studio-plugin/tsconfig.client.json

# 真实桌面入口；连接地址从桌面实际设置读取
pnpm dev:desktop
```

后端／Host 入口包括 [integration.test.ts](../../../apps/collaboration-api/src/modules/integration.test.ts)、[gitlab-content.test.ts](../../../apps/collaboration-api/src/gitlab-content.test.ts)、[studio-workflow.test.ts](../../../tests/collaboration/studio-workflow.test.ts)、[asset-workflow.test.ts](../../../tests/windows-desktop/asset-workflow.test.ts)，客户端入口为 `tests/scenario-client/`，按实际变更选择有意义的用例。新增原型任务／队列／编辑／预览／接受用例应使用可发现的专属测试文件，不把所有行为塞进现有大套件。

模板更改在独立 `packages/studio-plugin/assets/prototype-template/` 验证冻结安装、typecheck、lint、build、Mock 与保护检查，并更新模板 manifest 哈希。浏览器接入同时验证 Electron 保护、Chromium 业务流程、实际 Electron 交互，三类结果分别记录。

数据库测试不得对指定服务的真实库执行初始化／清库；若专用隔离测试通道不可用，记录相应并发／约束检查未验收，不要求本机 PG、不另建替代服务，也不从夹具推定真实事务已通过。

### 7.2 端到端样本与场景

复用[技术设计 PA01—PA43](technical-design.md#9-验证矩阵)，不另抄一套可能漂移的编号。样本至少准备同项目两名成员、两个客户端、三项独立需求及一个共享组件；草稿与已确认材料均有样本，原型可演示跨页面流程。

| 闭环组 | 必须观察的事实 | 对应原矩阵 |
| --- | --- | --- |
| 需求到实现 | 材料接受后没有模型请求／新可写任务；进入只准备指令；明确发送后才领取开发权并写代码，纯查看与草稿探索分别可用。 | PA01—PA07 |
| 工程到展示 | 多需求同一应用、实际文件／diff、人工与模型保存冲突、保护区拒绝；当前源码对应当前检查／构建／预览。 | PA08—PA11、PA33—PA35 |
| 并发到基线 | 两客户端抢同需求只一个成功，多需求全领或回滚；不同需求共享文件的干净合并／冲突重确认；接受不批量改需求完成。 | PA12—PA16、PA20、PA28—PA32 |
| 失败到恢复 | 推送／complete／领取答复丢失先核对；撤销和接受竞争；重启恢复原现场、队列、缓冲；已接受只补收尾。 | PA17—PA19、PA22、PA24—PA27、PA36—PA43 |
| 基线到消费 | 后续材料推进 recognizedHead，基线代码仍准确；交接／复用／发布读取该 baseline，不偷换最新目录。 | PA21、PA23，加本文补充用例 |

必须补充原矩阵未明确覆盖的用例：

- 内嵌真实静态产物成功；原型脚本尝试 Host bridge、外站、其他端口、弹窗和越界导航失败，外开仍指向同一构建。
- 扩领成功后让 scope 更新失败、创建现场失败或消息发送未知，重开只补未完成步骤；有效 claims 不丢、不偷偷缩减，也不再发一次实现消息。
- 无代码变化时确认不新建基线，事项与 claims 按最终确认的无变化策略处理，不遗留误导的“已接受”。
- 原型接受后，交接生成重复请求／网络失败仍绑定同 baseline；原型包复用成功判断走新 acceptance，材料采用不受影响。
- 单凭作者确认／需求关联不能让卡片显示逐需求业务验收通过；未测、失败、证据丢失与过期均如实展示。
- 当前事项运行时建立待开始事项，首次指令及队列顺序持久保存，重开不自动派发；目录／搜索／diff 返回同一受管工程且不会越界。
- 真实桌面检查键盘焦点、中文输入、窄窗折叠、内嵌画布与代码区切换；模拟 DOM 可见不代表实际布局及可访问性已通过。

真实联调固定使用桌面现有配置指向的 `100.119.183.44` 服务；协议／端口从运行设置或现有配置核实。本次未连接该服务，后端版本未知；不能用更新策略服务地址代替协同 API 实际地址，也不能因本文规划而修改远端服务或真实数据。

### 7.3 记录模板与完成判据

每次验收记录包含：日期、源码标识及工作区差异、安装包／ASAR 或桌面版本、固定 DSH commit、后端版本（未知写未知）、账号／客户端／项目样本、操作步骤、期望／实际、operation/task/claim/source/candidate/baseline 标识、截图／日志／trace 及未验证项。日志与附件只记录必要诊断，不保存凭据。

只有当前交付版本在真实桌面完成“UI → 原生会话及真实模型 → Host → 指定协同服务 → Git／持久化 → 桌面结果”，并覆盖相关失败及恢复，才可以判定本链路验收通过。局部测试、截图、Mock、工程构建和旧包分别报告。整个产品生产就绪仍要求场景 → 需求 → 原型 → 基线 → 交接完整链路，不由本文审核结论代替。

如进入桌面交付，另提供实际 installer 路径、字节数、SHA-256，以及安装、启动、业务闭环分别的结果；浏览器 runtime 已随包且不要求用户自行安装工具。

## 8. 本次已执行验证与保留缺口

| 检查 | 本次实际结果 | 能证明的范围 |
| --- | --- | --- |
| 当前设计与维护源码核对 | 两个只读审查分工，主 Agent 交叉核对关键结论 | 本文定位的实现差距与设计缺口；没有运行远端事务。 |
| `node --check docs/dseign/prototype-workbench.js` | 通过 | 设计稿 JS 语法。 |
| `node .local/verification/prototype-workbench/check.mjs` | `DOM checks: 23 passed. Layout, real browser and desktop workflow were not exercised.` | 离线模拟交互；不覆盖新增队列、claims、内嵌产品与真实业务闭环。 |
| `node .local/verification/prototype-workbench/static.mjs` | 通过，310 条 CSS 规则 | AI 主题／布局参数、集合语义、本地资源、CSS 顺序、模拟 iframe 边界及文档链接。 |
| 候选依赖版本元数据 | 三个指定 npm 版本只读查询成功 | 元数据存在及声明许可／engine；未安装、未做兼容或分发验证。 |
| 本交接本地链接、引用行及 diff 检查 | 已执行，结果见末尾记录 | 文档可定位、格式与引用准确性；不代表产品通过。 |
| PA01—PA43、开发验证样本、真实浏览器视觉、真实桌面／模型／协同／安装包 | 未执行，未验收 | 不得从前述局部结果推定通过。 |

既有 `.local/verification/prototype-workbench/` 脚本依赖本机装配树的 Happy DOM，不是新接手环境开箱即用的产品测试。后续将有效检查移入受维护测试入口，不能仅把忽略目录路径当作永久交付资产。本次不为文档审核修改测试基础设施。

## 9. 下一次执行与交接提示

原交接当时的下一步是从 PT01 开始。当前接手应从第 11 节的未完成衔接继续，不重做已有源码；工程问题统一写入[问题清单](implementation-issues.md)。不得恢复单需求固定依据／前置完成门禁，也不得自动发送实现指令；保留现有未提交成果。当前用户要求不执行构建或验证，不将后文历史检查记录作为当前交付的结果。

## 10. 设计接续记录（2026-10-27）

本轮接手起始 HEAD 为 `fb222e7d26ecf0b6b5e4f5661e521d0289701c73`，工作区干净；第 6 节所述此前未提交设计已包含在该提交中。上文保留原审核当时的事实，不用当时的状态描述本轮。

- R03 已形成以隔离 `WebContentsView` 为首选的待验证承载提案，记录布局、焦点、生命周期和负向样本；固定宿主实际能力仍未知，[固定宿主验证](technology-and-browser-validation.md#11-r03内嵌承载候选与证据边界) 未执行。
- R05／R08／R09／R11／R12 的恢复、无变化事项、首次指令入队及受控文件读取已展开到[桌面运行时](desktop-runtime.md)与[协同契约](collaboration-contract.md)，作为现有设计的技术方案；原生消息 ID、ack、settled、flush 和恢复能力不因文档展开而成立。
- R07 的作者确认、后台接受、工程检查、业务用例和场景关联统计已在[里程碑](../../milestones.md)区分；无法可靠取数时不伪造通过率。
- R10 已在[交互稿](../../dseign/原型交互工作台.html)补事项选择、队列、占用及扩领冲突和来源现场标识；均为内存模拟，刷新重置。[离线 DOM 检查](../../../tests/design-prototypes/workbench-demo.mjs)需显式提供已安装的 Happy DOM 路径，不代表真实浏览器或产品能力。
- [开发验证样本及记录](implementation-validation.md)列出对应工作包的操作、预期和证据边界；当前工作树 `git merge` 实现不是跨平台子树 `merge-tree` 一致性的运行证据。

本轮局部检查：设计稿和测试脚本的 `node --check` 通过；使用当前本机已装配的 Happy DOM 运行受维护检查，25 项离线 DOM 检查通过；8 份相关 Markdown 的 138 处本地引用及锚点检查通过；`git diff --check` 和 `node scripts/check-repository.mjs` 通过（49 个模板哈希匹配）。Happy DOM 是本次显式传入的本机依赖，不是随仓库保证可用的发行组件；这些结果不证明真实浏览器布局或桌面闭环。

本轮仍未执行开发验证样本或真实桌面／模型／协同服务闭环，未改产品源码、依赖、数据库或远端。按用户最新决定移除独立 POC 环节，从 PT01 开始按设计实施；各项验证和发行关口随对应开发及交付执行。

## 11. 开发进展与下一步接续（2026-10-27）

### 11.1 当前状态和工作边界

- 当前 HEAD 为 `fb222e7d26ecf0b6b5e4f5661e521d0289701c73`，**工作区不干净**。本轮设计输入和新增产品源码都在未提交工作树内，不能仅凭该提交重现。后端、contracts、asset-domain、Host、client、shared 和设计文档都有修改；新增原型模块、[工程问题清单](implementation-issues.md)、[开发验证样本](implementation-validation.md)及 `tests/design-prototypes/` 仍为未跟踪内容。`git diff --stat` 默认不含未跟踪文件，接手时应同时查看 `git status --short`。
- 第 6 节和第 10 节关于各自历史轮次的工作区状态仍是当时事实，不适用于当前交付。保留全部现有未提交文件，包括用户既有设计、交互稿和新代码；不要 reset、clean、覆盖或以旧提交替换。还未核实本机实际账号是否存在活动事项、队列、未提交 worktree 或唯一草稿；不得推断为空或擅自清理。
- 本轮用户明确要求**不构建、不测试、不验证，不设置研发门禁或阻断项**，先完成整体代码结构与开发。已有工程逻辑问题只集中维护在[问题清单](implementation-issues.md)，新发现按事实补充，不另建多份清单。第 7、8、10 节的命令和结果是过去审核或未来可能使用的入口，不代表本轮执行，也不作为继续开发的前置条件。
- 本轮源码实现没有执行 build、typecheck、测试、数据库操作、真实模型、桌面闭环或远端联调；未安装新的编辑器／浏览器依赖，未修改运行中的协同服务或真实数据。下表仅说明代码已写到什么位置，不证明可以编译、运行或正确处理并发。指定协同服务仍为 `100.119.183.44`，本轮未连接，当前后端运行版本未知。完整桌面闭环和生产就绪均**未验收**。

### 11.2 工作包实际落点

| 范围 | 当前源码已写入 | 尚未完成或不能推定的部分 |
| --- | --- | --- |
| PT01 领域和存储 | [contracts](../../../packages/contracts/src/index.ts)、[schema.sql](../../../apps/collaboration-api/db/schema.sql)、[事项模块](../../../apps/collaboration-api/src/modules/prototypes.ts)、[项目初始化](../../../apps/collaboration-api/src/projects.ts)及 [routes/service](../../../apps/collaboration-api/src/routes.ts)加入项目原型、事项、需求开发 claim、引用、revision／generation、原型基线及相关 API；SQL 定义活动 claim 部分唯一索引。旧单需求 prototype 的材料占用入口及 completion 投影已从相关源码路径移除。 | 事务、索引和权限均未运行核对；服务端目前仅规范 scope 路径并保存客户端提交的 `policyHash`，没有权威模板策略校验。prepared 期间事项更新及取消竞争还需衔接，见 I04、I15。不要为旧协议加兼容、migration 或 fallback。 |
| PT02 后台候选验证 | [service.ts](../../../apps/collaboration-api/src/service.ts)已有 refs、提交父关系、GitLab compare 和申报路径的检查逻辑。 | 未实现 Linux 固定 Git 的独立三方子树重算、镜像运行锁及其资源约束；现有 checks／compare 不能证明合并树正确或客户端工程证据真实，见 I04。没有运行跨平台 Git 样本。 |
| PT03 事项、队列与原生会话 | [prototype-collaboration.ts](../../../packages/studio-plugin/src/host/application/prototype-collaboration.ts)和[shared 契约](../../../packages/studio-plugin/src/shared/prototype.ts)写入首次指令、领取／建现场、排队、手动继续、后续指令、扩领、scope 更新及消息查询；[sessions.ts](../../../packages/studio-plugin/src/host/adapters/dsh/sessions.ts)尝试把操作 ID 带入原生消息来源，并读取文本日志。需求确认后的旧自动原型启动调度已移除。 | 目前从界面未提供开发需求 ID 时，Host 保存原指令后报“未识别实际开发需求”，还不会从自由指令推导需求；不能将可选勾选当作已实现的自动识别。队列重排／暂停、完整关闭 flush、取消 settled、可靠 ack 和恢复尚未接齐；`sent` 仅是当前代码中的发送步骤，不是已验证的耐久投递。见 I01、I05、I13。 |
| PT04 文件与编辑 | [文件服务](../../../packages/studio-plugin/src/host/prototype/files.ts)、[Git 适配器](../../../packages/studio-plugin/src/host/adapters/workspace/git.ts)及[代码区](../../../packages/studio-plugin/src/client/prototype/PrototypeFiles.tsx)写入受管目录、文字搜索、文件读写、起始提交到当前磁盘的差异、expectedHash 和编辑缓冲；文件保存操作与缓冲有本机记录。 | 当前编辑器是 textarea，未接入 CodeMirror、冲突合并视图或人工／AI 共用写锁；差异显示两侧文本，不包含未保存缓冲。分页观察标识、大文件／范围和链接竞争仍有缺口；已接受基线的只读工程现场未接入。具体见 I02、I03、I06、I11、I12。 |
| PT05 工程检查与预览 | [composition.ts](../../../packages/studio-plugin/src/host/composition.ts)、[checks.ts](../../../packages/studio-plugin/src/host/prototype/checks.ts)、[preview.ts](../../../packages/studio-plugin/src/host/prototype/preview.ts)和 Studio 命令已按事项登记检查／预览调用，并维护动态端口及进程映射。 | 当前 `startProjectPrototypePreview` 代码会先调用工程检查；检查结果与预览投影主要在进程内，详细步骤／日志未形成持久投影，只接本人事项；界面仅有外开链接。未实现隔离内嵌承载，也不能从该代码推定实例隔离或运行成功，见 I08。 |
| PT05B 浏览器与编辑器 | 仍保留既有 Electron 静态预览检查入口；技术路线见[选型文档](technology-and-browser-validation.md)。 | CodeMirror、受限 Playwright provider、配对 Chromium、附件／trace 和发行装配未接入；现有 Electron 静态检查不代表业务用例或桌面隔离已通过，见 I03、I09。 |
| PT06 集成和下游 | [原型集成模块](../../../apps/collaboration-api/src/modules/prototype-integration.ts)写入 prepare／complete／abort、acceptance 与新基线；[原型复用模块](../../../apps/collaboration-api/src/modules/prototype-reuse.ts)提供后端记录接口。交接草稿及发布源码开始使用基线 ID／准确提交；原材料 [git-integrations.ts](../../../packages/studio-plugin/src/host/application/git-integrations.ts)现仅处理材料集成。 | Host 尚无完整原型 source 归一、候选固定／上传、作者确认、条件推进、complete、干净合并重检及冲突重确认链路；后端复用记录不等于桌面复制／采用闭环。交接编辑和重试仍需贯穿固定来源。见 I04、I07、I10、I14、I15。 |
| PT07 工作台 | [PrototypeWorkbench](../../../packages/studio-plugin/src/client/prototype/PrototypeWorkbench.tsx)、[PrototypeFiles](../../../packages/studio-plugin/src/client/prototype/PrototypeFiles.tsx)和 [StudioPanel](../../../packages/studio-plugin/src/client/studio/StudioPanel.tsx)已改为项目原型、需求集合、本人事项、指令、文本会话、文件／差异和新基线列表；需求入口准备草稿，不自动发送。 | 原生对话完整投影／附件、整体原型确认、浏览器展示及其下游动作仍未贯通。界面不证明对应操作已在真实桌面运行。 |
| PT08 清理与交付 | 当前工作树有旧模型删除及新模块替换的部分改动。 | 尚未完成全仓旧消费者／测试清理、安装包和 PA01—PA43 真实桌面验收；不宣称研发阶段或生产就绪完成。 |

### 11.3 当前操作与状态恢复定位

1. **共享入口。** [shared/prototype.ts](../../../packages/studio-plugin/src/shared/prototype.ts)定义事项、队列、指令草稿、文本消息、文件／缓冲／diff 与检查预览命令；[studio.ts](../../../packages/studio-plugin/src/host/application/studio.ts)按命令分派。新的接口仍处开发中，以工作树中的实际类型为准，不能由旧 `entityId` 原型命令倒推新模型。
2. **本地记录。** [StudioStore](../../../packages/studio-plugin/src/host/application/state.ts)按账号使用 `users/<userId>` 目录；[composition.ts](../../../packages/studio-plugin/src/host/composition.ts)可配置状态根目录，默认从 `APPDATA` 或本机用户数据目录推导。[prototype-collaboration.ts](../../../packages/studio-plugin/src/host/application/prototype-collaboration.ts)在账号目录保存 `prototype-queue.json`，其中包含本机事项、指令、操作、草稿、文件缓冲及保存记录；worktree 在同一账号目录下按项目／事项登记。原生会话日志、用户工程和 Git 状态还在各自位置。**这些可能是唯一成果**，不应作为可重建缓存删除，也不向问题清单或日志复制正文／凭据。
3. **首次实现。** `startPrototypeCollaboration` 保留用户原指令与 operationId，取得服务端任务和 claims 后准备 worktree；另一事项运行或待恢复时，首次指令保留为待继续。无开发需求 ID 时目前不能完成领取，需继续实现需求识别，不增加固定材料版本、前置完成或额外确认。客户端传空 scope 时，Host 当前取模板可写范围；这不是服务端权威策略已校验的证据。
4. **继续和扩领。** 当前操作记录使用 `prepared`、`creating`、`claimed`、`scope`、`workspace`、`sending`、`sent`、`unknown` 等本地步骤；扩领先提交完整开发集合，再更新 scope，再发送。队列选择只改选中项；`resumePrototypeQueueItem` 尝试发送已保存的首次指令。原生消息查询找到 operationId 时只说明日志中有对应消息；缺失记录不证明未投递，取消请求也不证明在途工具已收敛。
5. **文件与预览。** 文件操作只接受本机事项 ID，由 Host 解析真实工程；读取／保存、缓冲和操作记录分开。已失效的事项现场在当前服务端身份可核对时按只读范围访问；这不是已接受基线快照。检查与预览命令目前要求已登记事项，预览状态保存在内存，不等于重启恢复或基线只读运行已完成。
6. **项目基线消费。** 服务端原型 baseline 与 `recognizedHead` 是不同事实。基线列表读取新 `PrototypeBaselineView`；交接草稿写入 `prototypeBaseline`，后台仅在收到该引用时核对 ID 与 SHA；发布源码从当前原型基线获取固定提交。当前尚没有从桌面作者确认到新 baseline 的完整路径，不要把已有 API 或按钮当作闭环。

### 11.4 下一位接手者的具体工作

以下是可并行衔接的开发事项，不是新的阶段门禁；接口变更时同步其调用者，问题保持在同一清单中。

1. **补齐候选与接受主链。** 从 [协同契约](collaboration-contract.md)第 5—7 节、[prototype-integration.ts](../../../apps/collaboration-api/src/modules/prototype-integration.ts)、[Git 适配器](../../../packages/studio-plugin/src/host/adapters/workspace/git.ts)和[原型事项编排](../../../packages/studio-plugin/src/host/application/prototype-collaboration.ts)接续：固定本人范围的 source、确认摘要及 claims，上传不可变 source／candidate，按原操作处理 prepare、条件推进、complete、unknown、干净合并与冲突新确认；accepted 后的本机同步和清理各自恢复。实现后台独立候选树计算和策略权威来源，不把客户端声明或 compare 路径列表冒充合并树验证。关联 I04、I07、I10、I15。
2. **补齐事项输入与恢复。** 在同一编排接入自由指令的实际需求识别、本人可读草稿和实际读取证据；补队列重排／暂停、关闭保存、原生消息定位及执行收敛。扩领成功后 scope／现场／发送失败保留原 claims、原操作和指令；不要新建替代任务或盲目重发。prepared、取消／释放、abort 和晚到 Git 副作用按原操作与实际状态衔接。关联 I01、I05、I13、I15。
3. **补齐文件与预览。** 在 [files.ts](../../../packages/studio-plugin/src/host/prototype/files.ts)、[execution-guard.ts](../../../packages/studio-plugin/src/host/adapters/platform/execution-guard.ts)、[PrototypeFiles.tsx](../../../packages/studio-plugin/src/client/prototype/PrototypeFiles.tsx)统一模型和人工写锁，完善编辑缓冲、冲突合并、受控大文件读取与观察版本；按既定路线实现独立只读基线现场、持久检查证据和隔离内嵌预览。接入成熟编辑器、受限浏览器及附件时同步运行时锁与分发源码。关联 I02、I03、I06、I08、I09、I11、I12。
4. **贯通下游并清理旧语义。** 将新 baselineId／commitSha／acceptance 从确认贯通交接、原型包复用和发布，保留材料固定版本自身规则；关联需求不等于业务覆盖。逐项更新受影响 contracts、SQL 说明、调用者和旧测试源码，不保留单需求 completion 双轨。关联 I07、I10、I14。
5. **持续记录事实。** 实现中遇到逻辑问题直接补充[工程问题清单](implementation-issues.md)，标注代码位置、影响与后续处理；不为完成一个工作包设置额外审批按钮、独立 POC 或验证门禁。若以后用户改变“不构建／验证”的要求，再分别记录局部检查和当前交付版本的真实桌面闭环；在此之前保持未执行／未验收，不借历史结果或本交接文档宣称通过。
