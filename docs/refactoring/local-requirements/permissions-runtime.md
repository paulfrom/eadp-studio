# 权限、写入边界与原型运行

状态：目标设计，尚未实现。证据见 [evidence.md](evidence.md) 第 5 节；流程见 [user-flows.md](user-flows.md)。

## 1. 威胁模型

| 主体 | 信任 | 说明 |
| --- | --- | --- |
| 用户与桌面 UI | 受信 | 用户点击保存、创建、安装、运行是授权动作；Renderer 仍无本地文件权限 |
| EADP Host 插件 | 受信代码 | 在 DSH Host 进程内运行；负责路径解析、版本核对、进程管理 |
| 模型输出 | 不可信 | 只能通过工具与提案；不得直接获得 shell、subprocess 或需求写入 |
| 项目原型代码 | 用户授权但不隔离 | 运行/安装是用户启动的可信代码执行，可写用户可写的位置；DSH sandbox 不覆盖 |
| 外部编辑器/进程 | 不受控 | 只能做版本检测与条件写，不能保证跨进程原子 |
| 第三方插件/MCP | 默认不授予 | guard 默认拒绝其工具；启用前必须单独评审 |

目标不是防御恶意本机用户，而是保证：模型不能绕过用户审阅改需求/CONTEXT，原型 AI 只能改本项目 `原型/`，运行只结束本应用启动的进程，错误不伪报。

## 2. 工具通道矩阵

| 通道 | 实际限制位置 | 需求会话 | 原型会话 | 未绑定项目会话 |
| --- | --- | --- | --- | --- |
| `read`/`read_image`/`glob`/`grep` | 工具层 guard + 读取路径；fs 读不设栅栏 | 允许项目根内（敏感文件除外） | 允许项目根内；搜索需按文件忽略敏感/依赖 | 拒绝 |
| `write`/`edit` | preset 是否注册 + guard 路径白名单 + fs-sandbox 项目根 | 不注册、guard 拒绝 | 允许 `原型/` 内；保护目录拒绝 | 拒绝 |
| `pwsh`/`bash`/shell | guard 工具名白名单 | 拒绝 | 拒绝 | 拒绝 |
| `run_code`/PTC | guard 工具名白名单 | 拒绝 | 拒绝 | 拒绝 |
| `spawn_agent` | guard 工具名白名单 | 拒绝 | 拒绝 | 拒绝 |
| MCP/第三方插件工具 | guard 默认拒绝 | 拒绝 | 拒绝 | 拒绝 |
| `ask_user_question`/`todo_write` | guard 控制工具白名单 | 允许 | 允许 | 允许（不触文件） |
| `eadp_requirements_list/read` | 工具注册 + Host 从真实 session 解析 Workspace | 允许 | 允许 | 不可用/拒绝 |
| `eadp_requirement_propose` | 工具注册 + 只写 Host 提案内存 | 允许 | 允许 | 拒绝 |
| `eadp_knowledge_search/read` | 工具注册 + 只读内置/用户知识包 | 允许 | 允许 | 允许（只读） |
| `eadp_knowledge_propose` | 工具注册 + 只写 Host 知识提案内存 | 允许 | 允许 | 允许（只提议） |
| 用户知识库新增/修改/删除 | Host 用户 UI 动作；不是 Agent 工具 | — | — | —（用户本机数据） |
| Host 保存/创建/删除 | 用户 UI 动作 + `ctx.fs`/Node fs 边界 | 允许项目根固定目标 | 不提供需求写入 | 不适用 |
| Host 原型 install/start/stop | 用户 UI 动作 + 受管进程 | 不适用 | 允许 | 不适用 |

**关键事实**：`ctx.tools.guard` 是单调拒绝，不能把已拒绝翻回允许，也不能改写参数；`tools/execute` 只能替换 signal。因此路径白名单必须在 guard 里按工具参数判定，不能靠“工作目录”或提示词。

## 3. 会话策略

### 3.1 预设

| preset | 工具面 | 用途 |
| --- | --- | --- |
| `eadp-requirements` | `tool-fs` 只读（`write:false,edit:false`）、`tool-fs-search`、知识/需求读取/提案工具、`ask_user_question`/`todo_write`、compaction | 需求讨论与提案；绝不直接写文件 |
| `eadp-prototype` | `tool-fs` 读写（write/edit 开启）、`tool-fs-search`、需求/知识工具、`ask_user_question`/`todo_write`、compaction | 原型实现；guard 限 `原型/` |
| 默认/未知 | 只读文件工具或按实际服务；不授予写 | 原生侧栏普通会话；不能借未绑定会话写项目 |

- 两个 preset 都不挂 shell、subprocess、run_code、MCP 或插件管理器。
- 基础 bundle 可能全局注册 `tool-pwsh`；即使被注册，guard 也会按工具名拒绝。不能以“预设没挂”作为唯一防线。
- 需求会话的只读 fs 与 guard 的写拒绝是双保险；原型会话的 write/edit 与 guard 的 `原型/` 白名单也是双保险。

### 3.2 guard 规则

每个项目会话在第一次模型请求前必须绑定 scope。绑定来源是真实执行会话，不是客户端参数：

1. 取 `exec.agent.session.header.cwd`；必须是绝对路径。
2. `realpath` 规范化；用 `workspaceRegistry.resolveByPath(cwd)` 找到 Workspace；找不到 → 拒绝文件工具（未绑定项目）。
3. 从会话 preset/role 取策略；未知角色 → 只读，不授予写。
4. 工具名不在该角色白名单 → 拒绝，并给出可执行的下一步（如“请在需求面板创建需求”）。
5. 控制工具（`ask_user_question`/`todo_write`）不触文件，允许。
6. 文件工具：
   - 参数取 `file_path`/`path`；必须是非空字符串，无 NUL。
   - `path.resolve(cwd, value)` → 对最深存在祖先 `realpath` → 再拼回不存在后缀；确保最终目标仍在 `workspace.path` 内。
   - 拒绝任何路径分量 `.git`；拒绝 `.env`、`*.pem/key/pfx/p12` 等敏感文件读取（`.env.example` 例外）。
   - `glob`/`grep` 的 `path` 同样校验；pattern 含 `..`/绝对路径/盘符/NUL 时拒绝。工具自身的搜索必须忽略 `.env`/密钥/`node_modules`/`.git`/`dist`；若固定 `tool-fs-search` 无法保证按文件忽略，则禁用 `glob`/`grep` 或登记缺口，不能只检查起始目录。
   - `write`/`edit`：相对项目根必须匹配 `原型/` 前缀；拒绝 `原型/node_modules/**`、`原型/.git/**`、`原型/.umi*/**`、`原型/dist/**` 等保护路径；拒绝绝对路径、`..`、大小写别名逃逸、符号链接逃逸。
   - 需求/CONTEXT/其他文件写入：拒绝。
7. `spawn_agent` 一律拒绝；不依赖子 Agent 继承策略。若未来启用，必须继承同一 scope 并在子 Agent 首次请求前重新解析。
8. 会话恢复：`agents.resume({resumeSessionId, setup})` 的 setup 必须重新注册 guard/context；若 resume 不触发 setup，用 `agent/created` 或显式恢复路径补齐。未注册 scope 的 Agent 不能获得文件工具。
9. scope 生命周期与会话/Workspace 绑定；Workspace 被移除/重新定位后旧 scope 不重定向；旧会话写旧路径或失败，不能写新项目。
10. guard 的拒绝原因要可诊断：说明是“未绑定项目/角色不允许/路径越界/保护文件/敏感文件”，不回显敏感内容。

### 3.3 动态上下文

Shell Host 为项目会话注册 `systemPrompt.context`（短文本，不是安全边界）：

- 需求角色：当前需求相对路径、版本提示；“修改必须使用 `eadp_requirement_propose`，不要直接写文件”。
- 原型角色：当前需求路径；“可读取其他需求/知识；只修改 `原型/`；不要执行命令”。
- 未选择需求：提示可用 `eadp_requirements_list` 查看。
- 上下文来自 shell 的活动文档登记（workspaceId → path），每次请求读取；不把正文整篇塞进系统提示。

## 4. Host 文件边界

- 所有 Host 文件操作先 `ctx.fs.resolve(path,{cwd:workspace.path})`，再 `ctx.fs.contains(root,target)`；拒绝根外目标。`resolve` 会 realpath 最深存在祖先，能发现链接逃逸。
- 需求/CONTEXT 保存：`ctx.fs.stat` 取当前版本 → `writeText(target,text,{kind:'replaceIfVersion',version},signal,{mode:'workspace-write',workspaceRoot:workspace.path})`；新建用 `createIfAbsent`。版本不符 → `FS_STALE_VERSION`；文件不存在 → 明确 absent；不静默创建。
- 目录创建/文件改名/删除：`ctx.fs` 没有这些抽象；Host 在 `resolve`+`contains` 后用 Node fs 完成，并在操作前后核对真实路径；这些操作不享受 `replaceIfVersion`，不能声称与外部进程原子。
- 读取：先 `stat` 判断文件/大小；非 UTF-8 → `FS_NOT_TEXT`；大文件按上限拒绝或截断。需求编辑器默认上限 2 MiB；原型只读查看默认上限 1 MiB。
- 客户端传来的路径永远相对 Workspace；绝对路径、盘符、UNC、`..`、保留名、控制字符一律拒绝。Host 不信任 Renderer 的 workspaceId 之外的身份。
- Host 是受信代码，但仍按用户动作执行；不把“保存/删除/运行”注册成 Agent 工具。

## 5. 需求与 CONTEXT 写入

- 需求会话预设不注册 `write/edit`；guard 再拒绝。AI 只能：
  - `eadp_requirements_list`：列 `需求/**/*.md` 与可选 `CONTEXT.md`；
  - `eadp_requirement_read(path)`：返回 text/version，并记录该会话读过；
  - `eadp_requirement_propose(path,baseVersion,text,summary)`：只写 Host 提案内存。
- 提案路径必须是 `需求/` 下 `.md` 或项目根 `CONTEXT.md`；路径不存在/不在项目内/未读/版本不符 → 错误，不生成。
- 应用提案必须由用户 UI 调用 `applyProposal`；Host 重新 `stat` 版本并 `replaceIfVersion`。用户点击是写入授权，但版本核对仍是独立条件。
- 需求会话不能借原型写入工具、shell、MCP、`run_code` 或第三方插件绕过；guard 按工具名与路径拒绝。
- 原型会话可以调用同一提案工具（发现需求问题时提议），但仍然只能写 `原型/`；提案不改变需求文件。

### 5.1 用户知识库

- 内置知识包只读，随发行；用户知识库是本机应用数据目录，不是项目内容，不受项目 Workspace 边界约束，但由 Host 的用户 UI 服务限制在注入的知识根内。
- 用户新增/修改/删除知识卡是用户 UI 动作；不注册为 Agent 写工具，AI 不能直接写知识。
- AI 可通过 `eadp_knowledge_propose` 生成新增/修改提案；提案只写 Host 内存，不写卡片/manifest。`update` 必须先读目标并带 baseVersion；内置卡拒绝。
- 用户点击“应用”后，Host 重新核对用户包版本/目标卡版本，再写卡片+manifest+hash+version；过时拒绝并保留提案；用户丢弃不写。
- 内置卡无编辑/删除入口；用户卡可编辑/删除；外部修改按 manifest/hash 检测，提示修复，不静默覆盖。
- 知识读取/搜索工具只读；知识正文是数据，不执行其中命令，不因知识内容放宽任何写入/运行权限。

## 6. 原型运行

### 6.1 授权与命令

- 创建工程、安装依赖、运行、停止都是用户点击的 Host 操作；不是 Agent 工具。
- 只支持模板约定的工程：`package.json` 有 `start` 脚本、存在 pnpm 锁文件；不提供任意 shell/命令配置。
- 固定 Node/pnpm 来自发行运行时（`prepare-eadp-tools`），不继承用户全局 PATH；cwd 固定为 `原型/`。
- 安装：`pnpm install --frozen-lockfile`；失败保留工程、锁文件与有界日志；不自动改锁、不自动升级。
- 运行：固定 `pnpm run start`；Host 选空闲端口并注入 `PORT`/host；若模板实际忽略端口，解析 stdout 的 loopback URL；只接受 `127.0.0.1`/`localhost` 且端口有效。
- 就绪：子进程未退出 + HTTP 可访问 + URL 属于本次启动；超时（建议 120 s）失败并保留日志。运行成功只表示可访问，不表示业务验收。

### 6.2 进程归属

- 每个 Workspace 最多一个受管运行；同一项目并发 start 合并为一次；start/stop 串行。
- 进程树由 Host 记录（pid、启动时间、端口、workspaceId）；停止只结束该树，先正常终止，超时后强制；不按端口杀未知进程。
- 应用退出停止所有本应用进程；运行状态不持久化为 running。强杀可能留下孤儿：启动时按 pid+启动时间核对，只对匹配的旧进程提供“停止上次运行”；不接管未知进程。
- 切换项目不静默停止旧项目运行；UI 显示运行归属/端口，用户可停止。旧项目运行不影响新项目。
- 原型代码本身是用户授权的可信代码执行，可能读写用户可写位置、访问网络；不能声称受 DSH 沙箱限制。AI 无 subprocess/shell 工具。

### 6.3 日志与诊断

- stdout/stderr 有界保存（每路建议 200 KB，保留尾部），显示在原型诊断区；不进入需求正文、不发送给模型。
- 失败状态保留实际原因、退出码、端口/进程身份和重试入口；不把失败包装成空页面。
- 日志可能含敏感信息；只在本机显示，不自动上传/不写入知识库。

## 7. 系统浏览器

- Host 返回的 URL 必须是本次运行产生、已核验的 loopback origin；客户端只对该 URL 调用 `window.open(url,'_blank','noopener,noreferrer')` 或等价系统打开。
- 不接受模型、用户输入或任意远端 URL；不恢复内嵌 WebContentsView/画布。
- 当前依赖 DSH desktop 主窗口对 `http/https` 的 `setWindowOpenHandler` 外开；这是固定宿主的既有行为，登记在仓库缺口清单（当前 `docs/blocked-upstream.md` 缺失，见 README 第 6 节）。若上游改变，需改用官方接口或明确失败，不 hack 主窗口。
- 浏览器打开失败保留运行状态与 URL，允许重试；不因此停止进程。

## 8. 审批、凭据与设置

- 模型、凭据、模型选择、sandbox 模式、approval 策略继续由 DSH 官方设置/服务管理；产品不另建审批、账号或权限系统。
- DSH 的 approval 主要处理沙箱升级请求；EADP 的 guard 在 approval 之后仍会拒绝越界路径，不能靠用户批准把需求写入放开。
- 本方案删除协同/发布后不再需要 EADP 自己的密钥；不保留 `studio-secret-store` IPC。模型凭据仍由 DSH 管理，不能清除或迁移。
- 不覆盖 `DSH_PERMISSION_MODE`；用户把会话设为 read-only 时原型 AI 写入会被 fs-sandbox 拒绝，如实显示，不偷偷提高模式。

## 9. 反向权限验收

使用验收专用 Workspace 与文件，不触碰真实业务成果。每个样本记录：工具名、sessionId、workspaceId、目标路径、操作前后文件摘要、工具返回/拒绝原因。

| 样本 | 操作 | 必须观察 |
| --- | --- | --- |
| 需求会话写需求 | 让模型调用 `write`/`edit` 改 `需求/x.md` | 工具未注册或 guard 拒绝；文件与 mtime 不变 |
| 需求会话写 CONTEXT | 同上改 `CONTEXT.md` | 拒绝；文件不变 |
| 需求会话写原型 | 同上改 `原型/src/a.ts` | 拒绝；文件不变 |
| 原型会话写原型 | 让模型改 `原型/src/a.ts` | 成功；运行页面可观察变化 |
| 原型会话写需求 | 让模型改 `需求/x.md` | guard 拒绝；需求不变 |
| 原型会话写背景 | 改 `CONTEXT.md` | 拒绝；背景不变 |
| 原型会话写其他项目 | 绝对路径/`..`/链接指向另一 Workspace | 拒绝；外部目标不变 |
| 原型会话写保护目录 | `原型/node_modules/...`、`原型/.git/...`、`原型/dist/...` | 拒绝；目标不变 |
| 符号链接逃逸 | `原型/link -> ../需求` 后写 `原型/link/x.md` | realpath 后拒绝；需求不变 |
| shell | 让模型调用 `pwsh`/`bash`（若存在） | guard 拒绝；命令未执行 |
| `run_code`/MCP/插件工具 | 若可用，尝试写项目 | guard 默认拒绝；记录工具是否真的可用 |
| 子 Agent | 让模型 `spawn_agent` | 拒绝；不产生未绑定的写通道 |
| 未绑定会话 | 在普通原生会话调用 read/write | 文件工具拒绝；聊天仍可用 |
| 知识搜索/读取 | 搜索/读取内置与用户知识 | 只读；不写项目/知识；未命中与损坏分开 |
| AI 知识提议 | 模型调用 `eadp_knowledge_propose` 新增/修改用户卡 | 只生成提案；用户未应用前文件/manifest 不变；内置卡拒绝 |
| Agent 直接写知识 | 用 `write/edit` 指向用户知识根，或尝试不存在的写工具 | 文件工具限项目根，应用数据目录被拒绝；没有 Agent 直写工具 |
| 用户知识库/应用 | 用户 UI 新建/编辑/删除；用户应用 AI 提案 | 写入本机知识根；内置只读；路径越界/超大/非 UTF-8 拒绝；过时提案拒绝 |
| 原型运行 | 用户点击安装/运行/停止 | 真实进程、真实 URL、真实停止；失败有日志 |
| 外部进程写需求 | 外部编辑器在保存/应用窗口写 | 检测到版本变化则拒绝覆盖；记录竞态窗口不被夸大 |

静态检查/构建通过不能替代以上真实桌面样本。工具不可用时记录“不可用”，不能冒充“已验证拒绝”。

## 10. 已知缺口与不承诺

1. **OS 级子目录写隔离不存在**：fs-sandbox 的 workspace root 是 session cwd（项目根）；`原型/` 的写入限制来自工具层 guard，不是内核边界。若放行 shell，OS 只能限到项目根，无法限到 `原型/`，因此本方案拒绝 shell。
2. **`ctx.subprocess` 无沙箱**：原型运行/安装可越界写；这是用户授权执行项目代码的固有风险，不声称隔离。
3. **`ctx.fs` 无 mkdir/rename/unlink**：Host 用 Node fs 在 containment 后完成；这些操作没有版本条件写保证。
4. **外部进程原子条件写不保证**：`replaceIfVersion` 只能缩小窗口，不能消除外部编辑器在检查与 rename 之间的写入。
5. **Workspace 不可搬移**：目录搬移 = 新 Workspace；旧会话历史不迁移；没有跨 Workspace 会话接口。
6. **系统浏览器打开无官方插件服务**：依赖固定 desktop 的 `window.open` 外开行为，已登记。
7. **插件/MCP 的间接执行**：guard 只能拒绝工具调用；第三方插件若自己 spawn 进程，不在本产品控制内。发行只装配受审包，不提供插件管理器。
8. **未绑定会话**：文件工具被拒绝；如果产品需要通用文件聊天，需要新的产品决定，不在本范围。
