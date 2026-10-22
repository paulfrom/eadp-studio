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
