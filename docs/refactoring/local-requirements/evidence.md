# 证据、基线与待核实项

状态：设计取证，2026-11-05。本文只记录可核对事实、参考模式、宿主接口与未决项，不表示新实现已完成。方案入口见 [README](README.md)。

## 1. 基线与工作区状态

| 项目 | 事实 |
| --- | --- |
| EADP 仓库 HEAD | `62d896d15edf0cf39f2a4ba549190dbfdbc01066`；提交说明“修正交互逻辑” |
| 工作区 | `README.md` 已修改；`docs/refactoring/` 未跟踪；`docs/` 下旧设计/ADR/`blocked-upstream.md` 等为删除状态（`D`）；产品源码未改 |
| 固定 DSH | `apps/desktop-distribution/release.lock.json` 锁定 `687f282e8625c6b8d11ff58211a90524be2e4317`，`@deepseek-ai/dsh-root` `0.2.1-rc.2` |
| 上游源码缓存 | `.local/upstream/dsh/`，无 `.git`，只能按 `package.json` 版本与 `release.lock.json` 对账；不是维护源码 |
| Editor 参考 | `D:/project/skills/dsh-editor`，HEAD `52450c6a0235d9bf07654d3fecf15f071ce45599`，工作树干净 |
| Editor 宿主版本 | **DSH 0.2.1-rc.5**；另有 3 个锁死 rc.5 的上游补丁；不能把其代码当作 EADP rc.2 已支持 |
| 仓库检查 | `pnpm check` 在完整访问下通过：396 个跟踪文件，48 个模板哈希匹配，`releaseReady=false`。沙箱内的管道限制会使 `spawnSync git` 报 EPERM，属执行环境问题 |

本轮只完成方案与文档，不修改产品代码，不提交、推送或发布。实施前必须重新记录 HEAD 和工作区变更，不能沿用本文的干净/未跟踪状态作为未来事实。

## 2. 已确认的产品目标

来自用户本轮范围，均可直接作为验收依据：

1. 用户创建、打开、重新打开本地项目；不需要登录、协同后端或 Git。
2. 一个项目包含多份需求 Markdown 和一个普通原型代码工程。
3. 用户直接编辑需求；AI 读取需求、提出修改，用户审阅后应用。
4. AI 根据一份或多份需求修改原型；用户查看文件、运行、停止，并在系统浏览器操作页面。
5. 固定知识库随应用发行，为需求与原型提供只读参考和可追溯出处；用户可按自己的情况新增/修改本机知识库，AI 可提议、用户确认写入。
6. 继续复用 DSH 的会话、模型、授权和设置，不自建另一套 Agent、模型注册或权限系统。
7. 删除场景、材料确认状态、开发认领、协同任务队列、候选集成、基线、交接、复用采用、协同登录与远程后端。
8. 删除过时实现；不保留兼容层、migration、旧 API 模拟或 fallback；保护唯一未提交成果和活动任务。

## 3. 当前实现事实

### 3.1 规模与入口

| 位置 | 事实 |
| --- | --- |
| `packages/studio-plugin/src` | 159 个 ts/tsx，17,314 行；host 86 文件/12,484 行，client 66/4,447，shared 7/383 |
| `host/composition.ts` | 228 行；同时装配协同认证、远端 API、Git、原型检查/预览/发布、DSH 会话、桌面浏览器运行时 |
| `host/index.ts` | `StudioService extends TypertRemoteService`，`@Remote command/progress`；注册 `session/prompt-admission`、`session/control-admission` |
| `shared/studio.ts` | `StudioState` 含 scenario/requirement/consistency/prototype/baseline/handoff/tasks/candidates；`StudioCommand` 是巨型联合 |
| `client/index.ts` | 注册 `main` 面板、`sidebar.panellist`、两个会话输入槽、7 个 `settings.section` |
| `application/studio.ts` | 1,050 行命令总调度；`application/prototype-collaboration.ts` 约 109 KB |

### 3.2 需求编辑与提案

- 当前需求保存 `host/application/requirement-saves.ts` 是远端三阶段：relations → document → directory，带 occupation/revision/idempotencyKey；不是本地条件写入。
- 客户端自动保存与外部改动由 `client/scenarios/DraftBuffer.ts`（800 ms 防抖、in-flight 串行、外部版本、撤销）和 `useDraftBuffer.ts` 承担；`MaterialEditor.tsx` 是场景/需求共用的 textarea 表单。
- AI 提案由 `host/application/scenario-write-proposals.ts` 解析聊天中的 `eadp-write-proposal` 单块 JSON，`material-write-changes.ts` 做 H2 章节差异；提案身份、模板、占用由 Host 校验。
- 需求/场景预设（`cordis.patch.yml`）把 `tool-fs` 配成 `write:false, edit:false`；原型预设才注册写入工具。
- `host/adapters/platform/execution-guard.ts` 已实现受管 Agent 工具边界：工具名白名单、`readRoot`、可写路径/前缀、受保护路径、`spawn_agent` cwd 校验、子 Agent 继承、写入前重新核对授权。
- `host/adapters/dsh/sessions.ts` 用 `ctx.agents.create/resume`、`agentPreset`、`systemPrompt.context/section`、bundled skills、`sessionQuery.filterSessions([{kind:'cwd'}])`；当前 `create` 的 cwd 是 Git 任务工作树。

### 3.3 原型与旧链路

- `host/prototype/preview.ts` 运行 `pnpm run preview -- --port <p> --instance <id>`，轮询模板自建的 `/__eadp_preview_ready`，要求 `synthetic-only`、`dist`、实例 ID；这不是新目标要的开发服务器。
- `host/prototype/files.ts` 有路径校验、敏感文件过滤、扫描限额、分页与写锁；但绑定 template manifest 与 writablePaths。
- `host/adapters/platform/runtime.ts` 是受管进程原语：manifest 校验、白名单环境、PATH 隔离、超时/输出上限、启动/停止。
- `host/adapters/platform/execution-guard.ts` 的 `coordinateStudioToolWrite` 用 `tools/execute` 与 path lock 协调编辑器/AI 写入；新方案可直接依赖 `ctx.fs` 的每目标锁，无需保留该层。
- 旧原型包含 `playwright-core 1.61.1` + 固定 Chromium、内嵌 `WebContentsView` 画布、`studio-prototype-bridge/view`、自动浏览器检查、候选/基线/发布与 Git worktree。
- `host/adapters/workspace/git.ts` 41.9 KB，含建仓、克隆、推送、worktree、合并、冲突处理；目标不保留应用管理 Git。

### 3.4 契约、领域与后端

- `packages/contracts/src/index.ts` 31.9 KB，含场景/确认/基线/交接/协同身份/API schema；`ProjectDirectories` 固定 `场景/需求/交接/原型代码`。
- `packages/asset-domain/src/index.ts` 约 11 KB，管理材料路径、强制元数据、确认校验与 Git 合并策略。
- `apps/collaboration-api`：Fastify + PostgreSQL + Redis + GitLab 成员权限；`routes.ts` 约 40 条路由，`service.ts` 46 KB，`repository.ts` 45.6 KB，`db/schema.sql` 99 KB、约 40 张表。
- `apps/desktop-distribution/build/`：大量 fail-closed 锚定上游编辑，包含协同访问策略、秘密 IPC、原生消息准入、浏览器运行时、模板归档、打包适配等。

### 3.5 检查、构建与空目录

- 根 `pnpm check` 只做仓库静态校验：Node 版本、origin 必须是 `git@github.com:paulfrom/eadp-studio.git`、禁止跟踪 `.local/`/`node_modules`/密钥、模板 manifest 48 条 sha256 与 Git 跟踪一致、`.env.example` LF、`.local/probe` 被忽略。它不跑类型检查、不跑测试、不联网。
- `pnpm build:desktop` 走 `scripts/build-desktop.mjs`：构建锁、冻结安装、`fetch-dsh`、`prepare-studio-plugin --stage-only`、树内安装、官方 `package:desktop:win:x64:unsigned`；`--browser-runtime` 依赖预置的浏览器 zip。
- `tests/` 目录存在但 0 个文件；仓库不保留测试代码或测试命令。
- `scripts/fetch-dsh.mjs` 只认 `release.lock.json`，拒绝替代源；`release.lock.json` 的 acceptance 仍为 `releaseReady=false`。

## 4. 可复用的 Editor 模式（机制，不是代码）

| 模式 | Editor 事实 | EADP 采用方式 |
| --- | --- | --- |
| 项目 = DSH Workspace | `root-workspaces.tsx` 用 `ctx.workspaces.create({path})`、`ctx.uiWorkspace.openWorkspace`、`ctx.workspaces.delete`；`WorkspaceView` 含 workspaceId/path/title/sessionIds | 直接采用：项目身份 = WorkspaceId，目标目录 = Workspace.path；不自建项目注册表 |
| 路径规范化与别名 | `workspace/tool.ts` 的 `realpathNormalize` 是唯一 canon；`resolveByPath` 按 canonical path 复用登记 | 采用：同一真实目录（含大小写/链接别名）复用同一 Workspace |
| 版本条件写入 | `rpc/files.ts` 的 `writeTextFile(..., {replaceIfVersion}, expectedVersion)`；`proposal.ts` 应用前重读版本、唯一原文匹配 | 机制采用；EADP 直接用固定宿主 `ctx.fs.writeText(..., {kind:'replaceIfVersion'})`，不复制 Editor RPC |
| 离场保存 | `save-before-leave.ts` 保存前后核对 composing/conflict/身份/实时输入；await 后 typing 返回失败 | 采用其顺序；EADP 的编辑器无 Editor 的 CodeMirror 冲突模型，保留 IME/草稿/版本核对 |
| 草稿定时器 | `draft-sync.ts` 只管理未触发的 setTimeout，不能取消已发出的保存 | 采用：UI 定时器不等于在途保存；在途保存单独等待 |
| 会话内重解析范围 | `internal-workspace-access.ts` 从 `exec.agent.session.id` 取 sessionId，在写队列内再次解析 root.targetKey | 采用“范围来自真实执行会话、写入前再核对”的原则；EADP 用 Workspace.path + 真实 session cwd |
| 元数据目录链接检查 | `metadata-io.ts` 逐段 lstat、realpath、isInside、临时文件 + rename | 目标不引入 `.eadp` 元数据；保留对项目路径的 realpath/containment 原则 |
| 显式扩展合同 | `seats` 只定义类型/命令/座位上下文，壳层组合 | 采用显式 slot/service 合同；不复制其小说/写作业务 |
| 知识卡形态 | `dsh-editor-novel-kernel/resources/novel-knowledge/`：11 张 Markdown 卡 + `SOURCES.md`（知识资产版本 2）；`novel_knowledge` 工具固定主题白名单、1–3 张、单卡 ≤ 6000 字符、只读；`knowledge-only` 模式只注册该工具；描述明确“advice 不是事实/权限” | 采用“少量人工整理卡 + 来源/版本 + 只读读取 + advice 边界”；EADP 增加用户知识库与 AI 知识提案（用户确认写入），Agent 不能直接写 |
| 目录搬移 | `relocateWorkspace` → `openPickedWorkspace(path,'open',oldId)` → 新建 Workspace → 校验新目录有可读内容 → 打开后删除旧登记；删除失败只警告；旧会话不迁移 | 采用同样流程；EADP 校验 `需求/`/`CONTEXT.md`/`原型/` 至少一个可识别内容，避免选错空目录 |
| 项目记忆 vs 固定知识 | `.dsh-editor` 记忆/世界书/人物卡由 `novel_memory_update` 带 expectedVersion/evidence 直接写；固定知识卡只读 | 不把知识卡当项目正文；EADP 的 CONTEXT 仍走用户提案；用户知识库支持用户维护 + AI 提议、用户确认写入，Agent 不直接写 |

**不能照搬**：Editor 绑定 rc.5；其 3 个补丁锁死 rc.5；其私有 `/manuscript`、`/dsh-editor-workbench` RPC 自建传输；其 root 遮蔽 AppFrame 是固定版本专用接缝，不是受支持的替换接口。EADP 继续用官方 `main`/`sidebar.panellist`/`settings.section`/`conversation.*` slot、Typert Remote 和官方服务。

## 5. 固定 DSH rc.2 宿主接口（已核实）

### 5.1 Workspace

- `packages/workspace/workspace/src/index.ts`：`WorkspaceRegistry` 持久化 `WorkspaceRecord{path,title,sessionIds,createdAt,updatedAt}`；`create(path)` 先 `realpathNormalize`，同 canonical path 复用；`resolveByPath`、`get/list/delete`、`initializeDefault`。
- `packages/workspace/workspace/src/types.ts`：`WorkspaceId` 是生成的 UUID，不是路径；`Workspace.path` 是 create 时的 canonical realpath，之后不改写。
- `packages/workspace/workspace/src/paths.ts`：`realpathNormalize` 解析尾部斜杠、`..`、符号链接；相对路径在 realpath 前拒绝；不存在的路径报 ENOENT。
- `packages/workspace/workspace/src/entity.ts`：`attachSession` 要求 session header cwd 的 realpath **等于** workspace.path；不匹配拒绝。**没有跨 Workspace 搬迁会话的接口。**
- `packages/api/workspace-controller/src/index.ts`：`WorkspaceController` 暴露 `create/rename/delete/insertBefore/archiveSession/...` 与 `follow` 流；`WorkspaceCommands.create` 先 `resolveByPath`，再 `create`。
- `packages/api/workspace-controller/src/types.ts`：`WorkspaceView{workspaceId,path,title,sessionIds,createdAt,updatedAt}`；`WorkspaceCreateRequest{path}`；错误 `workspace/invalid-path`、`workspace/name-conflict`、`session-active`。
- `packages/bundle/base/package.json` 与 `packages/bundle/web-app/package.json` 已包含 `dsh-api-workspace-controller`、`dsh-client-ui-workspace`；desktop 的 web profile 通过 bundles 加载。

### 5.2 会话与工作区绑定

- `packages/api/session-controller/src/types.ts`：`SessionCreateRequest{workspaceId? | cwd?, sessionId?, agentPreset?}`；`workspaceId` 与 `cwd` 互斥。
- `packages/api/session-controller/src/commands.ts`：`cwd = workspace.path ?? request.cwd ?? process.cwd()`；创建成功后 `workspace.attachSession()`；直接 `agents.create` 的会话若不 attach 则显示为 Ungrouped。
- `packages/core/agent/src/index.ts`：`CreateAgentOptions{meta:{cwd,agentPreset,...}, seed, agentOptions, setup}`；`ResumeAgentOptions{resumeSessionId, setup}`；setup 在发布前组装该会话的世界（工具/提示/监听）。
- `packages/session/session-query/src/index.ts`：`filterSessions([{kind:'cwd', values:[path]}])` 可按精确 cwd 查找持久会话。
- `packages/session/working-directory/src/index.ts`：会话中途 `cd` 只改 workingDirectory 投影，不改 `header.cwd`、sandbox 写根或 Workspace 归属。
- 持久化：`$DSH_HOME/sessions/<projectKey(cwd)>/<sessionId>/session.vN.jsonl(.zstd)`；按 cwd 分目录，不随 Workspace 注册表搬移。

### 5.3 文件系统服务（`ctx.fs`）

- `packages/fs/fs/src/types.ts`：`FsTarget{targetKey,displayPath}`；`FsVersion` 是不透明版本；`FsWriteIntent = createIfAbsent | replaceIfVersion`；`FsErrorCode` 含 `FS_STALE_VERSION`/`FS_NOT_OBSERVED`/`FS_SANDBOX_DENIED`/`FS_NOT_TEXT` 等。
- `packages/fs/fs/src/index.ts`：`resolve(path,{cwd,signal})`、`contains(parent,child)`、`stat`、`readText`、`listDir`、`watch`、`writeText(target,content,expected?,signal?,sandboxPolicy?)`、`editText(...)`；`writeText`/`editText` 的 sandboxPolicy 由后端执行。
- `packages/fs/fs-local/src/index.ts`：每 `targetKey` 一把读-改-写锁；`writeFileAtomic` 临时文件 + rename；`replaceIfVersion` 比较版本后才写；`createIfAbsent` 对已存在文件报 `FS_NOT_OBSERVED`；`cwd` 是解析默认值，不是 containment 边界。
- `packages/fs/fs-sandbox/src/index.ts`：`workspace-write` 时按 `sandboxPolicy` 的可写根重新 canonicalize 并 containment；`read-only` 拒绝一切写；`danger-full-access` 不栅栏；**读全部放行**。
- `packages/sandbox/sandbox-policy/src/index.ts`：`resolve({session})` 的 `workspaceRoot = session.header.cwd`；`SandboxPolicyRequest` 只有 `{session,mode}`，没有额外/更窄根。
- `packages/sandbox/sandbox/src/roots.ts`：`workspace-write` 可写根 = workspaceRoot + `/tmp` + `os.tmpdir()`，全部 canonical。
- `packages/fs/fs` 没有 `mkdir/rename/unlink` 抽象；目录创建、重命名、删除只能由 Host 在 containment 校验后用 Node fs 完成（见缺口）。

### 5.4 工具、守卫与沙箱

- `packages/core/tools/src/index.ts`：`ToolGuard` 是 `tools/pre-execute` 与审批之后执行的单调拒绝函数；返回字符串即拒绝，返回 `undefined` 不改变；guard 无 allow 结果，不能被后续监听器翻回允许；全局 guard + agent scope chain，先到先拒。
- `ctx.tools.guard(guard)` 在普通 ctx 上全局生效；在 `agent.ctx` 上只对该 agent 生效。`ctx.tools.restrict({allow,deny})` 必须在 `agent.ctx`。agent scope 注册的工具只对该 agent 可见。
- `tools/execute` 钩子只能替换 signal，不能改写参数；`pre-execute` 决策只有 allow/deny/cancel/ask，也不能改写参数。因此路径白名单必须在 guard 中按参数判定。
- `packages/fs/tool-fs/src/index.ts`：`read/write/edit` 等工具按配置注册；`write`/`edit` 把 `sandboxPolicy.resolve({session})` 传给 `ctx.fs`。
- `packages/sandbox/sandbox-local/src/index.ts`、`sandbox-windows-acl/src/index.ts`：shell 进程的 OS 沙箱；Windows ACL 主要限制写，读/网络/进程可见性不受限；`workspace-write` 只发 workspace root 的写权限。
- `packages/subprocess/src/types.ts`：`SpawnRequest` 只有 command/cwd/stdio/env，没有 sandbox 字段。插件自建进程不受 DSH fs/shell 沙箱约束。
- 出厂 `packages/bundle/base/cordis.patch.yml` 默认 `workspace-write`、root 兜底为 `process.cwd()`；EADP 未覆盖 `DSH_PERMISSION_MODE`。

### 5.5 客户端扩展、Typert 与设置

- 官方 slot：`main`（keyed）、`sidebar.panellist`、`settings.section`、`conversation.input.left`、`conversation.input.dock`、`conversation.chat.node`、`tool.call.toolview`、`shell.bottom`、`rightbar`。
- `ctx.layout`、`ctx.uiWorkspace`（`openWorkspace/connectWorkspace/startSession/pickDirectory/listDirectory/createDirectory`）、`ctx.sessions.retain`、`ctx.workspaces`（client）均为官方公开接口。
- `TypertRemoteService(ctx, key, {namespace})` + `@Remote`；契约由构建期生成物固定；EADP 当前 `host/index.ts` 的暴露方式属官方支持；改签名须重跑生成器。
- `defineTool` 必须提供 `output.schema` 与 `output.render`；对象 schema 显式 `additionalProperties`；必填字段 `required: true`，无 required 数组/`required:false`。
- `ctx.settings` 的权威存储是 profile 的 `cordis.patch.yml`；模型选择用 `ctx.agentDefaultModel` + 会话 `modelSelection` 投影；凭据用 `ctx.credentials`（文件型，不是 OS 密钥链）。
- `ctx.approval.request()` 必须在已开启 turn 内；插件可注册 `approval/request` waterfall 作为 answerer，但不能绕过策略，也没有“自建审批”接口。
- `systemPrompt.section/context` 可在 `agent.ctx` 注册动态上下文；`agent-instructions` 自动发现 cwd 上溯的 AGENTS.md/CLAUDE.md；插件不能注入文件型指令。
- 桌面：`apps/desktop` → `apps/desktop-host` → `runProfile({profile:'desktop'})`；`DSH_HOME=%USERPROFILE%\.eadp-studio`、userData `%APPDATA%\eadp studio`；品牌编辑在 `build/desktop-brand-edits.mjs`。

## 6. 宿主缺口与待核实项

### 6.1 已确认缺口（须登记仓库缺口清单；当前 `docs/blocked-upstream.md` 缺失，见 README 第 6 节）

1. **Workspace 路径不可变**：没有修改 Workspace.path 或跨 Workspace 搬迁会话的接口；`attachSession` 要求 session cwd 等于 workspace.path。目录搬移只能新建 Workspace + 删除旧登记，旧会话留在旧 cwd 的持久化目录。
2. **按项目路由会话存储**：`JsonlSessionPersistence` 的 root 是全局的；会话按 cwd 分目录，但不能声明“项目文件夹包含全部原生对话历史”（现有 blocked #9）。
3. **`ctx.fs` 无目录/重命名/删除抽象**：只有读写、stat、list、watch；需求目录创建、文件改名、删除需 Host 在 `resolve`+`contains` 后用 Node fs 完成，不享受 `replaceIfVersion` 的版本保护。
4. **`ctx.subprocess` 无沙箱**：原型运行/依赖安装是用户授权的可信代码执行，不能声称受 DSH 沙箱限制；AI 不应获得 shell 或 subprocess 工具。
5. **插件打开系统浏览器无官方服务**：当前依赖 DSH desktop 主窗口对 `window.open('http(s)://...')` 的既有外部打开处理；客户端只打开 Host 核验的 loopback URL。上游若变更加载行为，需要登记并调整。
6. **会话消息/控制准入**：`session/prompt-admission`、`session/control-admission` 来自现有锚定编辑，不是 rc.2 官方事件。新方案不拦截原生 prompt，可删除该编辑；若后续要拦截，必须重新登记。
7. **插件可用 OS 密钥库**：`ctx.credentials` 存在但是文件型；本方案删除协同/发布后不再需要插件密钥，模型凭据仍由 DSH 管理。
8. **发行方默认 bundle 白名单**：仍需现有 `project-manager.ts` 锚定编辑把 EADP 插件装入 shipped profile（blocked #1）。
9. **发行方附加运行时资源**：Node/pnpm 运行时仍通过 `prepare-runtime` 锚定编辑准备（blocked #6）。
10. **构建脚本 Windows/大仓适配**：现有 packaging/typert 锚定编辑仍可能需要（blocked #8）。

### 6.2 实施前必须在真实桌面核实

| 项 | 要核实的内容 | 失败时 |
| --- | --- | --- |
| Workspace 服务已装载 | EADP profile 是否加载 `workspaceRegistry`、`workspaceController`、`ui-workspace`、`fs-sandbox`、`sandboxPolicy` | 记录缺少的 bundle/服务；不得自建项目注册表替代 |
| 会话创建/恢复 | `sessionController.create({workspaceId,agentPreset})` 或 `agents.create`+`attachSession` 的 cwd 相等；resume 是否触发 setup/`agent/created` | 调整到 setup 显式注册 guard/context；resume 不得无 guard |
| `agentPreset` 读取 | 恢复会话时能否从 header/projection 取得 preset/role | 在 Workspace 关联的本地记录中保存角色；未知角色按只读 |
| guard 覆盖 | 真实模型调用 `write/edit/read/glob/grep/pwsh/run_code/spawn_agent`/插件工具时是否都经过 guard | 记录未覆盖通道；阻塞受影响验收 |
| 搜索忽略规则 | 真实 `tool-fs-search` 的 `glob`/`grep` 是否按文件忽略 `.env`/密钥/`node_modules`；pattern 能否逃逸 | 不能保证则禁用搜索工具或登记缺口，不能只靠起始目录 |
| `ctx.fs` 版本写 | `replaceIfVersion`/`createIfAbsent`、`watch`、`stat` 在 Windows 实际行为 | 回退到 Node fs + 自建版本核对，但不得声称 OS 级 CAS |
| Host 写策略 | Host 以 `{mode:'workspace-write', workspaceRoot}` 调 `ctx.fs` 是否被 fs-sandbox 接受 | 改用裸 local backend 或 Node fs；记录边界 |
| 系统浏览器打开 | `window.open(hostUrl)` 在固定 desktop 是否打开外部浏览器 | 若失败，登记 blocked；不得恢复内嵌画布 |
| 原型端口/就绪 | 模板 Umi 版本是否接受 `PORT`/`--port`；实际输出 URL；超时 | 解析 stdout 或让 Host 选端口；失败保留日志 |
| 进程树停止 | Windows `taskkill /T`/Job Object 是否结束 pnpm→node 子进程 | 记录残留；不得按端口杀未知进程 |
| 原生会话存储 | 关闭/重启后 `workspace.sessionIds`、`sessionQuery` 是否仍能列出并 resume | 若失败，报告实际原因，不伪造历史 |
| 知识内容/用户知识库 | 内置初始卡片来源/版本；用户知识库存储根、manifest/hash/version、UI 新增/修改/删除、AI 提案/应用、重启持久化 | 内置内容未定可用少量确认卡；用户可自行补充，AI 可提议但必须用户确认；不能把示例当业务规则，也不能让 Agent 直接写知识 |

## 7. 真实冲突与决策点

### 7.1 项目身份：采用 DSH Workspace，不采用 `.eadp/project.json`

原方案在项目根写 `.eadp/project.json` 保存 projectId，并为复制目录、重复 ID、搬移设计冲突处理。核实 rc.2 后，固定宿主已经提供持久、路径唯一、会话归属的 Workspace；Editor 正是以 Workspace 为项目。继续在文件夹里写第二身份会主动制造“同一 ID、不同目录”的冲突，并要求自建注册表、canonical 别名、搬移和迟到请求协议。

因此本轮修正：

- 项目身份 = DSH `WorkspaceId`（UUID）；真实目录 = `Workspace.path`（canonical realpath）；项目名 = `Workspace.title`。
- 项目文件夹**不再写 `projectId` 元数据**；复制目录 = 新目录 = 新 Workspace；同一真实目录的别名 = 同一 Workspace；重复 ID 不存在。
- 目录搬移 = 新建 Workspace（新 ID）+ 删除旧登记；旧会话/AI 历史仍在旧 cwd 的 DSH 存储中，不能自动迁移。这是宿主的硬限制，不是本方案新增的兼容层。
- 如果未来业务要求“项目 ID 随文件夹可移植/可迁移”，需要新的产品决定；当前证据不支持在 DSH 之外再造身份，也不应反向修改 Workspace.path。

### 7.2 其他已决定的取舍

| 冲突/问题 | 决定 | 理由 |
| --- | --- | --- |
| 原型目录名 `原型代码/` vs 目标 `原型/` | 新项目用 `原型/`；旧目录不双读、不自动搬 | 目标范围要求删除旧结构；旧成果由用户手工整理 |
| 需求模板/元数据/确认状态 | 删除；需求就是普通 UTF-8 Markdown | 用户明确直接编辑；元数据会制造第二权威 |
| AI 直接写需求 vs 提案 | AI 不获得 `write/edit`；只能调用提案工具 | 用户审阅是写入授权；预设层面关闭写工具 + guard 再拒 |
| AI 获得 shell/subprocess | 不授予；原型运行/安装由用户点击 Host 执行 | shell 的 OS 沙箱只能到项目根，无法限到 `原型/`；subprocess 不受沙箱 |
| 原型 AI 写入范围 | 预设开放 write/edit + guard 限 `原型/`；不修改需求/CONTEXT/其他项目 | 工具层可到子目录；OS 沙箱只能到项目根，二者叠加 |
| 内嵌预览/自动浏览器验收 | 删除；系统浏览器打开 Host 核验的 loopback URL | 用户明确要求系统浏览器；随包 Chromium 无业务必要 |
| 应用管理 Git | 删除；用户可自行用外部 Git | 用户明确无需 Git；保留会重新引入任务/worktree |
| 需求提案多文件/选择性应用 | 首版单文件整篇提案；不做选择性 hunk/多文件原子应用 | 单文件 `replaceIfVersion` 可原子完成；多文件会带来部分失败与回滚假象 |
| 草稿崩溃恢复 | 不持久化草稿副本；正常关闭前 flush，失败阻止关闭；强杀可能丢最后输入 | 普通文件是唯一内容权威；不制造第二份正文 |
| 提案持久化 | 提案只在 Host 内存；重启后丢弃 | 提案不是成果；聊天历史仍可让 AI 重新生成 |
| 知识库 | 内置只读知识卡 + 用户本机知识库；用户可新增/修改/删除；AI 可提议新增/修改，用户确认写入；Agent 不能直接写 | 沿用 Editor 卡片形态；用户补充不依赖发行；知识提案与需求提案同构（用户确认、版本核对）；不能用旧文档/示例冒充业务知识 |

### 7.3 是否需要用户现在决定

本轮没有发现“影响产品范围且缺乏证据”的阻塞冲突，因此不要求用户先回答才能继续设计：

- 项目身份改用 DSH Workspace 有 rc.2 源码与 Editor 实践证据，且在文档中明确披露“复制目录即新项目、搬移不迁移旧会话”的代价。若用户要求项目 ID 随文件夹可移植或旧会话随搬移，属于新的产品范围，需要另行决定；不是本轮能靠实现细节解决的。
- 知识库改为“内置只读卡 + 用户本机知识库”：内置内容可少量起步，用户可自行新增/修改，AI 可提议新增/修改、用户确认后写入，不再把完整文档集作为阻塞；仍不能用旧文档/示例冒充业务知识，且 Agent 不能直接写。
- 仓库 `AGENTS.md` 的生产门槛仍写旧链路，与本轮目标冲突；用户本轮已给出新的完成标准，因此实施切片 6 按新标准替换，本轮不擅自改仓库规则。

## 8. 结论

固定 rc.2 已足够支撑“Workspace 即项目、会话归属、版本条件写入、工具级写边界、官方 UI 扩展、原生会话/模型/设置”。本方案因此比原草案更小：**不新增 project 包、不新增项目注册表、不新增 `.eadp` 身份文件、不保留协同/浏览器/任务栈**。未核实项集中在真实桌面行为、guard 覆盖、原型端口/进程、内置知识卡初始内容、用户知识库 UI/存储与 AI 知识提案/应用，已在 [implementation.md](implementation.md) 的切片前置与未验证清单中列明。
