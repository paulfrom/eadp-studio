# contracts：跨包共享合同

状态：目标设计，尚未实施。目录保持 `packages/contracts`，包名保持 `@eadp/contracts`；不新建第二份 contracts、project 或 workspace-kit 包。

## 1. 范围

只放跨 Client/Host、跨包确实需要的数据形状、请求校验、slot 名/属性、错误码与客户端窄服务接口。不放文件系统/进程/React/数据库/业务编排。

- 项目身份直接用 DSH Workspace：`ProjectId = WorkspaceId`（字符串）；项目列表/标题/路径/会话归属用官方 `WorkspaceView`，不在 contracts 复制第二份状态机。
- 文件版本 `FileVersion` 是来自 `ctx.fs` 的不透明字符串；客户端只保存/比较，不解释。
- 需求、提案、原型运行、知识引用按领域拆子路径导出。
- 运行期校验沿用 TypeBox；DSH `defineTool` 的参数/输出 schema 按官方 DSL，不把 TypeBox schema 原样塞进去。

## 2. 目录

```text
src/
  index.ts          公共稳定导出
  project.ts        ProjectId/ProjectRef 与 Workspace 视图映射（不定义项目注册表）
  files.ts          相对路径、FileVersion、读写结果、错误
  requirements.ts   需求条目/文档、提案、差异
  prototype.ts      文件条目/内容、运行状态/日志
  knowledge.ts      引用、命中、读取结果
  shell.ts          会话角色、活动文档、slot 名/属性
  errors.ts         稳定错误码
```

通过 `./project`、`./files` 等显式子路径导出；入口不 re-export 庞大第三方运行时。包内临时状态在所属包内定义。

## 3. 合同

### 3.1 project/shell

| 类型 | 字段/语义 |
| --- | --- |
| `ProjectId` | DSH `WorkspaceId` 的字符串形式；不是文件夹里的 ID |
| `ProjectRef` | projectId、path（canonical）、title；由 Host 从 `workspaceRegistry` 解析，客户端不能伪造 |
| `SessionRole` | `'requirements' \| 'prototype'`（首版）；未知按只读 |
| `ProjectSessionRef` | sessionId、projectId、role、title?、updatedAt?；由 Host/官方会话投影给出 |
| `ActiveDocument` | projectId、relativePath（`需求/**/*.md` 或 `CONTEXT.md`）；仅提示，不是授权 |
| `EadpRequirementsSlotProps` | projectId、active |
| `EadpPrototypeSlotProps` | projectId、active |
| `EadpKnowledgeSlotProps` | active |
| slot 名 | `eadp.requirements.view`、`eadp.prototype.view`、`eadp.knowledge.view`；single；由 Shell 声明 |

### 3.2 files/requirements

| 类型 | 字段/语义 |
| --- | --- |
| `RelativePath` | 项目根下相对路径；无绝对/盘符/UNC/`..`/NUL；Host 再 realpath |
| `FileVersion` | 不透明版本；来自 `FsVersion` |
| `FileError` | `STALE_VERSION`、`NOT_FOUND`、`EXISTS`、`OUTSIDE_PROJECT`、`INVALID_PATH`、`PERMISSION_DENIED`、`IO_ERROR`、`TOO_LARGE`、`NOT_TEXT` |
| `RequirementEntry` | relativePath、name、type、size? |
| `RequirementDocument` | relativePath、text、version |
| `ContextDocument` | `{kind:'absent'} \| {kind:'present'; text; version}` |
| `RequirementProposal` | proposalId、projectId、relativePath、target（requirement/context）、baseVersion、summary、diff、createdAt、sessionId? |
| `ProposalDiffLine` | kind（context/added/removed）、text；有界 |
| `SaveRequest` | projectId、relativePath、expectedVersion（null 表示创建）、text |
| `ApplyProposalRequest` | projectId、proposalId、expectedVersion |

- 提案应用返回实际 `{version,text}`；失败保留提案。
- 不定义“需求确认版本”“来源/场景/模板/占用”；不存在这些字段。
- `diff` 由 Host 生成，客户端不重新解释。

### 3.3 prototype

| 类型 | 字段/语义 |
| --- | --- |
| `PrototypeEntry` | relativePath、name、type、size? |
| `PrototypeContent` | relativePath、text、truncated、size |
| `PrototypeRunState` | projectId、status、url?、port?、pid?、startedAt?、error? |
| `PrototypeRunLog` | items（stdout/stderr/host）、truncated |
| `PrototypeError` | `RUN_NOT_READY`、`RUN_FAILED`、`DEPENDENCIES_MISSING`、`PORT_UNAVAILABLE`、`PROJECT_NOT_FOUND`、`PROJECT_NOT_EMPTY`、`STOP_FAILED` |

- URL 只由 Host 产生并核验 loopback；客户端不提交任意 URL。
- 状态 `stopped/starting/running/stopping/failed`；不持久化 running。

### 3.4 knowledge

| 类型 | 字段/语义 |
| --- | --- |
| `KnowledgePack` | packId（`builtin`/`user`）、packVersion、readOnly、cards |
| `KnowledgeCard` | packId、documentId、title、source、scope、tags、version、readOnly |
| `KnowledgeDraft` | 用户新建/编辑：title、source、scope、tags、text；Host 生成 documentId/version/sha256 |
| `KnowledgeReference` | packId、packVersion、documentId、sha256 |
| `KnowledgeHit` | reference、title、excerpt、source、scope；不使用不存在的向量分数 |
| `KnowledgeRead` | reference、text、offset、length、truncated、nextOffset |
| `KnowledgeProposal` | proposalId、action（create/update）、target（user）、documentId?、baseVersion?、draft、summary、diff?、createdAt、sessionId? |
| `KnowledgeProposeRequest` | action、documentId?、baseVersion?、title、source、scope、tags、text、summary；Host 生成 proposalId/documentId |
| `KnowledgeApplyRequest` | proposalId、expectedPackVersion；用户确认后由 Host 应用并再次核对版本 |
| `KnowledgeError` | `INVALID_ARGUMENT`、`NOT_FOUND`、`VERSION_MISMATCH`、`RESOURCE_INVALID`、`UNAVAILABLE` |

- 首版一张卡就是一份 Markdown，不定义 `sectionId`；读取按整卡 + offset/length。
- `packVersion` 是知识包版本字符串：内置包用发行版本号；用户包用递增整数序列化。`documentId` 在包内唯一。
- 用户知识库写操作不属于 Agent 工具；`KnowledgeDraft` 只用于 Host 的用户 UI 服务；`eadp_knowledge_propose` 只写提案内存，用户确认后 Host 应用。
- 提案不持久化；应用时重新核对 packVersion/目标卡版本；过时保留提案。

### 3.5 client 服务

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `EadpRequirementsClient` | `flushActive(): Promise<{ok:boolean; message?:string}>`；`hasUnsaved()` | Shell 切换/关闭前保存；不暴露草稿正文 |
| `EadpShellClient` | 可选：`setActiveDocument(projectId,path)` | 活动文档提示；不授予写权限 |

- 跨包客户端调用只通过 contracts 接口；Shell 不 import requirements 组件/内部 store。
- 远程命名空间：`eadpShell`、`eadpRequirements`、`eadpPrototype`、`eadpKnowledge`；各自小方法，不合并为 `action:string + payload:any`。

## 4. 错误与部分结果

- 错误码稳定、可映射用户文案；不解析错误字符串做业务分支。
- 单文件提案/保存要么成功、要么失败；不制造多文件“部分成功”。原型运行/安装可分别报告结果。
- 取消沿运行时取消传播，不伪装成功/零命中。
- 不保留旧“远端同步失败”“协同登录过期”等含义。

## 5. TypeBox 与 defineTool

- RPC 请求边界用 TypeBox 校验：路径、长度、版本、枚举；对象显式 `additionalProperties: false`（关闭多余字段）；不定义 `any`。
- `defineTool` 的 `parameters`/`output.schema` 按官方规则：对象显式 `additionalProperties`；必填属性 `required: true`；不存在 required 数组/`required:false`；`output.render` 必填。
- 不为 Editor 的 Zod 另引入一套校验；不与 TypeBox 混用同一份 schema。

## 6. 当前内容处理

| 当前内容 | 处理 |
| --- | --- |
| 路径/摘要基础约束 | 保留必要部分，改为 `RelativePath`/`FileVersion`；不复制旧材料解析 |
| EntityKind scenario/baseline/handoff | 删除，不映射成 requirement |
| confirmed/pending、材料确认条件 | 删除 |
| FixedReference/Git SHA/来源场景版本 | 删除；知识引用用自己的类型 |
| StudioUser/成员/认证 API | 删除 |
| 原型任务/占用/基线/发布/复用合同 | 删除 |
| `shared/studio.ts` 跨包有用类型 | 按实际调用抽取重写，不整体移动 |
| 旧 API HTTP 状态/错误码 | 删除；新错误码在 errors.ts |

## 7. 实施与验收

1. 先定义 `project/files/requirements` 最小合同，调用方一起切换；再原型/知识。
2. 每完成一个领域删除被替代的旧导出；不保留兼容别名。
3. 核对包依赖与残留导入；contracts 不反向依赖需求编辑器。
4. `pnpm check` + 受影响构建；真实 RPC 由固定宿主验证，不用类型通过代替通信通过。
5. 验收覆盖：无效类型/缺失字段/多余字段、越界路径、旧版本、无效运行 URL、知识版本不匹配、取消。
6. 不新增测试代码/测试命令。

以上尚未实施。
