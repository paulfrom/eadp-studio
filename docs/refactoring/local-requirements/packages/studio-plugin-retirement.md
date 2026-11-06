# studio-plugin 拆分与退役

状态：退役计划，旧源码尚未删除。新结构见 [architecture.md](../architecture.md)；切片见 [implementation.md](../implementation.md)。

## 1. 当前职责

- `host/index.ts`：`StudioService extends TypertRemoteService`，用巨型 `command/progress` 暴露全部业务；拦截原生 prompt/control 准入。
- `host/composition.ts`：228 行，同时装配协同认证、远端 API、Git、任务、材料、原型检查/预览/发布、DSH 会话、桌面浏览器运行时。
- `shared/studio.ts`：包含场景/需求/一致性/原型/基线/交接/任务/候选的投影与命令联合。
- `client/index.ts`：`main` 面板、侧栏行、会话输入槽、7 个设置节。
- `application/`：`studio.ts` 1,050 行调度；`prototype-collaboration.ts` 约 109 KB；`requirement-saves.ts` 远端三阶段；`material-confirmations`、`scenario-*`、`requirement-*`、`prototype-*`、Git/审查/一致性/交接等。

本轮不是把单体改名为 shell。删除旧包是最终步骤；必要实现分别归 requirements、prototype、knowledge、Shell 或发行层，不能保留隐藏的 StudioApplication 作为新包总后台。

## 2. 迁出与删除

| 当前位置（相对 `src`） | 处理 |
| --- | --- |
| `client/studio`、`client/topbar` | 仅保留可复用布局/项目入口方向，重写到 shell；删除五阶段导航、任务轮询、场景/基线/交接入口 |
| `client/components/MaterialEditor.tsx`、`client/requirements` | 抽取 textarea 编辑/离场保护到 requirements；删除 metadata/模板/来源/候选/门禁/确认 |
| `client/components/NativeConversation.tsx`、`client/session.ts` | 保留原生会话承载方向；删除远端投影/任务身份/旧 restore 命令 |
| `client/prototype/*` | 抽取只读文件/运行/日志布局到 prototype；删除画布/嵌入预览/队列/候选/复用/自动验收 |
| `client/settings/sections.tsx` | 删除协同账号/连接/场景模板/需求模板/项目位置/外观自定义；使用原生设置 |
| `host/index.ts`、`host/composition.ts` | 拆除协同/Git/浏览器/发布；Shell 只保留 Workspace 会话策略/活动文档/生命周期；各包用自己的 Remote 命名空间 |
| `host/adapters/dsh/sessions.ts` | 保留会话创建/恢复/prompt 去重/技能挂载经验；删除 TaskView/工作树/场景/基线身份 |
| `host/adapters/dsh/native-prompt-admission.ts` | 新方案不拦截原生 prompt；删除及对应 build 锚定编辑，除非有新的登记理由 |
| `host/application/requirement-saves.ts` | 删除远端三阶段/占用/revision/idempotency；改为本地 `ctx.fs` 条件写 |
| `host/application/scenario-write-proposals.ts` | 删除聊天代码块协议；改为结构化提案工具 |
| `host/application/material-write-changes.ts` | H2 章节差异可参考；新需求用行级 diff |
| `host/application/requirement-sources.ts`、`requirement-candidates.ts`、`scenario-*` | 删除来源/候选/拆分/确认/场景模板/证据/修复调用 |
| `host/application/prototype-collaboration.ts`、`prototype-candidates.ts`、`prototype-integrations.ts`、`prototype-baseline-workspace.ts`、`prototype-material-context.ts`、`prototype-requirement-identities.ts`、`prototype-runtime-repair.ts` | 删除任务/候选/基线/发布/修复/协同整合；不迁移 |
| `host/application/remote-merges.ts`、`candidate-merges.ts`、`fixed-candidates.ts`、`reviews.ts`、`consistency-*`、`handoff-*`、`background-lane.ts`、`task-maintenance.ts` | 删除 |
| `host/adapters/collaboration/*`、`workspace/git.ts`、`workspace/prototype-merge.ts`、`workspace/snapshot.ts` | 删除协同/Git/合并/快照 |
| `host/adapters/publication/ssh-target.ts`、`remote-runner.ts`、`prototype/publication.ts` | 删除 SSH 发布/撤回 |
| `host/prototype/preview.ts`、`checks.ts`、`generation.ts`、`check-journal.ts`、`build-workspace.ts`、`snapshot.ts` | 删除 synthetic preview/检查/构建证据/基线；保留受管进程原语到 prototype |
| `host/adapters/dsh/browser-*`、`prototype-canvas.ts`、`prototype-browser-tools.ts`、`prototype-runtime-tools.ts`、`prototype-material-tools.ts`、`prototype-requirements.ts`、`browser-check.ts` | 删除浏览器/画布/自动验收/原型专用工具；需求/知识工具换成新包 |
| `host/adapters/platform/execution-guard.ts` | 抽取受管 Agent 读写边界/路径原则到 shell/requirements/prototype；删除场景/任务/路径锁耦合 |
| `host/adapters/platform/credentials.ts`、`activity-log.ts`、`path-write-lock.ts` | 无协同/发布密钥后删除 credentials；日志/写锁按需抽取 |
| `host/adapters/local-state`、`application/state.ts` | 删除账号/任务/项目快照模型；只保留必要 UI 偏好/日志（若仍需要） |
| `shared/*` | 随调用方删除场景/确认/基线/交接/任务/候选/原型协同类型；新合同进 contracts |
| `assets/prototype-template`、`assets/skills`、`locale` | 模板移到 prototype；技能按新 persona 复核；locale 去场景/交接文案 |
| `cordis.patch.yml` | 删除 `eadp-scenario`/旧 `eadp-requirement` persona 与 `studio-plugin` 行；新包各自 patch |

路径指职责组；实施时先查实际文件与调用方，不以文件名前缀作为唯一删除依据。

## 3. 模块化原则

- 先抽取稳定窄合同，再移动实现；禁止把旧 StudioApplication 拆进多个包并通过跨包回调保留全部旧状态。
- 功能包不互相导入内部 application/store/components；通过 contracts、官方 slot、客户端服务、Host 远程命名空间协作。
- 原型/需求/知识各自拥有 Host 服务；Shell 只做 Workspace 会话策略与 UI 组合。
- 不保留旧 `StudioCommand` 总线、旧 Typert `studio` 命名空间或旧 API 空实现。

## 4. 实施步骤

1. 建立最小 contracts 与 Workspace 会话骨架；打通项目/需求/原型/知识最小真实视图。
2. 逐切片替换旧调用方；旧包只在开发期暂存，最终发行不加载双套实现。
3. 重接原生会话上下文：只传项目/路径/版本等必要信息，不保留任务 ID 映射层。
4. 新包真实桌面行为成立后，删除旧 command 分支、状态、资源、设置、locale、配置。
5. 清除 package.json、workspace 锁、发行装配、准备脚本、模板路径、说明中的旧包依赖；最后删除旧目录。
6. 更新 `pnpm check` 目标；运行检查、构建、最终安装包验证。

## 5. 验收

最终安装包不含 studio-plugin/asset-domain/collaboration-api；普通文件打开/编辑、原型运行、知识检索无需旧服务初始化；无协同请求、隐藏旧队列或旧状态恢复。原生历史仍可读取，模型凭据不被清除。验证中文输入、会话恢复/取消、迟到回包、项目切换/搬移、进程退出；确保拆包没有造成权限扩大或内容丢失。

以上尚未执行。
