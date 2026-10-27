# 需求协同到原型展示：设计审核与执行交接

日期：2026-10-27。审核对象为当前工作区，源码 HEAD 为 `476c1391ca5f53ee0d8b03de3e64e5df039e77eb`；包含尚未提交的原型设计成果，不能仅凭 HEAD 重现本次全部设计输入。

**审核结论：业务方向已有明确决定，现有设计可作为实施基础，但尚不具备直接整段开工的完整工程条件。** 核心差距是项目级原型设计与单需求产品实现不一致；内嵌预览、固定宿主恢复能力及后台合并验证还需完成设计闭合和技术验证。先完成本文列出的前置工作，再整体确认详细设计，按 PT 工作包实施。

本次完成设计／源码静态审核、执行规划及交接；没有修改产品源码、数据库、依赖或远端服务，没有提交／推送，没有启动产品或真实模型。真实桌面闭环仍为**未验收**。本文不是用户整体确认，也不授予后续编码、安装依赖、修改远端或发布权限。

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
| [技术选型与浏览器验证](technology-and-browser-validation.md) | CodeMirror、稳定 Playwright／Chromium、分发成本与六项 POC。 |
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

这里的 P1 表示进入相关实现包前必须处理的阻断或重大差距；P2 表示需补齐的契约、展示或交接项。实现差距与设计缺口分别标注，不把尚未实测的风险当作已复现故障。

| 编号 | 等级／性质 | 当前证据与影响 | 必须交付的处理结果 |
| --- | --- | --- | --- |
| R01 | P1，实现差距 | [studio.ts](../../../packages/studio-plugin/src/host/application/studio.ts) 684、693—707、753—757、808—817 行仍按单个已确认需求认领，并在接受后自动打开会话、发送实现提示；574—579 行恢复仍校验材料版本及前置完成。与需求协同“用户发送才实现、草稿探索”冲突。 | 替换为事项身份与明确指令启动；打开／检查／预览只读；删除自动发送、单需求 inputHash 及前置完成门禁。验 PA01、PA02、PA05、PA36—PA43。 |
| R02 | P1，实现差距 | [integration.ts](../../../apps/collaboration-api/src/modules/integration.ts) 68—74、103—110 行及 [schema.sql](../../../apps/collaboration-api/db/schema.sql) 837—850 行仍将接受及基线绑定单需求／材料版本，并更新 completedVersion。UI 无法单独修正这个模型。 | contracts、领域、SQL、仓储、API 及投影同次替换；原型 acceptance／baseline 独立；任务、完整 claims、认可头及幂等结果原子接受。验 PA12—PA23、PA28—PA32。 |
| R03 | P1，设计缺口＋现有阻断 | [03-prototypes.md](../03-prototypes.md) §2.3 要求内嵌预览；[preview.mjs](../../../packages/studio-plugin/assets/prototype-template/scripts/preview.mjs) 14—17 行明确 `frame-ancestors 'none'`。当前 [topbar/items.tsx](../../../packages/studio-plugin/src/client/topbar/items.tsx) 57 行及 [StudioTopbar.tsx](../../../packages/studio-plugin/src/client/components/StudioTopbar.tsx) 49 行仅提供外开链接。设计尚未选定真实内嵌载体。 | 先形成内嵌承载决策并做固定宿主 POC；明确原型页面与工作台／Node／preload／IPC 的隔离、几何布局、销毁恢复、导航及弹窗策略。不得直接移植模拟 iframe 或全局放宽 CSP。 |
| R04 | P1，关键技术待验证 | [collaboration-contract.md](collaboration-contract.md) §6.1 拟新增 Linux Git 验证器，仅重建原型子树合成提交；目前没有 Host／服务端同策略树一致性结果，Dockerfile 也未声明 Git。 | 先用固定版本对照验证共同祖先、重命名、删除、冲突、材料头推进和恶意候选；记录真实 SHA 与合成 SHA 区别、资源上限及失败拒绝行为。不能仅凭 Host 声明 clean 放行。 |
| R05 | P1，实现差距＋宿主能力待验证 | [desktop-runtime.md](desktop-runtime.md) §4.1—4.3 已定义持久队列／关闭协议，但当前仅有 tasks／operations、进程内 BackgroundLane 和会话 resume；没有完整队列、可靠消息操作核对及退出保存协议的本轮运行证据。 | 先验证固定宿主可用的 message ID／ack／事件位置、取消 settled、flush 与 resume；再实现账号跨项目串行入口、逐步持久化、正常关闭及崩溃恢复。不能只在页面禁用按钮。 |
| R06 | P1，下游连带差距 | [studio.ts](../../../packages/studio-plugin/src/host/application/studio.ts) 895—918 行生成交接仍读取 baseline.entityId／version；[integration.ts](../../../apps/collaboration-api/src/modules/integration.ts) 58—60 行仍要求交接引用 completed requirement；[reuse.ts](../../../apps/collaboration-api/src/modules/reuse.ts) 26、37—39 行仍依赖 prototypeBaselineId／prototype confirmation。 | 基线模型切换时同步交接、原型包复用及发布消费者；显式使用 baselineId／准确 commitSha。材料复用仍用材料固定版本。不能先删除 completion，再把消费者留到最终联调补救。 |
| R07 | P2，指标语义歧义 | [milestones.md](../../milestones.md) 110 行将“原型验证（验收完）”映射到原型确认；新设计明确作者接受不证明逐需求业务验证。199—207 行的“需求覆盖率”又有自己的场景关联口径。 | 区分作者确认、后台接受、工程检查、实际业务用例结果和关联统计。已有场景关联占比不能改称需求实现覆盖率；无可靠取数显示未统计，不能从基线关联集合生成验收绿灯。 |
| R08 | P1，运行时契约待展开 | 领取／扩领、write-scope 更新和模型发送是分步操作；[collaboration-contract.md](collaboration-contract.md) §5—§7 定义各步幂等，但需要明确一次用户指令跨步骤失败后的本地恢复位置。 | 用既有 operation 记录串联真实用户动作、任务创建／扩领、scope、现场创建、消息发送；每步先落盘并传递新 token。两项授权均核对完成才派发；扩领成功而 scope 失败时保留已领取事实，只补未完步骤，不偷偷缩减 claims／换 key／重发模型。 |
| R09 | P2，边界未闭合 | [technical-design.md](technical-design.md) PA23 规定无代码变化不新建基线，但活动任务 claims 又只增不减，接受才结束任务。无变化确认后任务是否仍活动没有独立说明。 | 推荐明确为：查看已有基线保留 active 及占用，界面说明仍在开发；用户选择结束事项时沿 cancel 路径释放全部 claims、保留现场。不得把打开基线当 accepted 或暗中释放占用。此为待纳入整体确认的具体提案，不新增状态或伪基线。 |
| R10 | P2，设计稿及测试覆盖差距 | [03-prototypes.md](../03-prototypes.md) §3 明确交互稿尚未补齐事项选择与并发冲突；现有 23 项 DOM 检查覆盖三需求演示，不覆盖服务端开发互斥、队列或真实预览。 | 设计稿补事项／队列、占用冲突、扩领失败、源版本与现场标识；对应替换旧固定需求测试。模拟测试与产品验收分别记录。 |
| R11 | P2，队列入队契约待展开 | [desktop-runtime.md](desktop-runtime.md) §3 的 start 建立任务／现场／会话，§4.1 又要求当前事项运行时可保留其他待开始事项；尚未明确首次实现指令如何入队及何时派发。 | 推荐：本人当前无运行事项时，首次明确发送即领取、建现场并派发，无第二次继续按钮；已有运行事项时，创建成功的另一事项入队，首次指令持久保存但暂不派发，用户手动切换／继续时才执行。两种路径共用原 messageOperationId；不因当前轮结束或重启自动派发。此为待纳入整体确认的具体提案。 |
| R12 | P2，文件读取契约待展开 | [desktop-runtime.md](desktop-runtime.md) §2、§6 要求文件树、搜索与真实 diff，但 §3 命令表目前只展开单文件读／写。 | 在同一受控文件服务补目录投影、搜索和 diff 查询；限制相对路径、结果数量、文件大小、二进制及凭据过滤，返回明确工程／版本标识。不能由客户端遍历任意磁盘补齐。 |

补充静态风险：[repository.ts](../../../apps/collaboration-api/src/persistence/repository.ts) 156 行向 `studio_occupation_inputs` 插入数据未提供 `project_id`，而 schema 775 行为 NOT NULL。尚未做数据库复现，不能称为已复现故障；该表已列入直接删除范围，不为旧原型前置模型补兼容层。

已复核并收窄的两点：里程碑末尾“严格串行”指研发阶段顺序，不能据此否定已允许的草稿探索；场景关联占比可以独立存在，问题是命名及取数边界，不应一概删除统计能力。

## 4. 成熟模式核对与前置技术验证

2026-10-27 重新查阅官方资料，而非只沿用旧方案中的产品描述：

| 模式 | 官方证据 | 本项目采用边界 |
| --- | --- | --- |
| 对话旁查看代码和预览 | [Bolt Code view](https://support.bolt.new/building/code-view)、[Preview controls](https://support.bolt.new/building/preview-controls) | 借鉴查看／编辑和预览布局，保留既有 AI 风格；不推导 Bolt 已替本项目解决多人 claim、Git 接受或桌面隔离。 |
| 合并后审阅和验证 | [VS Code merge conflicts](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts) | 冲突解决后仍检查结果；成熟编辑器负责差异呈现，Git 负责真实合并，业务确认仍由用户完成。 |
| 自动化和浏览器成对锁定 | [Playwright Browsers](https://playwright.dev/docs/browsers)、[Trace viewer](https://playwright.dev/docs/trace-viewer) | 使用稳定工具的定位／断言／trace，随包配对浏览器；不能从 Chromium 验证推定 Electron 桌面闭环通过。 |

本次只读 npm registry 核实 `playwright@1.61.1`、`@codemirror/view@6.43.15`、`@codemirror/merge@6.12.3` 可取得对应元数据，许可证分别为 Apache-2.0、MIT、MIT；Playwright 声明 Node >=18。入口见[Playwright 元数据](https://registry.npmjs.org/playwright/1.61.1)、[view 元数据](https://registry.npmjs.org/@codemirror/view/6.43.15)、[merge 元数据](https://registry.npmjs.org/@codemirror/merge/6.12.3)。这只证明版本元数据存在，没有安装，也没有验证浏览器 archive、配对 revision 或运行兼容性；后续仍须按锁文件与官方 browsers.json 核对。

将原 PT05B 中的“先 POC”前移为共同实施前提，避免 schema 和 Host 大改后才发现固定宿主无法承载目标能力。以下均待执行：

| POC | 验证内容及交付物 | 通过条件／失败去向 |
| --- | --- | --- |
| V01 内嵌承载 | 优先验证固定 Electron 可用的隔离子 WebContents 承载模式，再决定具体 API；记录创建／布局／焦点／设备画布／销毁／恢复。 | 保持 Node、preload、Host bridge 隔离，页面不能调用工作台命令；不依赖去掉所有 CSP。固定宿主不满足时回到承载设计，不静默升级宿主。 |
| V02 原生恢复 | 真实原生会话发送、取消、进程退出、重开，核对 messageOperationId 到实际消息的映射及 durable flush。 | 已发送／未发送／未知可区分；不能证明未发送时保持 unknown。明确关闭保存失败如何保留界面及输入，不承诺强杀最后击键无损。 |
| V03 合并一致性 | 固定 Windows Git 与目标 Linux Git，对相同 base/head/source 原型子树计算；包含材料头推进、多共同祖先策略、重命名及冲突样本。 | 规则、版本、树结果与拒绝原因可重跑；对不支持的历史形态明确拒绝并回设计，不信任任意 candidate。 |
| V04 编辑与文件并发 | CodeMirror 最小 React 生命周期、中文输入、只读、diff、未保存保护；人工与 Agent 同文件竞争。 | Host 同一路径串行且锁内重验 hash；冲突保留双方，切换和退出可恢复。 |
| V05 浏览器和发行 | 执行选型文档六项 POC：真实用例、两任务隔离、实际 sink 负向验证、取消恢复、干净机离线、截图进真实模型。 | 每项有固定版本、命令、产物／附件和结果；新增受限 provider 不放开通用 MCP，离线安装无首次下载。 |

V01—V05 是验证任务，不是本次已经执行的工作；需要在既定设计审批及依赖／宿主调度规则内安排。V05 的干净机与安装验证需要实际候选包，作为后续发行关口保留，不能为了前置 POC 虚报已完成整包交付。

前置工作的执行边界按动作区分：当前可继续做设计补齐、官方资料及现有源码／锁文件只读核对，复用现有离线检查；V01—V03 的真实宿主／模型与进程试验，以及 V04—V05 的候选依赖安装、专属浏览器下载／打包，列入后续明确的 POC 执行任务，不能从本次“审核并规划”指令推定已完成或直接操作。V03 不在指定协同服务上安装验证器，V05 不修改日常浏览器或用户活动现场。需引入依赖或改变发行行为时遵循 AGENTS.md 的咨询及额度门禁，不把 registry 查询当作该步骤已完成。

R05 中固定的是产品目标：手动继续、先核对未知结果、保护已落盘输入。message ID／ack／flush 的具体证据形式取决于 V02；若固定宿主缺少可核实信号，保留 unknown 和可诊断现场，不伪造已发送／已保存，不先承诺宿主尚未证明的能力。

## 5. 执行工作包与交付顺序

沿用现有 PT 编号，前置补 PT00；PT05B 拆成早期能力验证与后期正式接入。工作包局部检查完成不等于阶段验收通过。未经整体设计确认不进入产品编码，不做临时单需求新旧双轨、migration 或 fallback。

| 工作包 | 责任／文件所有权 | 输入依赖 | 必须形成的具体成果及退出条件 |
| --- | --- | --- | --- |
| PT00 审核收口 | 主 Agent；原型设计、ADR、里程碑及验证记录 | 本文 R01—R12 | 补内嵌承载、无变化事项、队列入队、文件读契约、原生恢复能力边界及跨步骤操作记录；完成可提前执行的 V01—V05 技术样本，发行部分留明确关口；修正指标歧义，再提交整份详细设计确认。 |
| PT01 协同领域及存储 | 执行代理 A；`packages/contracts/`、`packages/asset-domain/`、`apps/collaboration-api/src/`、`apps/collaboration-api/db/` | PT00 整体确认；冻结身份及事务规则 | 新 prototype/task/claim/acceptance/baseline；项目初始化创建唯一 prototype；部分唯一索引、多需求全领或回滚、完整 fencing、三种 integration 分支、幂等／审计／投影；同步规范 schema、schema-model 和受影响 ERD／说明。旧字段在对应消费者切换时删除。 |
| PT02 后台候选验证 | 执行代理 A；Git 内容适配器、独立验证模块、Dockerfile／运行锁及许可清单 | PT01；V03 | 固定 Linux Git，验证真实父关系及子树计算；事务外受限进程，超时／缺对象／冲突拒绝；临时对象清理及负向样本可重跑。禁止借此授权部署远端。 |
| PT03 事项与原生队列 | 执行代理 B；Host application、state、DSH adapters、shared 的事项投影 | PT01 契约冻结；V02 | 持久事项、跨项目单实现调度、只读材料访问与实际读取证据、scope/claims、先落盘再副作用；首次发送、扩领、多轮、暂停、退出、恢复、撤销和未知消息可核对。移除旧自动实现。 |
| PT04 文件与编辑 | 执行代理 B；独立原型文件服务、shared 文件契约、client 原型代码组件 | PT03；V04 | 真实文件树／正文／diff；统一 Agent 与人工保存路径、hash 并发及原子保存；保护区拒绝、持久缓冲、未保存选择及冲突恢复。CodeMirror 使用既定版本路线。 |
| PT05 工程证据与预览 | 执行代理 B；`host/prototype/`、composition、维护的桌面 build 适配 | PT03；V01 | 拆出持久检查证据及按工程实例管理；只读认可快照与本人事项分别运行；受管端口、instance、构建／工具指纹；内嵌及外开同构建，失败与旧预览状态真实。 |
| PT05B 浏览器正式接入 | 执行代理 B；受限 provider、附件与证据、runtime lock／发行装配 | PT04、PT05；V05 早期验证 | Playwright／Chromium 精确配套；run/session/build/origin 绑定、负向围栏、步骤断言和可读 trace；保留 Electron 技术保护检查。候选安装包阶段完成 V05 发行关口。 |
| PT06 确认集成及下游 | A 负责 API 接受／复用契约；B 负责 Host 候选／集成／交接／发布适配；主 Agent 整合 | PT02、PT04、PT05 | source 归一、上传、prepare、CAS、complete、干净合并重检／冲突新确认；unknown、abort/release 竞争、accepted 后收尾。同步改 generateHandoff、原型包复用、发布源及基线读取，准确区分 recognizedHead 与 baseline.commitSha。 |
| PT07 工作台贯通 | 执行代理 B；client 独立原型组件、需求进入原型动作、shared 事件消费 | PT03—PT06、PT05B | 项目原型／我的事项与队列、需求集合、预览／代码／输出和整体确认；原生输入真实发送受控；切需求不切现场，切事项才切现场。重连读完整投影，不从事件猜 accepted。 |
| PT08 删除核对及真实交付 | 主 Agent 验收；A/B 在各自所有权内修正 | PT01—PT07、PT05B | 清除旧协议及测试残留，完成 PA01—PA43 和补充用例；指定服务双客户端、真实模型、真实桌面、安装包与失败恢复证据齐全后再判断验收。任何未执行项保持未验收。 |

执行期间最多两个 Sol 执行代理。A/B 是职责槽位，不能理解为所有工作包同时启动；同一文件只有一名所有者。shared 契约由主 Agent 指定单一所有者发布，消费者按冻结版本实现，不互相覆盖。PT06 交叉文件在开工时逐文件划定；任何代理都不得回滚现有未提交成果。

顺序：PT00 → PT01 → PT02／PT03 → PT04／PT05 → PT05B／PT06 → PT07 → PT08。只在接口输入已经冻结、文件所有权不重叠时并行，不以并行跳过研发阶段门禁。

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
| PA01—PA43、V01—V05、真实浏览器视觉、真实桌面／模型／协同／安装包 | 未执行，未验收 | 不得从前述局部结果推定通过。 |

既有 `.local/verification/prototype-workbench/` 脚本依赖本机装配树的 Happy DOM，不是新接手环境开箱即用的产品测试。后续将有效检查移入受维护测试入口，不能仅把忽略目录路径当作永久交付资产。本次不为文档审核修改测试基础设施。

## 9. 下一次执行与交接提示

下一步处理 PT00：回填 R03、R05、R08、R09 等工程展开项及验证结果，收敛内嵌承载和固定宿主可行性，再对完整详细设计作整体确认。已确认的业务边界不重新发明；若技术验证确实要求改变既定路线，明确证据、影响和取舍后再决定。

可直接使用以下提示继续：

> 先读 `docs/design/prototypes/development-handoff.md`，确认本次目标、已确认业务边界、未验收项及 PT00 待办，再按工作包只读必要设计和源码。先核对当前 git status 与 HEAD，保留原有未提交成果。当前尚未整体批准详细技术设计，不直接开始产品编码、安装依赖、重建数据库或修改远端；先完成审核缺口的具体方案和授权范围内技术验证。不得恢复单需求固定依据／前置完成门禁，不自动发送实现指令。按两个 Sol 执行代理上限划分文件所有权；主 Agent 整合及验收。历史仅按定位线索按需召回，不整段回灌，也不扩大本次授权。

文档交付检查记录（2026-10-27）：35 处本地链接与 1 处章节锚点检查通过，UTF-8／代码围栏／行尾空白检查通过；新文件 `git diff --no-index --check -- NUL docs/design/prototypes/development-handoff.md` 与工作区 `git diff --check` 通过（既有三个修改文件仅有 CRLF 转 LF 提示）。独立接手读者已核对授权、首包、派发、无变化事项及验收边界；发现的派发歧义和 POC 动作范围已在本文补明。设计提案仍待整体确认，产品验证状态不因此改变。
