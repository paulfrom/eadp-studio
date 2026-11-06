# eadp-requirements：需求 Markdown、保存与 AI 提案

状态：目标设计，尚未实施。入口见 [方案总览](../README.md)；总体边界见 [architecture.md](../architecture.md)；流程见 [user-flows.md](../user-flows.md)。

## 1. 职责与文件语义

一个需求就是项目 `需求/` 下的一份 UTF-8 Markdown。文件正文是唯一内容权威；文件名是展示名称；不写 `eadp-metadata`、不强制编号、不保存确认状态、不绑定场景/模板/来源/开发占用。`CONTEXT.md` 是项目根的可选背景文件，由本包固定目标接口管理，不进入需求列表。

本包负责：需求目录/文件树、创建/改名/删除、Markdown 编辑、自动与离场保存、外部改动、AI 提案、CONTEXT.md、Agent 读取/提案工具。项目身份/布局归 Shell（DSH Workspace）；原型文件归 prototype；知识归 knowledge。

## 2. 目录与路径规则

```text
<Workspace.path>/
  CONTEXT.md                 可选；固定目标，不进入需求树
  需求/
    *.md                     首版只把 .md 当需求
    子目录/*.md              支持已有子目录
```

- 不创建 `.eadp/`；不预建 `需求/`；首次创建需求/子目录时才创建。
- 文件名：非空、不得为 `.`/`..`、不得含 `/` `\` 控制字符、不得以 `.` 开头、不得以空格/点结尾；拒绝 Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含扩展名）；长度 ≤ 120；自动补 `.md`。已存在目标不覆盖。
- 路径：所有请求用相对项目根的路径；Host 用 `ctx.fs.resolve(path,{cwd:workspace.path})` + `contains` 校验；拒绝绝对路径、盘符、UNC、`..`、链接逃逸、`.git`。
- 读取：编辑器默认上限 2 MiB；超过则拒绝打开并说明；非 UTF-8 → `FS_NOT_TEXT`；不截断编辑器正文。
- 隐藏/敏感：需求树只显示 `.md`；`.env`/密钥等不作为需求显示；AI 读取按 guard 的敏感文件规则拒绝。

## 3. Host 接口

```ts
type FileVersion = string // 不透明；来自 ctx.fs FsVersion，客户端不解释
type RequirementEntry = { path: string; name: string; type: 'file' | 'directory'; size?: number }
type RequirementDocument = { path: string; text: string; version: FileVersion }
type ContextDocument = { kind: 'absent' } | { kind: 'present'; text: string; version: FileVersion }
type Proposal = {
  proposalId: string; workspaceId: string; path: string;
  baseVersion: FileVersion | null; target: 'requirement' | 'context';
  summary: string; diff: Array<{ kind: 'context' | 'added' | 'removed'; text: string }>;
  createdAt: string;
}
```

| 方法 | 输入 | 输出/行为 |
| --- | --- | --- |
| `list(workspaceId)` | — | 递归 `需求/**/*.md` + 目录（有界，建议 2000 项）；不含 CONTEXT |
| `read(workspaceId,path)` | 相对路径 | `{text,version}`；不存在/过大/非文本明确错误 |
| `createDirectory(workspaceId,parent,name)` | 已存在父目录 | 创建子目录；目标已存在报错；Node fs + containment |
| `create(workspaceId,directory,name)` | 已存在目录 | `ctx.fs.writeText(...,{kind:'createIfAbsent'})` 创建空文件；返回 path/version |
| `save(workspaceId,path,expectedVersion,text)` | 版本、正文 | `replaceIfVersion`；版本不符 `FS_STALE_VERSION`；返回新 version |
| `rename(workspaceId,path,newName)` | 新文件名 | 先由客户端 flush；Host 校验并 Node fs rename；目标存在拒绝；返回新 path |
| `remove(workspaceId,path)` | 相对路径 | 用户确认后删除；Node fs unlink；失败保留文件 |
| `readContext(workspaceId)` | — | `ContextDocument`；不存在返回 absent；不自动创建 |
| `saveContext(workspaceId,expectedVersion,text)` | `null` 表示创建 | `createIfAbsent`/`replaceIfVersion`；路径固定 `CONTEXT.md` |
| `listProposals(workspaceId)` | — | 当前内存提案（按创建时间）；无持久化 |
| `applyProposal(workspaceId,proposalId,expectedVersion)` | — | 见第 6 节；成功返回 `{version,text}` 并删除提案 |
| `discardProposal(workspaceId,proposalId)` | — | 删除内存提案；文件不变 |

- Host 每次从 `workspaceRegistry.get(workspaceId)` 重新解析真实目录；workspace 不存在/已移除 → 拒绝；不信任客户端路径。
- `ctx.fs` 只提供读写/stat/list/watch，没有 mkdir/rename/unlink；目录、改名、删除由 Host 在 `resolve`+`contains` 后用 Node fs 完成，操作前后核对真实路径。它们没有版本条件写保护，不能声称与外部进程原子。
- `ctx.fs.writeText` 显式传 `{mode:'workspace-write',workspaceRoot:workspace.path}`；不修改全局 sandbox 默认值。

## 4. 编辑与保存

### 4.1 编辑器

- 复用现有 textarea 编辑方向，删除场景 metadata/业务字段/模板/来源/确认表单；Markdown 纯文本编辑，首版不做预览/WYSIWYG。
- 复用/抽象 `DraftBuffer`：`text`、`version`、`dirty`、`saving`、`error`、外部版本；删除 metadata 与场景操作。
- 自动保存 600–800 ms 防抖；同一文件串行；失败保留输入并显示重试；成功才更新已保存版本。
- 中文 IME：`compositionstart/end` 置组字状态；组字中不自动保存、不切换文档/项目、不应用提案；离场等待组字结束，超时/失败则阻止离场并说明。
- 外部改动：用 `ctx.fs.watch`（本地后端支持）或焦点/定时 `stat`；版本变化时：干净文档读取新内容；脏文档保留草稿并展示“磁盘已更新/载入/保留/查看差异”，不静默覆盖。
- 关闭/切换：Shell 调 `flushActive()`；脏、在途保存、组字、版本冲突均阻止并说明。`beforeunload` 在脏/保存中/组字时阻止关闭；强杀可能丢最后输入，不承诺崩溃级草稿。
- 保存响应丢失：客户端重新 `read`；若磁盘正文等于提交正文，视为已保存并更新基准；否则保留脏草稿。不引入 Host 操作日志。

### 4.2 保存顺序

```text
用户输入 → 内存草稿（权威）
  → 自动/手动/离场保存
  → 取消旧定时器；等待同一文件在途保存
  → 取当前草稿文本 + 已保存版本
  → Host stat 当前版本
  → 版本匹配：writeText(replaceIfVersion)
  → 返回新版本
  → 仅当草稿仍是提交时的文本：更新基准/清除 dirty
  → 若期间有新输入：保留新草稿为 dirty
  → 失败/过时：保留草稿，显示原因
```

- 旧保存回包不能覆盖新输入；用 operation/generation 标记丢弃迟到 acknowledge。
- 不把“取消定时器”当作“取消已发出的保存”；在途保存必须等待。
- 文件被外部删除：保存报 `NOT_FOUND`；允许“另存为新需求”（创建新文件），不自动重建原路径。
- 重命名/删除前先 flush；失败留在原文件。

## 5. 项目背景 CONTEXT.md

- `readContext` 只读固定目标；不存在返回 absent；不隐式创建。
- 用户显式“创建背景”/编辑保存：`saveContext(workspaceId,null,text)` 用 `createIfAbsent`；已存在时 `replaceIfVersion`。并发创建出现 → 冲突，保留输入。
- 编辑、外部改动、版本核对、离场保存与普通需求相同。
- AI 提案目标固定为 `CONTEXT.md`；允许不存在时创建提案；不允许通过该接口写项目根其他文件。
- 背景不进入需求列表；背景不存在不阻断需求操作。

## 6. AI 提案

### 6.1 工具

需求会话预设关闭 `tool-fs` 的 write/edit；guard 再拒绝写。只提供：

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `eadp_requirements_list` | 无 | 列需求路径（递归、有界）；不返回正文 |
| `eadp_requirement_read` | `path`、可选 `offset`/`length` | 返回 `{path,text,version,truncated,nextOffset}`；记录该会话在此路径读到的版本；只允许 `.md`/CONTEXT |
| `eadp_requirement_propose` | `path`、`baseVersion`、`text`、`summary` | 生成提案；不写文件；见下 |

- 工具从真实 `exec.agent.session.header.cwd` 解析 Workspace；参数不接受 workspaceId/绝对路径。
- `read` 默认每段 12,000 字符、上限 24,000；截断给 `nextOffset`；不跨 Unicode 字符边界。
- `propose` 要求：该会话先读过该 path；`baseVersion` 等于记录的版本；Host 当前 `stat` 版本也等于 baseVersion（否则“文件已更新，请重新读取”）；候选正文 ≤ 1,000,000 字符；summary ≤ 2,000；目标只能是 `需求/**/*.md` 或 `CONTEXT.md`；候选不能与当前正文相同。
- 提案内容由 Host 保存；工具输出只含 `proposalId/path/summary` 与“请在审阅面板应用”。
- `defineTool` 必须提供 `output.schema` + `output.render`；对象 schema 显式 `additionalProperties`；必填字段 `required: true`。工具注册在 `agent.ctx`，随会话释放。

### 6.2 应用顺序

1. 客户端点击“应用”；若组字中，等待组字结束或中止。
2. 暂停该文档自动保存；等待在途保存 Promise。
3. 重新核对活动项目/文档未变、缓冲区相对已保存版本干净；脏则中止并提示先保存/丢弃。
4. 调用 `applyProposal(workspaceId,proposalId,expectedVersion)`；`expectedVersion` 为客户端当前已保存版本。
5. Host 校验 Workspace、提案、路径、目标类型；`stat` 当前版本；必须同时等于提案 `baseVersion` 与请求 `expectedVersion`。
6. `ctx.fs.writeText(target,proposal.text,{kind:'replaceIfVersion',version},signal,{mode:'workspace-write',workspaceRoot})`。
7. 成功返回实际 `{version,text}`；客户端更新已保存基准；若应用期间有新输入，保留新输入为 dirty，不替换；恢复自动保存。
8. 失败/过时：不写；保留草稿与提案；显示 `文件已更新/版本过时` 与“重新读取生成/查看差异”；可重试（重新核对后）。
9. 成功后删除提案；丢弃只删内存提案，不写文件。

- 用户批准不等于版本核对；Host 必须独立比较版本。不能静默重算后应用，也不能自动合并。
- 单文件整篇提案；首版不做选择性 hunk/多文件原子应用。多文件需求修改由用户逐个应用。
- 提案只在 Host 内存；重启丢失。聊天历史仍在 DSH，用户可让 AI 重新读取生成。
- 原型会话也可调用同一提案工具；它不改变原型写入边界。

### 6.3 差异与展示

- Host 计算行级 diff（context/added/removed），有界（建议 ≤ 2000 行）；客户端只渲染，不重新解释提案。
- 展示目标路径、基于版本、摘要、差异；过期提案标记“基于旧版本”，允许重新生成；不把聊天文本当提案。
- 应用结果给实际写入版本；不显示“已全部同步”之类超出实际的结果。

## 7. 失败与恢复矩阵

| 情况 | 必须保留 | 行为 |
| --- | --- | --- |
| 保存失败（权限/磁盘/IO） | 输入、原文件、旧版本 | 状态未保存；重试；不更新基准 |
| 版本过时 | 草稿、提案、磁盘新内容 | 拒绝覆盖；提示外部改动；可重新读取 |
| 保存飞行中应用 | 草稿、提案 | 等待；期间新输入则中止应用 |
| 组字中保存/应用/切换 | 当前输入 | 等待组字结束；不半段提交 |
| 外部删除 | 草稿 | 明确不存在；允许另存为新需求 |
| 提案未读/版本不符/过大 | 聊天/输入 | 不生成提案；说明原因 |
| 提案应用失败 | 提案、草稿、原文件 | 不删除提案；重试/丢弃 |
| 重启 | 文件、DSH 聊天 | 提案丢失；不声称持久化；可重新生成 |
| 重命名冲突/删除失败 | 原文件、草稿 | 保留原名/原文件；说明 |

## 8. 当前代码去留

**复用/抽象**

- `client/scenarios/DraftBuffer.ts`、`useDraftBuffer.ts`、`ExternalFileNotice.tsx`：草稿、外部版本、串行保存、离场提示；删除 metadata/场景字段。
- `client/components/MaterialEditor.tsx` 的 textarea 编辑方向与离场 flush 注册；删除业务字段/模板/来源/确认。
- `host/application/material-write-changes.ts` 的差异展示思路可参考；新实现行级 diff，不复用 H2 章节协议。
- `host/adapters/assets/materials.ts` 的 `digest`/路径思路仅作参考；版本改用 `ctx.fs`，路径改用 `resolve/contains`。

**删除/重写**

- `host/application/requirement-saves.ts` 的远端三阶段/占用/revision/idempotency；改为本地 `ctx.fs` 条件写。
- `scenario-write-proposals.ts` 的聊天 `eadp-write-proposal` 解析；改为结构化提案工具。
- `requirement-sources.ts`、`requirement-candidates.ts`、`scenario-workspaces.ts` 的来源/候选/拆分/确认调用。
- `client/requirements/*` 的来源、候选、门禁、metadata 表单；`MaterialConfirmationChecks`、`RequirementGates`、`ReviewPanel`。
- 需求模板、场景绑定、`eadp-metadata`、材料种类映射、pdfjs/Office 资料导入（若不再被知识包使用）。
- 旧 `shared/requirement-workspace.ts`/`StudioCommand` 中的阶段命令；保留必要的新合同。

## 9. 实施顺序

1. 定义 contracts：RequirementEntry/Document、ContextDocument、Proposal、错误码、slot/客户端服务。
2. Host 文件服务：list/read/create/save/rename/remove/context；`ctx.fs` 版本写与 Node fs 目录操作；路径/敏感/大小校验。
3. Client 树/编辑器/自动保存/IME/离场/外部改动；接通 Shell 的 `flushActive`。
4. CONTEXT 固定目标；不扩展根目录写。
5. 工具：list/read/propose；agent scope 注册；提案面板/应用/丢弃/过时。
6. 删除旧需求保存/提案/确认/模板调用链；更新文案。

## 10. 验收

真实桌面：

1. 新建/打开/改名/删除/子目录；无 `需求/` 时创建；文件名冲突/非法名失败保留。
2. 中文连续输入、组字中切换/关闭/应用；快速切换文件；自动保存；外部改动干净/脏文档；只读/磁盘失败；重启。
3. CONTEXT 不存在/创建/编辑/外部改动/提案/冲突；不进入需求列表；不扩写其他根文件。
4. 真实模型读取当前需求 → 提案 → 审阅 → 应用/丢弃；未应用不落盘；应用后版本更新；过时拒绝；脏草稿/在途保存/新输入/迟到回包保留输入与提案。
5. `pnpm check` + 受影响构建；不新增测试代码。

以上尚未执行；构建/类型通过不等于桌面验收。
