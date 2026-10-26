# 阶段一修正与验证记录

2026-10-20 起按“协同后端修正 → 桌面端修正”实施。业务与工程依据为[场景设计](01-scenarios.md)和[数据库设计](01-scenarios-database.md)。本记录区分源码完成、隔离验证与完整产品验收，不把后端通过等同于 S01—S38 全部通过。

2026-10-21 衔接设计已调整修订规则：各材料独立占用与确认，取消关联冻结、强制同批确认和自动来源升版；增加只读本地文件的独立非阻断一致性对比，以及固定内置通用场景。下文批次、冻结及需求分类是现有实现记录，须按[阶段二需求设计](../02-requirements.md)替换；其既有代码校验不能证明新规则已经实现。阶段二工程方案仍待整体确认，本记录不扩大实施授权。

## 协同后端修正

后端源码已接入关系模型，运行时 [schema.sql](../../../apps/collaboration-api/db/schema.sql) 与[设计 SQL](schema.sql)保持一致。按新库一次初始化，拒绝旧 JSON 薄壳结构，不提供迁移或兼容处理；本次未替换现有运行库或部署服务。

| 范围 | 交付行为 |
| --- | --- |
| 项目生命周期 | 创建预留、建仓、成员分配、初始化接受在同一项目记录推进；结果未知沿原请求核对，项目 ready 后才允许业务写入。初始化校验项目清单、默认模板及固定 Git 版本。 |
| 场景创建与目录 | 仅名称即可新建，删除场景分类；UUID 仍决定材料路径。项目内独立持久预留 SC 编号，原子递增，故障不回收；同操作重试复用同身份，操作键不可跨动作使用。需求仍使用分类。 |
| 目录与历史 | 共享草稿名称、编号、创建人、编辑人和占用信息；标题、摘要、当前关联文件路径作目录投影。已确认版本按固定 Git 引用读取，不上传本地草稿正文或 AI 过程。 |
| 固定材料接受 | 请求仅传确认控制与固定引用；后台读取最终 Git 材料，校验阅读 hash、业务质量项、正式依据及关联文件的路径、内容 hash 和实际引用范围。材料、依据和文件清单不另存后台业务快照。取消固定章节名称与字数推断。 |
| 需求来源与修订 | 新建需求必须绑定至少一个本项目已确认场景版本；修订场景显式领取批次占用，冻结关联需求，完整集合原子确认。查看旧确认版和影响清单不产生占用。 |
| 项目模板 | 模板作为独立配置集成，只允许 `.template/` 和项目模板清单变更，不领取设计占用、不确认场景。发布后新场景绑定新默认，旧场景保留历史引用并可显式切换。 |
| 授权修复控制 | 记录用户授权动作、起始及当前 hash、累计轮数、暂停、显式续接、终止和完成。单任务最多三轮，续接不得复用旧用户动作；确认必须匹配最终修复 hash。占用结束或并发目录编辑撤销未完成授权。后台不执行 AI。 |
| 既有后续能力 | 原型完成、基线、复用资格与采用、交接回执改用明确字段保存，保留原有业务规则。 |

请求、类型与状态以 [共享契约](../../../packages/contracts/src/index.ts)为准。桌面与 Host 已按这些契约改造；本轮不连接真实服务执行操作验收，不保留旧请求兼容层。

## 桌面端修正

2026-10-21 已完成下列代码改造，本轮只执行类型、自动化测试及构建校验：

1. 新建场景只输入名称，消费编号及模板绑定；项目初始化写入默认模板与清单，适配需求固定来源及新的确认请求。
2. 列表信息、筛选、统计与分页；双栏 AI／Markdown 工作区、确认版只读查看及修订影响确认。
3. 手工编辑与 800ms 自动保存、文件 hash 检查、外部变更冲突及未保存现场保护。
4. 独立场景会话、资料实际读取记录、结构化建议与一次采纳、旧建议失效。
5. 模板设置、发布预览、历史绑定切换及本机结构检查开关。
6. 正式依据归档、门禁展示、授权修复执行与显式补答续接、确认结果未知核对及确认后选择拆分。

本轮覆盖 Host 文件／版本规则、真实 PDF 文本提取引擎、原生 DSH 插件组合及客户端状态控制器的代码验证。依用户限定，不进行视觉、真实模型、真实协同或 Windows 桌面操作验收；S01—S38 的完整产品验收仍未执行，不能据此宣布阶段一整体验收通过。

## 后端验证

类型检查覆盖 `@eadp/contracts`、`@eadp/asset-domain`、`@eadp/collaboration-api`；单元验证覆盖 API `src` 下的内容、初始化、身份、缓存、更新及集成模块测试。

真实 PostgreSQL 17 使用独立临时容器、独立空白测试库；GitLab HTTP 边界为测试夹具，未连接企业仓库或修改运行库。各数据库套件分别使用新库，不能在同一已初始化库重复执行建表测试。

| 验证入口 | 覆盖范围 |
| --- | --- |
| `node --test tests/collaboration/scenario-schema.test.mjs` | 新库 DDL、重复初始化拒绝、项目生命周期、编号与身份、不可变确认、需求固定来源约束。须显式配置 `SCENARIO_SCHEMA_TEST_DATABASE_URL`。 |
| `pnpm --filter @eadp/collaboration-api check:transactions` | 独立编号提交、业务回滚不丢号、并发唯一、幂等重放、唯一占用和旧代次拒绝。须使用专用命名的空白临时库。 |
| `tests/collaboration/backend-lifecycle.test.ts` | 登录会话、真实 SQL 的建仓恢复、初始化与权限门禁。 |
| `tests/collaboration/backend-consistency.test.ts` | 实际分支头门禁、管理员核对、共享草稿目录及只读查看。 |
| `tests/collaboration/backend-scenarios.test.ts` | 编号并发／故障／跨项目、新建去分类、固定内容接受与未知结果、资料阻断、固定场景来源、批次冻结、模板发布／切换、修复额度／续接／撤销，以及原型／复用／交接回归。 |

后三个套件用 `STUDIO_TEST_DATABASE_URL` 分别指向命名符合 `eadp_auth_check_*` 的新库，通过 `pnpm --filter @eadp/collaboration-api exec tsx --test <测试路径>` 执行。未设置数据库变量时的跳过不计入通过。

## 桌面与 Host 公共模块设计（2026-10-20—21）

本轮实施依据已确认场景方案；按用户要求仅执行代码校验，不执行视觉、真实模型或桌面操作验收。

- `shared/scenarios.ts` 定义场景工作区、资料读取、建议批次、门禁、冲突和可信 UI 命令。普通 Agent 输出不具备保存、确认或续接授权。
- `ScenarioDocumentService` 统一按文件串行写入、expectedHash 校验、操作幂等、原子替换及冲突现场；建议解析与应用使用同一保存服务，避免手工保存和采纳形成两套文件规则。
- 场景工作区服务负责只读固定版本、显式修订、会话历史、资料选择与建议状态；模板发布与修复状态分别封装，StudioApplication 只组合服务及既有 Git 集成链路。
- 客户端分离稳定的原生会话容器、800ms 自动保存 Hook、文档编辑器、建议／资料／门禁面板。导航先 flush；保存失败保留当前输入；轮询不得按文件 hash 重挂载编辑器或原生会话。
- AI 继续使用 DSH Agent、模型投影、会话持久化和 conversation 槽。普通场景会话只读，每轮按当前 MD、固定模板及实际已读资料刷新上下文；授权修复也由 Host 校验候选并写入。
- 固定 Git 内容按不可变引用缓存；目录查询不逐项装载场景正文。输入编辑与轮询分离；保存不触发模型请求；AI 生成不占用 Host 命令队列等待完成。


## DSH 能力复用与流畅度

参照 `release.lock.json` 固定版本中的成熟插件：`plan-mode` 的 scoped Agent 事件、`system-prompt` 的 required runtime context、`session-controller` 的原生会话／取消及模型投影、`tool-fs/read-image` 的真实附件读取、`office-to-pdf` 的共享有界转换队列，以及 Document Preview 使用的同版 pdfjs 引擎。

- 产品 patch 声明 `eadp-scenario` 原生 preset，复用 persona、read、read_image、glob、grep、compaction 与 `/compact`；不装配 shell、文件写入或子 Agent 工具。普通会话及授权修复均由 Host 执行受 hash 约束的写入。
- 场景恢复历史会话时，每轮上下文按当前有效占用定位当前 Markdown 和模板，原生会话身份与历史不变；模型选择及取消继续由 DSH 提供。
- 800ms 自动保存串行提交；原生会话稳定挂载；资料／建议／门禁面板使用稳定回调和 memo；轮询带动作代次检查，避免旧响应覆盖新状态。
- Office 转换与 PDF 提取在命令队列之外执行，结果按原账号、项目、资料身份及 hash 短暂入队交付。IPC 投影不携带未使用的抽取全文。
- 场景文件观察器监听父目录，支持原子替换；并发编辑及时撤销授权修复。保存／采纳的幂等记录、冲突两份及临时资料位于 Git 外的用户本地目录。
- 正式依据只归档用户选择；取消选择后只清理工作台登记、未跟踪且未被任何材料引用的文件，历史已跟踪依据保持不变。模板发布使用独立 worktree，固定材料缓存只接收已校验 hash 的内容。

资料读取限制以实际结果展示：PDF／Office 提取仅声明已读文字和页范围，图片／图表／公式语义不冒充完整读取；扫描 PDF 无文字时失败。图片导入后须有原生 `read_image` 的真实图片附件结果才记录已读，模型不支持图片或工具失败时不记录成功。


## 本轮代码校验结果（2026-10-21）

| 校验 | 执行与结果 |
| --- | --- |
| 原生装配 | `node apps/desktop-distribution/build/prepare-studio-plugin.mjs --dev-stage` 通过；仅写忽略的装配树，未修改上游缓存。 |
| Host／Client 类型 | 在 `.local/build/dsh` 执行 `node node_modules/typescript/bin/tsc -b packages/eadp/studio-plugin/tsconfig.host.json packages/eadp/studio-plugin/tsconfig.client.json`，通过。 |
| Typert | 同目录执行 `node --import tsx/esm scripts/generate-typert.ts`，成功生成 31 个原生契约产物；装配维护产品领域包的源码路径映射。 |
| 两端打包 | 同目录执行 `node --experimental-transform-types node_modules/tsdown/dist/run.mjs --config-loader native --config packages/eadp/studio-plugin/tsdown.config.ts --env.DSH_BUILD_FACE host` 及 `client`，均通过。 |
| 自动化代码测试 | 使用 `apps/collaboration-api/node_modules/.bin/tsx --test` 合并运行下表入口，179 通过、0 失败、1 跳过。真实 DSH resolver 用例设置 `EADP_TEST_DSH_ROOT` 指向装配树后通过；跳过项为已有构建脚本中缺少本地固定归档样本的缓存破损用例，不计入通过。 |
| 仓库约束 | `pnpm check:repository` 与 `git diff --check` 通过，49 个随包模板文件 hash 保持一致。 |

| 自动化入口 | 覆盖 |
| --- | --- |
| `tests/windows-desktop/scenario-documents.test.ts`、`material-draft.test.ts` | 版本受控保存、幂等与冲突双份、建议范围／重叠／模板／hash、业务门禁和正式依据。 |
| `tests/windows-desktop/scenario-orchestration.test.ts`、`scenario-file-observer.test.ts` | 只读与显式修订、历史会话当前上下文、资料离队交付、依据安全清理、模板隔离，以及修复额度／补答／并发／取消／丢响应／重放恢复。 |
| `tests/windows-desktop/scenario-dsh-adapter.test.ts`、`tests/scripts/scenario-preset.test.mjs` | 实际 PDF 引擎、Office 服务边界、原生模型／上下文／图片附件证据，以及实际原生 preset 的只读工具和压缩插件。 |
| `tests/scenario-client/draft-buffer.test.ts`、`material-editor.test.mjs`、`tests/scripts/studio-conversation-restoration.test.mjs`、`studio-task-purpose.test.mjs` | 800ms 保存、并发与失败保护、稳定会话挂载、目录筛选排序及冻结关系控件。 |
| `tests/windows-desktop/task-recovery.test.ts`、`asset-workflow.test.ts`、`conversation-restoration.test.ts`、`login-reply.test.ts`、`tests/gitlab-auth-host/projects.test.ts` | 原操作恢复、固定材料确认／评审／采用、同批来源新版本、会话授权和账号隔离。 |
| `tests/windows-desktop/execution-scope-identity.test.ts`、`execution-guard-delegation.test.ts` | Agent 精确文件权限、原生 cwd 和委派边界。 |
| `tests/scripts/studio-payload.test.mjs`、`studio-typert-edits.test.mjs`、`studio-packaging-edits.test.mjs` | 插件载荷、原生类型生成锚点及发行装配规则。 |

本轮未启动桌面、不进行截图或交互走查、不调用真实模型、不连接真实业务仓库进行确认或发布；上述代码结果不能替代 S01—S38 产品验收或 Windows 发行验收。

## 场景编辑与新增页面结构对齐（2026-10-21）

按 `docs/dseign/项目场景编辑.html` 的结构与信息层级重排场景工作区，只参考结构，不引入设计稿色系；新增场景确认后直接进入同一页面，因此本次改造同时覆盖编辑与新增。

- 左右双栏：左侧场景会话（代码芯片、标题、刷新／历史会话／新会话／场景模板，资料与正式依据、AI 建议、需求拆分入口），右侧材料契约（文件路径与同步状态、预览／源码、导出、保存、收起）。
- 右侧正文按 `##` 章节分卡，带 01.. 序号与条目数徽标；正文为空时按当前模板列出待补章节，代替空白预览。
- 门禁状态、阻断原因、模板结构检查、Working Tree 与确认／AI 修复动作移到契约面板底部；页面头部在场景详情只保留返回与项目状态。
- Frontmatter Manifest 整卡可收起，默认展开；收起后只保留标题行。
- 资料与正式依据和 AI 建议合并为一个可折叠的「资料与 AI 建议」组，默认展开，收起后标题行仍保留资料份数与建议条数。
- 会话输入框贴住面板底部：原生会话在没有消息时不会自动下沉输入座位，改用 `[data-composer-seat]` 的自动上边距；有消息时保持原生 sticky 行为。
- 建议改为按组／按条采纳，采纳与材料 hash 绑定；不可采纳的失效批次以单行说明呈现，不再渲染无操作按钮的卡片。

校验：`node node_modules/typescript/bin/tsc -b packages/eadp/studio-plugin/tsconfig.client.json` 通过；`node --test tests/scenario-client/document.test.mjs tests/scenario-client/material-editor.test.mjs tests/scenario-client/draft-buffer.test.ts tests/scripts/studio-task-purpose.test.mjs` 全部通过（新增 `document.test.mjs` 覆盖章节拆分、围栏排除与条目计数）；`pnpm dev:desktop` 打开实际桌面后以 SC-0001 走查预览／源码切换、收起与展开、门禁与建议呈现，并确认输入框贴底（座位底边与面板底边相差 1px）与两处折叠互不影响。

走查发现（与本轮页面改造无关的数据问题）：既有草稿 SC-0001 的文件模板引用与后台实体的 `templateId`／`templateRef` 不一致，保存被 Host 以“场景身份与模板绑定不能通过编辑改变”拒绝；页面已将错误显示在同步状态并提供重试，草稿正文未被写入。

## 后续修订（本轮）

按条／按组／按批建议采纳与「自动写入 AI 建议」开关被取消，场景与需求统一为写入提议＋整篇写入：AI 只讨论并归纳结论，主动提问是否把本轮结论写入目标文件，用户明确回答（按钮或回答“是”）后由 Host 校验正文 hash、模板固定引用、项目上下文 hash 与所选依据集合并整篇写入，写入返回变更摘要且可按本地差异撤销；任一条件变化即提议作废并重新提问，同一提议重复回答只生效一次。上文 2026-10-21 记录保持原样，属于当时的实现与校验事实；后续代码调整与验证随本文追加。

## 协同后端路径范围修正（2026-10-22）

本轮只实施开发清单涉及协同后端的两项路径范围，不新增契约字段、端点或数据库结构。

- SC03：`stage:"template"` 的受控配置集成允许在项目根更新 `CONTEXT.md`；仅更新该文件时不要求重复声明模板目录，发布模板文件或 `project.assets.json` 时仍须声明目录。项目身份、四目录声明与已发布模板身份不可改写或删除。
- SC06：材料与场景批次集成的写入范围在项目根只放行 `CONTEXT.md`；其他根目录文件即使被列为关联文件也不得进入 `allowedPaths`。关联文件仍须在材料 `metadata.files` 中声明并经内容 hash 校验。

校验：`pnpm --filter @eadp/collaboration-api typecheck` 通过；`src/gitlab-content.test.ts` 44 项通过（新增材料与模板两侧的 `CONTEXT.md` 放行、任意根目录拒绝、无模板目录项目仅更新上下文四类用例）；`src/modules/integration.test.ts`、`src/project-initialization.test.ts`、`src/auth/gitlab.test.ts`、`src/desktop-update.test.ts` 共 43 项通过。已重建并启动 Docker 镜像，`GET /health` 返回 `{"status":"ok"}`，api／db／cache 容器均为 healthy。本轮未连接真实企业 GitLab，也未执行桌面端与完整产品验收。

## SC04 写入提议契约与提问触发（2026-10-22）

- 模型输出唯一 `eadp-write-proposal` 块，只允许 `entityId`、`conclusions`、`evidenceIds`、`body` 四个字段；出现提议 ID、hash、授权或确认字段即整体拒绝。Host 自行生成提议 ID、baseHash、模板固定引用、`CONTEXT.md` hash 与依据集合。
- 提议存 `ScenarioRecord.writeProposal`（不新增顶层集合，旧本地记录不作废）；依据集合取当前已选择且已读/部分读取的资料 ID。新建提议替换旧的待处理提议。
- 消费只由界面按钮产生：`resolveScenarioWriteProposal` 的 `write`/`reject`。聊天文本不解析肯定或否定。写入前重新核对正文 hash、模板固定引用、`CONTEXT.md` hash 与依据集合，任一变化即拒绝并要求重新提问；整篇写入复用 `ScenarioDocumentService.save`，以提议 ID 作为幂等 receipt，重复消费只生效一次。
- 拒绝时按结论文本生成稳定键存入 `rejectedConclusions`（最多保留 200 条）；同一结论换 ID 再问也会被 Host 丢弃，出现新结论后才可再次提问。
- 不可解析或引用未读资料的提议不会落盘，回答仅保留为聊天内容。
- 最小界面：对话区新增写入提议卡，展示结论与已读依据数量，只有“写入整篇正文／不写入”两个动作；旧建议卡片与采纳入口已由 SC14 删除。

校验：`prepare-studio-plugin.mjs` 完整装配通过，装配树 `tsc -b` 的 host 与 client 两个工程均通过；`tsx --test tests/windows-desktop/scenario-write-proposals.test.ts tests/windows-desktop/scenario-documents.test.ts tests/windows-desktop/scenario-orchestration.test.ts` 共 31 项通过（新增 5 项覆盖伪造字段、未读依据、过期判定、拒绝键与重复消费）。未调用真实模型，未做桌面交互走查。

## SC05 整篇生成与整篇写入的摘要与撤销（2026-10-22）

- 整篇写入仍复用 `ScenarioDocumentService.save` 的 expectedHash、按文件串行与冲突双份；写入只在用户点击提议卡按钮时发生，流式未完成、取消或失败不产生正文。截断的协议块解析失败并按 fail-closed 丢弃。
- 写入前把撤销快照与摘要记入 `ScenarioRecord.writeReceipt`：写入前正文、写入前后 hash、改动章节（新增/修改/删除）、所用已读资料名称与仍阻断的业务答案。快照与本地状态分开保存，不进入 Git。
- 写入后返回摘要卡；撤销按钮只在当前正文 hash 仍等于该次写入结果时可用，撤销是一次新的受 hash 检查写入，恢复到写入前正文并关闭该次撤销。正文被手工修改后撤销失效并提示先处理当前编辑。
- 写入提议、摘要与撤销共用同一个受控写入服务；需求侧当前只有手工编辑入口，写入提议与摘要撤销留到阶段二需求协同设计接入，本轮不建第二套文件规则。

校验：装配树 host／client 类型检查通过；`scenario-write-proposals.test.ts` 7 项通过，新增用例覆盖章节摘要、首次成稿、hash 检查撤销与截断协议块；`scenario-documents.test.ts`、`scenario-orchestration.test.ts` 回归通过。未调用真实模型，未做桌面交互走查。

## SC06 确认文件包（2026-10-22）

- 场景新建、手工保存、整篇写入、撤销、正式依据选择、模板绑定与授权修复统一把项目根 `CONTEXT.md` 以 `{ path: "CONTEXT.md", sha256 }` 写入 `metadata.files`；文件不存在时移除旧声明，不保留失效引用。
- 确认候选因此把正文、`CONTEXT.md` 与正式依据放进同一候选提交；`prepareCandidate` 对材料、依据与 `CONTEXT.md` 逐文件校验 hash，`allowedPaths` 只含本次材料、依据、关联文件与被标题重命名替换的路径，项目根只可能出现 `CONTEXT.md`。
- 旧草稿未声明 `CONTEXT.md`，或保存后 `CONTEXT.md` 再变化时，确认前明确拒绝并要求保存/重新读取；Host 不在确认时静默改写正文以补声明。
- 未新增契约字段、端点或审批表；正式依据仍走 `businessEvidence` 与 `.eadp/evidence/<sha256>`，`CONTEXT.md` 只走 `metadata.files`。
- 设计取舍：开发清单早期“`CONTEXT.md` 独立接受、不进入场景批次”的表述，被本轮交接和后端已放行的同批路径取代；`CONTEXT.md` 可随场景候选一并冻结与接受。仅更新项目上下文时仍可走模板发布的项目级受控链路。旧表述已在该文档标记为待清理。

校验：装配树 host／client 类型检查通过；`scenario-package.test.ts` 新增 2 项覆盖声明写入、hash 更新、文件移除与其他文件保留；`asset-workflow`、`scenario-orchestration`、`scenario-write-proposals`、`scenario-documents`、`scenario-package` 共 59 项通过。未连接真实 GitLab，未执行真实确认集成。

## SC07 可选评审不 commit（2026-10-22）

- `requestReview` 不再调用 `prepareCandidate`，改为 `prepareContent`：只解析任务、草稿、依据与确认输入，不提交、不跑工程检查、不调用远端。评审请求前后任务 worktree 的 HEAD 与历史不变。
- 评审绑定改由内容指纹承担：`head` + 按路径排序的逐文件 `{ path, sha256 }`（删除路径记为 `null`）+ `inputHash`。`inputHash` 仍来自 `reviewInputText`，与最终确认时的准备载荷一致，因此后端 `REVIEW_INPUT_MISMATCH` 校验不需要新增契约字段。
- 评审 worktree 以被评审 HEAD 创建，再把未提交的目标文件字节复制进去（`adapters/workspace/snapshot.ts`），不再从候选提交创建；报告接受前核对 HEAD 与每个文件字节，任一变化即失效。
- AI 辅助确认时重新计算同一指纹，与已有报告比对后才提交 `candidateSha`、`inputHash`、`reportHash` 与处理说明 hash；候选提交只在确认时产生一次。
- 评审任务、`reviews/<id>` worktree 与分支仍登记在 `local.tasks`／`local.reviews`，由 SC11 的任务与评审 worktree 清理统一释放；本轮未新增清理入口，也未删除旧链路。
- 边界：评审仍要求作者当前客户端持有有效占用与本地任务 worktree，评审对象是本地版本，不是已接受版本；维修/修复路径的授权边界未改动。

校验：`prepare-studio-plugin.mjs --dev-stage` 装配后，装配树 `tsc -b` 的 host 与 client 两个工程均通过；`tests/windows-desktop` 全量 167 项中 166 项通过、1 项因未配置测试数据库跳过，其中评审主用例新增“请求评审不产生提交、HEAD 不变”断言，并新增“评审快照字节变化后报告被拒绝”用例。未调用真实模型，未做桌面交互走查。

## SC08 确认后台持久恢复流水线（2026-10-22）

- 候选提交后的首次推送移入 `resumeOperation` 的 prepare 步骤：只有查询不到原操作（`OPERATION_NOT_FOUND`）时才推送候选到 `studio-fixed/<id>`，再创建集成。推送幂等，恢复路径不会跳过一次丢失的推送；查询到原操作时不再重复推送。
- `integrate` 只落盘 `PendingOperation` 并排队 `resumeOperation`，不再单独排队一次推送。丢响应时 `retryOperation` 查询原操作、原集成与 `complete` 幂等键，不重复准备、不重复接受。
- 远端稳定分支已前进时，确认在制作固定候选之前先把任务 worktree 对齐到后台认可头：本地变化先保存、快进、再以不提交方式重放；文本冲突由 AI 合并，本次材料、正式依据与已声明文件的冲突停止并保留现场。准备完成之后、CAS 之前远端再次变化仍按原规则停止并置为 `unknown`，不使用强制更新绕过重新确认；用户无需手工合并已完成对齐的远端提交。
- 执行边界（文档化而非宣称）：材料候选提交仍发生在命令队列中的 `confirmMaterial`/`confirmPrototype`，任务与评审 worktree 创建仍在命令队列中的 `designTask`/`prototypeTask`；对齐只使用本机 Git，认可提交缺失时进入 `syncing` 并由后台车道取回后自动继续；候选推送、集成 prepare、CAS、complete、接受后副作用仍在后台车道。

校验：2026-10-26 新增 `remote-merges.test.ts` 5 项覆盖干净快进重放、AI 冲突合并、受保护材料冲突回滚、认可提交待取回与独立本地提交拒绝；`requirement-confirmation.test.ts` 11 项、`fixed-candidates.test.ts` 16 项、`scenario-orchestration.test.ts` 29 项、`scenario-documents.test.ts` 14 项通过。真实 Git 与真实 GitLab 未在本机沙箱内执行，桌面闭环未验收。

## SC02 内置 grill 与技能快照接入（2026-10-22）

- 固定快照 `.local/skills/mattpocock/` 中的 `grilling`、`grill-with-docs`、`domain-modeling` 原样复制到 `packages/studio-plugin/assets/skills/`，连同 `LICENSE`、`SOURCE.json` 一起随插件发行；装配脚本把它加入 staging 路径并复制进装配树，`package.json` 的 `files` 覆盖该目录。
- `cordis.patch.yml` 的 `eadp-scenario` 增加 `@deepseek-ai/dsh-tool-skill`，persona 改为 grill/domain-modeling 编排：逐问推进、只归纳结论与提问、ADR 关闭、写入仅在作者通过写入提议卡同意后由 Host 执行。
- 场景会话在 `sessions.ts` 中以运行时路径挂载 `@deepseek-ai/dsh-skill-filesystem`：`includeDefaultRoots:false`、唯一 `customSkillDirs` 为随包目录、`providerName:'eadp-bundled'`、`watch:false`，因此不读取项目根或用户机器的技能。
- 会话提示词与 `studio.ts` 的场景规则采用结论归纳与整篇写入提议；旧建议解析与 UI 已由 SC14 删除。
- 需求侧已接入同一编排：`sessions.ts` 同时识别场景与需求材料文件，需求材料任务也解析到 `eadp-scenario` preset、挂载同一技能目录，并以只读工具运行；`scenarioSessionContext` 为需求材料生成包含 baseHash、绝对路径、元数据与正文的运行时上下文，`readPaths` 为空（不授予 worktree 之外的读取范围）。
- 需求材料的会话规则改为只归纳结论与提问、不写正文；需求侧写入提议与摘要撤销仍属阶段二，本轮不新建第二套文件规则。行为变化：需求材料会话从可写改为只读，正文修改走手工编辑，不再由会话直接落盘。

校验：装配树 `tsc -b` host/client 通过；`scenario-preset.test.mjs` 2 项通过（含三份技能原文与 stub 调用两个技能）；`scenario-dsh-adapter.test.ts` 6 项通过（新增需求会话使用同一 preset 与技能目录）；`asset-workflow.test.ts` 新增需求运行时上下文用例；`tests/windows-desktop` 全量 175 通过、1 项跳过。未在真实桌面挂载技能目录（dev-stage 不执行 pnpm install，动态依赖链接路径未验证）。

## SC03 项目上下文受控保存与三方核对（2026-10-22）

- `eadp-write-proposal` 增加可选 `target:"context"`（只允许该值，缺省为场景正文）。目标为项目根 `CONTEXT.md` 时，`body` 是新上下文全文，`entityId` 仍是当前场景；Host 不新增集合，提议仍存 `ScenarioRecord.writeProposal`。
- 提议的 `baseHash`/`contextHash` 取提问时的 `CONTEXT.md` 实际 hash（缺失记为 `absent`）；作废判定只绑定 `CONTEXT.md` 与依据集合，场景正文或模板变化不使上下文提议失效。上下文提议与正文相同会被拒绝。
- 用户按钮消费时重新读取文件并核对 `baseHash`；随后做三方比较：任务基线 = 任务 worktree HEAD 的 `CONTEXT.md`，本次修改 = 工作区文件，最新接受版 = 认可头的 `CONTEXT.md`。接受版与基线相同或工作区已等于接受版才写入；否则拒绝并提示回对话核对。该写入提议路径仍不做 rebase、不改 expectedHead 重试；材料确认路径在固定候选前对后台认可头的自动对齐见 SC08。
- 写入使用原子替换，只在任务 worktree 落盘、不 commit；随后用 `syncProjectContext` 把新 hash 写入场景 `metadata.files`（经 `ScenarioDocumentService.save` 做 expectedHash 检查），否则 SC06 确认会拒绝。提议 ID 作为幂等凭据，重复决策直接返回。
- 上下文写入不产生正文 `writeReceipt`，因此没有正文撤销入口；项目级接受仍走模板发布的受控配置链路。
- 界面：写入提议卡按目标显示“写入项目根 CONTEXT.md”与对应提示，不暴露 hash 或正文。

校验：装配树 `tsc -b` host/client 通过；`scenario-write-proposals.test.ts` 9 项、`scenario-orchestration.test.ts` 20 项通过（新增上下文提议解析/失效、成功写入并同步文件包、并发接受冲突返回对话、提问后文件变化作废四项）；`tests/windows-desktop` 全量 173 通过、1 项因未配置测试数据库跳过。未做桌面交互走查，未验证真实模板发布链路。

## SC09 主项目安全同步（2026-10-22）

- 集成被接受后，`resumeOperation` 在后台车道排队 `TaskMaintenance.settle`；同步目标取接受后重新读取的 `recognizedHead`，因此认可头已前进时同步后继头，而不是本次候选提交。
- `ProjectWorkspaces.syncMain` 先记录 `pending`，再按顺序判断：主目录不在稳定分支、工作区有未提交改动均只记录 `blocked`（“已确认待同步”）并返回；否则提交对象缺失时先取回，再只做 `merge --ff-only`。不 stash、不 reset、不 clean、不覆盖用户文件；快进失败同样记录 `blocked` 并保留业务接受状态。
- 重试入口为 `syncMainCheckout`（按项目重读认可头）与 `retryTaskSettlement`（重跑整条收整），都经 `lane.append`，不受车道去重键影响。状态落在既有 `local.projects[].sync` 字段，未新增集合，旧记录仍按原判据解析。

## SC10 任务身份与逐任务资源释放（2026-10-22）

- 会话句柄在 `DshTaskSessions.open` 时登记所属 worktree 的规范化路径；新增 `releaseWorktree` 只释放该 worktree 的句柄、绑定、可恢复会话标记与 `read_image` 调用记录，其他任务的会话继续可用。
- 场景文件观察器新增 `unobserveWorktree`，按规范化 worktree 解除全部观察；`ScenarioWorkspaces.stopWorktree` 转调。预览只在被释放的是原型任务且 `previewState.entityId` 一致时停止，避免顺手关掉其他任务的原型预览。
- 会话与临时资料仍从既有 `local.tasks`（作为历史记录保留）与 `scenario-sources/<project>/<entity>` 读取；收整不删除任务行，行上的 `cleanup.status='done'` 表明它不再指向活动 worktree。接受事务本身已释放远端占用，本轮未新增“只释放占用、不取消资产”的接口。

## SC11 安全 worktree 清理（2026-10-22）

- 新增 `host/application/task-maintenance.ts`：收整顺序为归档 → 移除 worktree → 保留归档引用并删除临时分支 → 标记任务行已收整。每步完成后先落盘，再执行下一步；重复执行直接跳过已完成步骤。
- 归档前用 `git status --ignored --untracked-files=all` 审计工作区全部路径，包括已跟踪文件的未提交修改、未跟踪文件、忽略文件与重命名的两侧。普通文件按相对路径复制到 `archive/<projectId>/<taskId>/` 并记录 SHA-256 与大小；依赖目录（`node_modules`、`dist`）、`.git`、符号链接、单文件超过 4 MiB 或总量超过 64 MiB 的条目标记为跳过并给出原因，不静默丢弃。清单写入 `manifest.json`。
- 移除前核对 `git state` 的规范化根目录必须等于任务记录的 worktree，目录身份不符即保留现场；目录已不存在但无归档记录时抛出错误而不是当作成功。移除使用 `worktree remove --force`（审计与归档已完成），临时分支只在仍指向记录的 HEAD 时删除，HEAD 保留在 `refs/eadp/archive/<projectId>/<taskId>`。
- 评审 worktree 随同一实体接受一并收整；评审报告行保留，worktree、分支与活动登记不再存在。共享同一 worktree 的冻结需求任务行同时标记为历史。材料 worktree 已清理时，场景拆分改在主 checkout（已包含认可头）运行并读取固定字节，不依赖待删目录。`state-recovery` 的严格记录判据未改动（只加字段与命令）。
- 边界：临时资料目录 `scenario-sources/` 不随任务删除（属于历史附件读取）；主目录同步失败不阻塞清理，任务状态为 `blocked` 并写明“主目录同步待重试”。

校验：装配树 `tsc -b` host/client 通过；新增 `tests/windows-desktop/task-settlement.test.ts` 3 项（真实临时 Git 仓库）覆盖：接受后主目录快进、未跟踪与忽略文件按 SHA-256 归档、worktree/临时分支/归档引用处理、重复收整不重复执行；脏主目录记为待同步且用户文件原样保留；目录缺失且无归档记录时拒绝宣告完成。`tests/windows-desktop` 全量 TS 用例 179 项中 178 通过、1 项因未配置测试数据库跳过。未在真实桌面、真实 GitLab 与 Windows 实机验证本机收整。

## SC12 附件入口与资料状态（2026-10-22）

- 复用原生 `conversation.input.left` 工具栏插槽，附件按钮打开共用的资料面板；使用原生 dialog 管理焦点、关闭与 Escape。`MaterialConversation` 使场景与需求共用入口：会话未创建、恢复中或恢复失败时仍能打开资料，恢复完成后由输入区按钮承载，同一时刻只有一个入口；无关会话不展示。
- `ScenarioChatPanel` 删除原「资料与 AI 建议」折叠组中的资料入口，导入、状态、范围、重试与正式依据勾选全部迁入附件面板。旧建议 UI、开关和协议已由 SC14 删除；SC13 后续将身份与门禁信息归位并完成四态展示，当前色系未改。
- 抽取 `MaterialSources` 复用场景与需求的导入、读取、选择、归档和清理；沿用既有 `scenarios` 集合与 `scenario-sources/<project>/<entity>`，未新建本地集合。需求通过 `StudioState.materialSources` 获取去除提取正文的资料投影，会话使用同一来源内容与受控 `readPaths`。需求依据元数据写入复用原串行、expectedHash、冲突双份与持久 receipt 服务。
- 资料面板区分「正在导入」与 reader 返回的「正在读取／已读取／部分读取／读取失败」，展示实际范围与限制；PDF/Office 仍使用现有服务，图片只在原生 `read_image` 成功后更新状态，并校验当前设计占用、任务目录、已选资料与原始 hash。
- 已确认正式依据校验固定 `reading-*.json` 的 hash、来源身份和原始文件关联，恢复原格式、实际读取状态、范围与限制；缺失或损坏的记录明确显示无法验证，不再把固定 PDF 的部分提取标成完整已读。历史旧契约材料继续走原只读展示，不进入新投影。
- 需求编辑器接入现有 flush 边界：资料操作前先保存手工正文和元数据，格式校验或 Host 保存失败就停止资料操作并保留输入。本轮没有接入需求侧写入提议、整篇生成、摘要或撤销。

校验：`node apps/desktop-distribution/build/prepare-studio-plugin.mjs --dev-stage` 仅更新装配树后，Host/Client `tsc -b` 均通过。`node --test tests/scenario-client/*.test.mjs tests/scenario-client/draft-buffer.test.ts tests/scripts/studio-conversation-restoration.test.mjs tests/scripts/studio-task-purpose.test.mjs` 共 36 项全部通过；其中新增 `material-attachments.test.mjs` 12 项，覆盖入口会话隔离、弹窗关闭/取消、会话恢复全程唯一入口、读取状态与范围、导入失败、只读及手工编辑 flush，`studio-task-purpose.test.mjs` 补充保存失败阻止全部资料命令的验证。`apps/collaboration-api/node_modules/.bin/tsx --test tests/windows-desktop/*.test.ts` 共 183 项中 182 通过、1 项因未配置测试数据库跳过；新增需求资料生命周期、图片读取归属/hash 校验、固定读取记录和需求文档 CAS 测试，并修正恢复测试中缺少必填字段的材料元数据 fixture。`git diff --check` 通过。

验证边界：组件测试使用真实 React 与 jsdom，dialog 的浏览器原生聚焦/取消行为使用测试内 shim，不替代实机交互验收。未执行视觉审查、打包校验、真实企业 GitLab、双客户端、Windows 实机或真实模型验证。SC13 与 SC14 已完成；SC15 的 Linux 层验证记录于后文。

## SC14 删除旧场景建议链路（2026-10-22）

- 删除共享建议批次类型、建议与自动写入状态、`adoptScenarioSuggestions`/`setScenarioAutoWrite` 命令，以及 Host 的旧协议解析、字符范围应用、显式采纳和自动写入分支。
- 删除 `ScenarioSuggestions` UI、专属 CSS、仅覆盖旧批次协议/应用的 `scenario-suggestions.ts` 与相关用例，也删除只验证旧原生采纳按钮的 `work/validation/native-adoption/` 专用探针；更新会话提示词，去掉采纳建议措辞。`ScenarioDocumentService` 保留受控整篇保存与 hash 冲突处理。
- 未新增或删除本地状态集合；需求候选、独立评审、修复、资料附件路径不变。

校验：重新装配后 Typert 生成 31 个包；Host/Client `tsc -b` 通过。`tests/windows-desktop/*.test.ts` 共 180 项，179 通过、1 项因未配置测试数据库跳过；客户端与相关脚本共 41 项全部通过；活跃源码、测试与插件提示文件中的旧链路标识扫描无匹配。`git diff --check` 通过。

状态：SC14 与 SC13 已完成；SC15 Linux 层已执行，数据库/API 集成问题及真实协同双客户端、Windows 实机、真实模型验收仍未完成。

## SC13 页面精简与 SC15 Linux 验证（2026-10-22）

- SC13 已将场景编号/名称、模板固定版本、本地草稿或固定版本状态与审计时间放在正文上方；业务完整性、待澄清项和模板结构检查归入确认检查；Git 技术信息折叠在按需诊断中。Host 投影写入提议待回答、失败重试、已写入/已拒绝，以及草稿、待同步、待清理和本机收整完成四态。
- 装配树 Typert 生成 31 个包；Host/Client `tsc -b` 通过。contracts、asset-domain、collaboration-api 类型检查通过；collaboration-api 源码测试 92 项通过；客户端与脚本测试 41 项通过（含 3 项场景状态组件验证）；Host 测试 180 项中 179 项通过、1 项因未配置该套件数据库而跳过。Host 用例包含真实临时 Git 仓库上的快进、脏目录保护、归档和幂等收整验证。
- 首次数据库运行记录：`scenario-schema.test.mjs` 曾发现取消结果 CHECK 接受 NULL `failure_code`；`backend-lifecycle.test.ts` 曾因 `projectView` 查询已删除的 `studio_categories` 返回 503。问题处理及 PG17.10 复验见后文。
- 执行 `./start-backend.sh` 重建并重启协同 API；宿主机 `GET http://127.0.0.1:6972/health` 返回 `{"status":"ok"}`，容器状态 healthy。
- 未执行真实 GitLab、真实协同双客户端、Windows 实机、桌面视觉/打包或真实模型验收；SC15 整体未完成。分类路径与需求分类、一致性比较约束属于阶段二范围，本轮不扩展修改。


## PostgreSQL 17 数据库复验（2026-10-22）

- 使用本机共享 `pg17` 实例 PostgreSQL 17.10，在新建隔离空库运行 `scenario-schema.test.mjs`：11 项全部通过。取消对比记录的 CHECK 明确要求 `failure_code IS NOT NULL`，避免 NULL 产生 SQL UNKNOWN 而绕过校验。
- 清理项目投影、实体状态读取/保存中指向已删除 `studio_categories` 与 `studio_batch_freezes` 的 SQL；移除未由当前数据库结构支持的项目分类写入路由。
- 后端生命周期集成在项目初始化接受时失败：schema 要求 `studio_project_initializations` 与系统预置通用场景的第一条固定确认共同存在，当前 `Projects.initialize` 尚未写入该预置。`backend-lifecycle.test.ts` 前 6 个子用例通过，初始化及后续依赖其成功的检查失败；`backend-scenarios.test.ts` 同样在初始化失败。按阶段二范围记录，不通过删除约束来迁就未完成实现。
- contracts、asset-domain 与 collaboration-api 类型检查通过。

## 写入提议的围栏识别与失败提示（2026-10-25）

- 实机故障：场景会话连续三轮把提议 JSON 包在 `<eadp-write-proposal>` 标签里，而 Host 只按围栏行（三个反引号加 `eadp-write-proposal`）判断“是否有提议”，匹配不到就回落到纯聊天分支，于是界面既没有写入按钮也没有任何说明。原提示词只写“eadp-write-proposal 代码块”并给了一行 JSON 示例，从未给出围栏写法，模型按自己的习惯改用了标签。
- 协议提示词改为给出逐字围栏示例（起始行为三个反引号加 `eadp-write-proposal`，结束行为三个反引号），并明确禁止用标签代替围栏、围栏之后不再写文字；模型侧仍只提供结论、依据与整篇正文，提议 ID、hash、授权保持 Host 所有。
- `parseWriteProposal` 改为在回答任意位置定位唯一的代码块：允许块后继续有文字、允许 CRLF 换行；标签行在解析前规范成围栏，因此两种写法只有一条解析路径、同一套字段校验。JSON 无法解析时返回可重试的中文原因，不再把解析器原始报错抛给用户。
- 会话结束处理按“是否试图携带提议”分流：回答出现围栏行或标签就执行校验，失败即写入 `writeProposalError` 并显示“写入提议未生成”卡片，说明具体原因；纯讨论只在正文提到该名称时仍保持静默。下一次请求开始时清空上一条失败说明，避免与新回答并存。
- 代码：`host/application/scenario-write-proposals.ts`（块定位、JSON 失败提示、`hasWriteProposal`）、`host/application/scenario-workspaces.ts`（提示词、结束处理分流、清空旧说明）、`client/scenarios/ScenarioWriteProposalCard.tsx`（失败卡文案）。

校验：装配树 Host/Client `tsc -b` 通过；`tests/windows-desktop/scenario-write-proposals.test.ts` 与 `scenario-orchestration.test.ts` 共 35 项通过；`tests/scenario-client` 98 项通过。用实际会话日志中触发故障的原始回答回放解析（9 条结论、3216 字符正文），得到状态为待回答的提议。完整 `tests/windows-desktop/*.test.ts` 的两次运行分别为 287 项中 285 通过、2 失败与 282 通过、5 失败，失败集中在 `asset-workflow.test.ts` 与 `task-recovery.test.ts`：图片资料读取转换在未改动的基线上同样失败，其余单项单独重跑 3 次均通过并伴随临时目录 `EPERM` 重命名，属并行负载下的既有不稳定项，与本改动无关。未做真实模型、界面视觉或安装包验收。

## 写入只写本地，后台留在确认（2026-10-25）

- 实机故障：提议生成与「写入」都要先读后台项目状态，GitLab 短暂不可达时后台返回 `GITLAB_UNAVAILABLE`，对话区只显示“协同后端暂时无法访问 GitLab，请稍后重试”，本地草稿并未写入。按用户决定，写入本地文件不应依赖后台，提交与远端口径留到确认。
- 责任边界复核：后台不写项目仓库，GitLab 写操作只有创建仓库与分配成员两项；固定候选的提交在本机任务工作树完成、由 Host 推送并快进稳定分支（`GitIntegrations.publish`），后台只读 GitLab 校验提交、对比与文件后记录集成与确认（`modules/integration.ts`）。
- 写入路径改为只用本地状态：`accept` 从会话所属材料的当前修订任务读取本地 Markdown 与 `CONTEXT.md`，用提问时记录的 `draftHash`、模板固定引用、上下文 hash 与依据集合判定过期；提议记录新增 `taskId`，只有该任务仍是本地当前任务时才允许写入。`resolveWriteProposal`、`undoWrite` 与 `CONTEXT.md` 目标写入不再调用后台实体、占用或认可头接口，仍以 `expectedHash` 作 CAS 整篇写本地文件，并保留写入回执、变更摘要与撤销。
- 后台边界移到确认：设计占用、模板绑定、期望基线头、提交与推送、后台接受仍由材料确认执行；差异对比与主检出同步发生在确认之后。后台占用变化、模板重绑或项目上下文被其他已确认版本推进，因此不再在写入时拦截，而在确认时按对应错误返回，本地写入结果保留。
- 删除随写入路径失效的 `writeProposalOccupationKey` 与请求上下文里的占用键；提问侧 `context()` 仍要求当前占用，保持“先取得编辑权才能继续设计”。
- 场景草稿保存同样只写本地文件：不再为标题/摘要改动调用后台实体更新接口，后台实体的标题、摘要与关系在确认时从已提交材料取回（`modules/integration.ts` 的确认投影）。需求保存仍按原流水线写关系与目录，因为需求来源与前置关系是协同数据，由后台校验。
- 代码：`host/application/scenario-workspaces.ts`（`liveTask`、`localMaterial`、`save`、`accept`、`consumeWriteProposal`、`resolveContextProposal`、`undoWrite`）、`shared/scenarios.ts`（提议记录增加 `taskId`）。

校验：装配树 Host/Client `tsc -b` 通过；`scenario-write-proposals`、`scenario-orchestration` 与 `requirement-workspaces` 共 50 项通过；`tests/scenario-client` 98 项通过；完整 `tests/windows-desktop/*.test.ts` 289 项中 286 通过、3 失败，三项均为既有环境或并行负载不稳定项：`asset-workflow` 的图片资料读取转换在未改动的基线上同样失败，`requirement-confirmation` 的目录失败恢复与 `task-recovery` 的持久输出重放单独重跑均通过（后者连续 3 次通过），并伴随临时目录 `EPERM` 重命名。新增用例覆盖后台实体与占用接口不可用时仍生成提议、写入、撤销与场景草稿保存；需求侧把提议过期条件收敛为正文、依据与 `CONTEXT.md` 三项本地输入，原先“占用变化即作废”与“按后台模板绑定拒绝写入”的断言按新边界改写。界面状态仍依赖后台项目投影（列表、门禁、只读判定），同步失败时面板可能显示联动错误，但本地文件与提议状态已落盘，后台恢复后可见。未做真实模型、界面视觉或安装包验收。

## 场景与需求 AI 本轮问题（2026-10-25）

- 为场景与需求会话增加同一份 `eadp-material-questions` 回答协议。Host 校验实体身份、实际已读依据以及当前正文 hash、模板固定引用和项目上下文；Host 生成问题轮次标识并将最新轮次保存在现有材料状态中。问题块与写入提议互相独立，可同轮出现；回答选择不修改 Markdown、不代表业务已澄清，也不改变确认门禁。材料上下文变化后问题仅供回看，后续 AI 轮次会撤下旧轮次。
- 在 DSH 原生 `conversation.input.dock` 展示问题选项。用户可选择多项并通过 revision-guarded `insertText` 插入当前草稿，再自行发送；选区非折叠或输入版本过期时不插入，不自动发送，也不替换整份草稿。问题依据使用已读资料名称显示，场景与需求复用同一组件。
- 对齐 AI 交付信息：写入提议列出它实际引用的资料及读取范围，不再用当前选中资料数量代替提议依据；需求候选出处明确标为创建时的历史来源，并与当前正式来源关系区分；确认场景的拆分入口在未延后时直接显示，联合候选卡可显示其全部来源场景。
- 需求 AI 优化稿的演示交互同步为“选择 → 插入草稿 → 用户发送”：选择不再永久锁定选项、不自动标记已澄清或减少确认门禁；待澄清状态仍由材料内容决定。场景/需求设计文档同步记录共享契约及状态边界。
- 代码：`host/application/material-decision-questions.ts`、`host/application/scenario-workspaces.ts`、`shared/scenarios.ts`、`client/components/MaterialDecisionQuestions.tsx`、`client/components/MaterialConversation.tsx`、两类工作区与 DSH dock 注册；增加解析器、Host 状态投影和原生输入插入保护用例。

校验：`node apps/desktop-distribution/build/prepare-studio-plugin.mjs --dev-stage` 成功；装配树 Host/Client `tsc -b` 通过；`tests/scenario-client/*.test.mjs` 93 项全部通过；本轮问题解析 3 项、Host 问题与需求会话 2 项、场景拆分/恢复 8 项，以及需求候选/来源/工作区/保存/确认 58 项全部通过。需求 Host 聚焦组首次默认并发运行时，删除文件恢复用例一次失败；该用例单独重跑通过，之后串行重跑整组 58 项全部通过。`check:repository` 显示 416 个受跟踪文件与 49 项模板 hash 一致；`git diff --check` 与优化稿内联脚本语法检查通过。配置装配树 runtime 和实际 Git CGI backend 后，`studio-workflow.test.ts` 的 loopback Git Smart HTTP 用例 1 项通过；Host/API/PostgreSQL/Git 完整协作链仍因没有可用 PostgreSQL 测试实例而跳过，不能作为集成验收。未做真实模型与 DSH 桌面视觉验收。


## 2026-10-26 场景确认仅检查流程完整性

用户已确认场景与需求的粒度边界：场景确认触发条件、角色、主要路径、必要分支与业务结果是否完整；金额审批阈值、字段口径、计算规则及可执行验收细节留到需求确认。资料与引用只提醒，不作为场景业务确认门禁。

- 场景契约改为 `flowComplete`，删除场景旧的 `coreRulesPresent`、`acceptanceCriteriaPresent`；不增加兼容字段或迁移。需求保留原质量与依据校验。
- Host、领域与后台从固定材料检查流程完整声明及流程阻断问题。确认面板提供流程声明，新增场景待澄清项默认不阻断；AI 提示词按相同粒度提问和修复，可使用当前正文及用户明确答案，不强制上传附件。
- 无正式资料的普通场景可以确认并拆分需求；普通／内置场景按严格身份契约区分，不再以依据数量识别。需求候选仍绑定场景固定版本及实际原文片段。
- 资料检查增加提醒状态；坏引用不能冒充有效固定资料。面板允许显式移除无法验证的正式引用，经原有 hash 保护保存并重读后确认；本地导入资料不因此删除。固定提交继续校验声明文件的路径、hash 和引用范围。
- 局部验证：场景 Host 五文件 75 项、客户端组件 95 项、草稿与需求回归 63 项、固定 Git 内容及后台集成逻辑 52 项、相关 Host 认证／候选／来源 37 项通过；最终 Studio 装配树 `tsc -b` 通过，场景日志为 `.local/scenario-flow-tests.log`。扩展 Host Git 工具检查有 3 项因缺少 `.local/build/studio-tools-prepared/runtime-manifest.json` 失败；任务恢复 30/31，另一次 `restoreSession` 捕获 Windows `EPERM` 原子 rename 失败；需求原生图片读取测试仍得到 `failed` 而非 `read`，未定位为本次变更导致，亦未据此宣称全部回归通过。
- 真实桌面 UI、真实模型、指定 `100.119.183.44` 协同服务、Git／持久化及中断恢复闭环均未验收；本轮未部署远端服务或生成新安装包。


## 2026-10-26 内置通用场景仅在新增需求时可选

用户明确：内置通用场景不显示、不编辑，只在新增需求时可选择。

- 场景目录、统计、搜索、分页和其他选择入口排除内置场景；新增需求保留“通用场景 · 系统内置”选项。
- 既有需求仅保留静态归属标识，不展示通用场景正文、不提供跳转或编辑入口。隐藏选择项时仍保留已有关联及固定版本，不删除真实系统预置身份或来源记录。
- Host 及后台现有不可编辑保护保持；即使直接传入内置场景 ID，也不能打开工作区或取得编辑占用。相关直达 ID 与投影回归、来源及候选验证 11 项通过。
- 客户端组件检查 99/99 通过，覆盖目录数量／搜索／分页隐藏、新增需求选中真实通用来源、关系编辑保留固定来源及显式移除；最终 Studio 装配树类型检查通过。上述为实现与局部验证记录，真实桌面及指定协同服务闭环未验收。
