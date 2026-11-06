# eadp-shell：本地项目入口与工作台

状态：目标设计，尚未实施。入口见 [方案总览](../README.md)；总体结构见 [architecture.md](../architecture.md)；流程见 [user-flows.md](../user-flows.md)。

## 1. 职责

Shell 负责：

- 项目首页：读取 DSH 官方 Workspace 列表，创建/打开/重新定位/移除项目；不维护第二个项目注册表。
- 工作台布局：项目标题、需求/原型/知识库页签、需求树与编辑区/原型区、可收起的原生会话；设置使用 DSH 原生界面。
- 原生会话：按项目创建/恢复会话，承载官方 conversation；模型选择、凭据、审批、设置委托 DSH。
- 会话策略：在真实 Agent 创建/恢复时绑定 Workspace、注册 tool guard 与动态上下文；把活动文档（workspaceId → 相对路径）提供给工具提示。
- 生命周期：切换项目/关闭前调用 requirements 的 `flushActive()`；退出时由各包停止自有资源；不删除用户文件或 DSH 历史。

Shell 不负责：需求/原型文件读写、原型进程、知识包的搜索/存储/UI（只提供页签）、项目身份存储、聊天/模型/审批实现。

## 2. 项目模型与官方接口

| 需求 | 官方接口 | Shell 行为 |
| --- | --- | --- |
| 项目列表/最近 | 客户端 `ctx.workspaces.list`、`WorkspaceView{workspaceId,path,title,sessionIds,...}` | 只读投影；按 registry 顺序显示；不另存“最近列表” |
| 新建项目 | `ctx.uiWorkspace.pickDirectory()`、`createDirectory(parent,name)`、`ctx.workspaces.create({path})` | 用户选父目录/输入名称；创建目录后登记；不预建需求/原型目录 |
| 打开项目 | `ctx.workspaces.create({path})` | canonical path 已登记则复用；否则登记新 Workspace |
| 重新定位 | `ctx.workspaces.create(newPath)` + `ctx.workspaces.delete(oldId)` | 旧路径不可用时；成功后删旧登记；旧会话不迁移 |
| 移除最近 | `ctx.workspaces.delete(id)` | 先停止该项目运行/等待活动轮次或拒绝；只删登记 |
| 打开工作区 | `ctx.uiWorkspace.openWorkspace(workspaceId)` / 选择会话 | 由官方会话/导航承载；Shell 不复制 session 状态 |
| 重命名项目 | `ctx.workspaces.rename({workspaceId,title})` | 官方校验名称冲突；失败保留原名 |
| 会话创建 | `ctx.sessionController.create({workspaceId,agentPreset})` 或 `ctx.agents.create({meta:{cwd,agentPreset},setup})` + `workspace.attachSession` | cwd 必须等于 Workspace.path；成功后 attach；失败不写文件 |
| 会话恢复 | `Workspace.sessionIds` / `sessionQuery.filterSessions([{kind:'cwd',values:[path]}])` + `ctx.agents.resume({resumeSessionId,setup})` | setup 重新注册 guard/上下文；cwd 不匹配的旧会话不提供 |
| 原生会话 UI | `ctx.sessions.retain(id,{source})`、官方 `conversation.content`/`SessionProvider` | 复用现有 `NativeConversation` 方向；不复制消息 |
| 设置 | DSH 原生 settings/model UI | 不新增 EADP 设置节；不建模型/凭据/审批入口 |

不新增 `.eadp/project.json`、项目编号分配、namespace、GitLab、账号或“项目初始化阶段”。项目内容目录由用户操作按需创建。

## 3. Host 半边

建议结构：

```text
packages/eadp-shell/src/
  host/index.ts          Cordis 入口、服务/生命周期
  host/session-policy.ts Agent 创建/恢复时绑定 Workspace、注册 guard/上下文
  host/active-document.ts workspaceId → 当前需求相对路径（仅提示，不是授权）
  host/tools.ts          可选的只读项目工具注册（如需要）
  client/index.ts        客户端入口、slot/服务注册
  client/home.tsx        项目首页
  client/workbench.tsx   工作台布局与页签
  client/conversation.tsx 原生会话承载
```

### 3.1 会话策略注册

- 监听真实 Agent 事件或用 `agents.create/resume` 的 `setup`；从 `agent.session.header.cwd` 取真实 cwd，`realpath` 后 `workspaceRegistry.resolveByPath` 找到 Workspace；找不到则不授予文件工具。
- 从会话 `agentPreset`/角色取策略：`eadp-requirements` 只读；`eadp-prototype` 读写且 guard 限 `原型/`；未知只读。
- 用 `agent.ctx` 注册 `tools.guard`（只对该 Agent 生效）；不使用全局 guard 绑定某个会话。
- 用 `agent.ctx` 注册 `systemPrompt.context`：当前需求相对路径 + 角色指令；短文本，不塞正文，不作为安全边界。
- 会话恢复必须重新执行同一注册；`agentPreset` 不可读时按只读或拒绝写，不能默认放行。
- 子 Agent 首版拒绝（guard 不白名单 `spawn_agent`）；若未来启用，必须继承同一 Workspace 策略并在首个请求前生效。

### 3.2 活动文档

- 客户端在用户选中需求/背景时调用 `setActiveDocument(workspaceId,path)`；Host 只保存相对路径，校验 `需求/**/*.md` 或 `CONTEXT.md`。
- 该状态只影响会话提示与 UI；文件工具、提案、保存仍各自校验真实路径与版本。
- 项目切换/文档删除后清除或更新；旧会话的上下文在下一次请求读取最新值，不缓存正文。

### 3.3 生命周期

- 关闭/切换项目前调用 requirements 客户端 `flushActive()`；失败、组字中或冲突时阻止并说明。
- 退出时让 prototype Host 停止所有自有进程；需求文件已由自动保存/离场保存落盘；DSH 负责会话持久化。
- 不删除 Workspace 目录、文件、DSH 会话历史或模型凭据；移除项目只删登记。
- 目录丢失/registry 丢失时显示实际不可访问，不自动重建；重新定位成功后删旧登记，失败保留旧登记。

## 4. Client 半边

### 4.1 首页

- 读取官方 Workspace 列表；显示标题、路径、最近会话/摘要（只读）。
- 新建/打开/重新定位/移除；目录选择用官方 `pickDirectory`，不读取 Renderer 文件系统。
- 不可访问的 Workspace 显示原因与操作；不显示空列表冒充成功。
- 空列表显示“新建/打开项目”，不自动创建默认项目。

### 4.2 工作台

- 顶部：项目标题（可重命名）、返回项目、需求/原型/知识库页签；不显示协同账号/连接/任务。
- 需求页：左侧需求树 + 背景入口；中心 requirements slot `eadp.requirements.view`；可收起原生会话。
- 原型页：中心 prototype slot `eadp.prototype.view`；原生会话同一承载。
- 知识页：中心 knowledge slot `eadp.knowledge.view`；内置卡只读、用户卡可维护、AI 知识提案可审阅；原生会话可同时使用。
- 会话：官方 conversation 组件；切换会话不丢草稿（先 flush）；不复制消息/不改造模型 UI。
- 设置：使用 DSH 原生设置；Shell 不注册协同/模板/连接设置节。

### 4.3 Slot 合同

```ts
// contracts（示意）
interface EadpRequirementsSlotProps { workspaceId: string; active: boolean }
interface EadpPrototypeSlotProps { workspaceId: string; active: boolean }
interface EadpKnowledgeSlotProps { active: boolean }
```

- Shell 在 `main` 面板声明 `eadp.requirements.view`、`eadp.prototype.view`、`eadp.knowledge.view` child slot。
- requirements/prototype/knowledge 各自注册为 single slot；不互相 import 组件。
- Shell 向子 slot 传 workspaceId 与 active；子包自己读取文件/服务，不把 Host 路径传给 Shell。
- 知识库是用户本机数据，不随项目切换；Shell 只控制 active/页签，不读写知识卡。
- 若子包未注册，Shell 显示“模块未加载”与诊断，不崩溃整个工作台。

## 5. 当前代码去留

| 现有入口 | 处理 |
| --- | --- |
| `client/studio/StudioPanel.tsx` | 重写为首页/工作台/页签/会话；删除五阶段导航、任务轮询、场景/基线/交接入口 |
| `client/components/NativeConversation.tsx`、`client/session.ts` | 保留原生会话承载方向；删除远端投影/任务身份/`restoreSession` 旧命令依赖 |
| `client/components/ProjectDialog.tsx` | 改为官方目录选择 + Workspace 登记；删除 namespace/GitLab/远端项目列表 |
| `client/state.ts`、`store.ts`、`command.ts` | 删除远端快照/阶段命令；只保留小型 UI 状态与按包命令；不恢复巨型 `StudioCommand` |
| `client/settings/sections.tsx` | 删除协同账号/连接/场景模板/需求模板/项目位置/外观自定义入口；使用原生设置 |
| `client/scenarios/`、`client/requirements/`、`client/prototype/` | 业务 UI 分别迁入 requirements/prototype；Shell 只保留 slot 调用 |
| `host/composition.ts` | 拆除协同/Git/浏览器/发布装配；改为 Workspace/会话策略/活动文档/生命周期 |
| `host/index.ts` | 用各包自己的 Typert Remote 命名空间；Shell 只保留自身小服务，不保留巨型 command |
| `host/adapters/dsh/sessions.ts` | 抽取会话创建/恢复/prompt 去重经验；删除 TaskView/工作树/场景/基线身份 |

## 6. 失败与恢复

| 失败 | 行为 |
| --- | --- |
| Workspace 服务不可用 | 首页明确报“项目服务不可用”；不显示空列表、不伪造登记 |
| 目录不存在/不可读 | 不可访问 + 重新定位/移除；不创建同名目录 |
| 登记失败 | 保留输入/选择；不写项目文件；可重试 |
| 会话创建/恢复失败 | 保留项目与文件；显示实际错误；允许新会话 |
| 会话恢复 cwd 不匹配 | 不提供该旧会话；说明目录已变化；旧历史仍在 DSH |
| 草稿保存失败 | 阻止切换/关闭；停留原处；不丢输入 |
| 子 slot 未加载 | 该页显示模块不可用；其他页/文件不受影响 |
| 原生设置/模型不可用 | 本地编辑/文件仍可用；AI 请求如实失败 |

## 7. 验收

真实桌面：

1. 无协同服务/无网络启动；无登录；首页/Workspace 列表正常。
2. 新建空项目、打开已有文件夹、重启后重新打开；别名不重复；目录丢失可重新定位/移除。
3. 工作台页签/空状态正确；不出现场景/基线/交接/协同任务。
4. 创建/恢复项目会话；模型/设置原生可用；会话 cwd = Workspace.path。
5. 切换项目先 flush；切回后文件/会话正确；迟到回包不串项目。
6. 关闭/重启：文件一致；运行状态 stopped；会话历史可恢复；无协同请求。
7. `pnpm check` + 受影响构建。

以上尚未执行。构建成功不等于桌面验收通过。
