# eadp-knowledge：内置知识卡与用户知识库

状态：目标设计，尚未实施。入口见 [方案总览](../README.md)；权限见 [permissions-runtime.md](../permissions-runtime.md)。

## 1. 职责与形态

为需求与原型会话提供只读知识参考和可追溯出处，同时允许用户按自己的情况维护知识：

- **内置知识包**：随应用发行、只读、版本化。少量人工整理的 Markdown 卡 + `SOURCES.md`，记录出处、适用范围、知识资产版本；不依赖用户机器上的 skill 或插件。
- **用户知识库**：本机应用数据目录中的用户 Markdown 卡。用户通过知识库页签新增/修改/删除，填写标题、出处、适用范围、标签；Host 维护 manifest、hash 与版本。Agent 可以读取并**提议**新增/修改，但不能直接写；用户确认后 Host 写入。
- 知识是参考资料，不是系统指令、不是项目事实，也不自动写入需求。用户知识库不是项目正文，不放在项目文件夹。

第一版不提供：上传平台、联网抓取、后台索引服务、向量库、嵌入模型、独立 MCP、知识审批、AI 直接写知识。更新由用户编辑、用户确认的 AI 提案，或发行替换整套内置包；不在运行中热替换半套索引。检索离线可用不代表模型离线。

形态参考 DSH Editor：少量人工整理的知识卡、来源清单、固定版本、只读读取工具、明确“advice 不是事实/权限”。EADP 在此基础上增加用户知识库与 AI 知识提案（用户确认写入），因此卡片数量与内容可由用户增长，而不需要改发行包。

## 2. 文件与存储

```text
packages/eadp-knowledge/
  src/index.ts            Cordis 服务/生命周期
  src/catalog.ts          加载/校验内置与用户包
  src/search.ts           查询归一化与排序
  src/read.ts             卡片读取与限额
  src/tools.ts            Agent 工具（defineTool）
  src/user-store.ts       用户知识库 manifest/卡片写入
  src/client/             知识库页签（搜索、列表、编辑）
  resources/builtin/
    manifest.json         内置包清单/版本/出处
    SOURCES.md            来源与整理说明
    cards/*.md            内置知识卡
  cordis.patch.yml
  package.json
```

用户知识库（本机，不随包）：

```text
<app-data>/knowledge/
  manifest.json           用户包清单/版本/卡片元数据
  cards/*.md              用户知识卡
```

- 内置包由发行装配打入插件资源；运行路径相对模块资源目录解析，不依赖 cwd/研发绝对路径。
- 用户知识库根由发行层注入的应用数据目录解析；不写项目文件夹、不写 `.eadp/`、不依赖 cwd。
- 用户知识库可备份/迁移；不提供自动 migration。`manifest.json` 带 `schemaVersion`，未来格式变化按新格式拒绝或明确提示，不静默改写旧文件。
- 用户可在 UI 中删除自己的卡片；内置卡片只读，不提供删除/编辑入口。

## 3. 卡片与清单

一张卡就是一份 Markdown 文档；首版不引入章节/分片索引，读取按整卡 + offset/length 续读。标题、出处、适用范围、标签属于卡片元数据，不写进正文，避免第二份正文。

```json
{
  "schemaVersion": 1,
  "packId": "builtin",
  "version": "2026.11.1",
  "documents": [
    {
      "id": "forms",
      "path": "cards/forms.md",
      "title": "表单设计约定",
      "source": "团队维护规范",
      "scope": "原型交互",
      "tags": ["表单", "校验"],
      "sha256": "<构建时写入真实 64 位 SHA-256>"
    }
  ]
}
```

- 内置包：`manifest.json` 与 `SOURCES.md` 一起维护；`id` 在包内唯一；`sha256` 在构建期校验，占位符不得进入发行产物。
- 用户包：`packId` 固定 `user`；`id` 在用户包内唯一；保存时写卡片、更新 manifest、递增 `version`；`sha256` 由 Host 计算。
- 跨包 `id` 不要求全局唯一；工具结果带 `packId`，避免冲突。
- `version` 是知识包版本，不是文件版本；统一用字符串。内置包用发行版本号（如 `2026.11.1`）；用户包用递增整数序列化为字符串（如 `"3"`），每次保存/删除卡片递增。用户编辑后旧引用明确提示已更新。
- 卡片上限建议 20,000 字符（内置可更短）；搜索摘要 ≤ 500 字符；读取默认 8,000、最大 16,000 字符，截断给 `nextOffset`，不跨 Unicode 边界。
- 内置卡片来源必须可追溯；示例必须标“示例”，不能当通用业务规则。用户卡片由用户负责出处；UI 提示填写 source/scope。

## 4. 搜索与读取

| 调用 | 输入 | 输出 |
| --- | --- | --- |
| `knowledge.search` / `eadp_knowledge_search` | query，limit（默认 5、上限 20），可选 `pack`（builtin/user/all） | packId、packVersion、hits：documentId、title、excerpt、source、scope、sha256 |
| `knowledge.read` / `eadp_knowledge_read` | packId、documentId、可选 expectedPackVersion、offset/length | 正文、出处、packId、packVersion、sha256、实际范围、truncated、nextOffset |
| `knowledge.catalog` | 可选 pack | 目录摘要与版本；不返回全部正文 |

- Agent 只注册搜索/读取两个工具；知识库页签通过本地服务读取目录/卡片，不另开 HTTP。
- 中文检索：NFKC、拉丁字母大小写归一、中文连续片段/双字词候选；标题/标签/原文短语优先，再按命中排序；同分按 packId、documentId 稳定排序。只归一检索字段，返回原文；不自动简繁转换；不把相关度说成正确率。
- 空查询/过长/全无效字符 → 参数错误；零命中是成功 + 空 hits。
- `expectedPackVersion` 与当前包不一致 → `VERSION_MISMATCH`，不把新内容冒充旧引用。
- 搜索/读取覆盖内置与用户两个包；用户编辑后重新加载索引，下一次工具调用看到新版本。

## 5. 用户知识库 UI

知识库作为工作台第三个页签（`eadp.knowledge.view`），由 knowledge 包注册；Shell 只声明 slot/页签。

| 区域 | 行为 |
| --- | --- |
| 搜索 | 关键词搜索两个包；显示命中、出处、版本；点击打开卡片 |
| 列表 | 分组“内置知识/我的知识”；内置只读标记；用户卡可编辑/删除 |
| 查看 | 展示卡片正文、source、scope、tags、packVersion；长文按 offset 加载 |
| 新建/编辑 | 用户填写标题、出处、适用范围、标签、Markdown 正文；保存时 Host 校验并写用户包 |
| AI 提议 | 显示待审阅提案（新增/修改）；打开差异/全文；应用/丢弃；过时提案标记 |
| 删除 | 用户确认后删除用户卡并更新 manifest；内置卡无删除入口 |
| 刷新/修复 | 外部文件变化或 manifest/hash 不符时，提示具体卡片；用户可选择重新计算 hash/修复清单；内置包损坏不提供“修复”，报发行资源问题 |

- UI 写入是用户动作，不是 Agent 工具；Host 校验路径在用户知识库根内、ID 唯一、大小/编码、manifest 可写。
- AI 可以提议知识新增/修改；提案只有在用户点击“应用”后才由 Host 写入用户知识库。内置卡不可被 AI 修改；AI 可新建用户卡来适配自己的场景。
- 用户知识库是本机数据；应用重启后仍在；不随项目文件夹复制；备份由用户负责。

### 5.1 AI 知识提议（用户确认写入）

工具：`eadp_knowledge_propose`，在 `agent.ctx` 注册，需求/原型会话可用；guard 放行但只能生成提案，不能写文件。

| 输入 | 语义 |
| --- | --- |
| `action` | `create` 或 `update`；首版不支持 AI 删除 |
| `documentId` | `update` 必填；必须是用户知识库现有卡片；内置卡拒绝 |
| `baseVersion` | `update` 必填；来自该会话最近一次 `eadp_knowledge_read` 的 packVersion；`create` 省略 |
| `title` / `source` / `scope` / `tags` | 卡片元数据；title/source/scope 必填 |
| `text` | Markdown 正文；非空、大小上限 |
| `summary` | 给用户看的一句话变更摘要 |

流程：

1. `update` 前必须先 `eadp_knowledge_read` 目标卡；Host 记录该会话读到的 packVersion。
2. `create` 直接生成提案；Host 生成 `documentId`，避免 AI 选择冲突 ID。
3. `update` 时 Host 校验：目标在用户包、不是内置卡、`baseVersion` 等于记录值与当前 packVersion；否则 `VERSION_MISMATCH`“知识已更新，请重新读取”。
4. 提案只写 Host 内存：`proposalId`、action、target=`user`、documentId、baseVersion、草稿字段、差异、summary、createdAt、sessionId。
5. 工具输出只含 `proposalId/action/title/summary`，提示“请在知识库页签审阅”；不写卡片/manifest。
6. 用户在知识库页签应用：Host 重新核对用户包版本与目标卡版本；`create` 用 `createIfAbsent` 语义写卡片+manifest，`update` 用版本条件替换；成功后递增 packVersion、删除提案、刷新索引。
7. 版本过时/用户已编辑/其他提案先应用：不写；保留提案与当前知识卡，标“过时”，可重新读取生成。
8. 用户丢弃：只删内存提案；用户知识卡不变。
9. 提案不持久化；重启丢失，聊天历史仍可让 AI 重新生成。
10. 内置知识包只读；AI 不能提议修改/删除内置卡；要适配时新建用户卡，并在 source 中注明参考来源。

- 用户确认是写入授权，但不替代版本核对；Host 必须独立比较 packVersion/目标卡版本。
- 首版 AI 不删除知识卡；删除仍由用户在 UI 执行。
- 同一用户包可有多条提案；应用一条会使其他旧版本提案过时，不自动合并。`baseVersion` 使用用户包整体版本，因此任何用户知识变更都会使旧的 update 提案过时；这是保守取舍，避免把提案覆盖到已变化的知识库。
- 知识提案不是需求提案：不写项目文件，不需要项目 Workspace；但同样只在 Host 内存、用户确认后落盘。

## 6. 权限、错误与版本

- 知识读取/搜索工具只读；`eadp_knowledge_propose` 只写提案内存，不能写卡片/manifest；没有 Agent 直接写知识的工具。正文中的“忽略前文”等按引用数据呈现。
- 知识工具在 `agent.ctx` 注册；guard 放行 `eadp_knowledge_search/read/propose`；需求/原型会话都可用。
- 用户知识库写操作只存在于 Host 的 UI/应用提案服务；不注册为 Agent 写工具；路径必须限制在注入的用户知识库根。
- 内置卡没有写路径；用户卡由用户 UI 或用户确认的提案写入。
- `defineTool` 必须提供 `output.schema` + `output.render`；对象 schema 显式 `additionalProperties`；必填 `required: true`；execute 传递 `exec.signal`；注册用 effect，卸载清理。
- 错误：`INVALID_ARGUMENT`、`NOT_FOUND`、`VERSION_MISMATCH`、`RESOURCE_INVALID`、`UNAVAILABLE`；取消沿运行时取消机制传播，不伪装零命中。
- 内置包损坏只阻止内置知识；用户包损坏只阻止用户知识；需求编辑/原型运行继续。界面显示真实原因与可执行操作。
- 用户包外部编辑：发现 manifest/hash 不符时提示“知识卡已在外部修改”，提供重新计算/修复；不静默覆盖用户文件。
- 知识不是需求依赖门禁；不要求每份需求绑定知识；不把知识写入需求正文。

## 7. 发行与内容

- 内置包随发行装配：编译入口、patch、`resources/builtin`（manifest、SOURCES、cards）；发行脚本生成/校验 hash，核对实际装入文件。
- 初始内置卡片由团队确认，少量、带出处；用户知识库可由用户维护，也可由 AI 提议、用户确认写入。没有完整业务文档集不再阻塞机制与用户知识库验收，但内置卡不能用旧产品设计文档/未标注示例冒充业务规则。
- 用户知识库位于应用数据目录，不打包、不发布、不写项目；删除应用数据会丢失用户知识，需在文档/UI 提示备份。
- 依赖固定 DSH rc.2；不使用 latest/Editor rc.5；不引入向量库/嵌入服务。
- 现有旧场景资料/Office 抽取不迁入知识包；知识包不复活场景/确认/交接。

## 8. 实施顺序

1. 定义 contracts：KnowledgePack/Card/Draft/Proposal/Reference/Hit/Read、错误码、`eadp.knowledge.view` slot。
2. 实现内置包 manifest/校验/卡片读取；实现用户包存储（manifest/hash/version）与目录服务。
3. 实现搜索/读取索引（内置 + 用户）；接入 Agent 搜索/读取工具与 guard。
4. 实现知识提议：`eadp_knowledge_propose`、提案内存、版本核对、应用/丢弃；记录会话读取版本。
5. 实现知识库页签：搜索、列表、查看、用户新建/编辑/删除、AI 提案审阅、刷新/修复。
6. 更新发行装配/校验；完成用户知识库、AI 提案与内置包的桌面验收。

## 9. 验收

真实桌面/人工清单（尚未执行）：

- 内置卡：搜索/读取/引用/版本/出处；篡改 hash/缺失卡片 → 构建失败或明确不可用。
- 用户卡：新建、编辑、删除；标题/出处/范围/标签；保存后搜索命中、引用带版本；重启后仍在。
- AI 提案新增：AI 生成新卡提案 → 文件/manifest 不变 → 用户应用后出现；丢弃则不变。
- AI 提案修改：先读取用户卡；生成提案（带 baseVersion）→ 用户应用后更新；版本过时/用户先改 → 拒绝写入并保留提案。
- AI 提案边界：内置卡不可被 AI 修改；不存在的 documentId/未读取/越界/超大/空正文 → 拒绝；AI 无直接写工具。
- 中文：短语“必填校验”、混合词“API超时”、单字、标点、同标题、零命中；排序稳定。
- 续读/超长/取消；截断、出处、nextOffset 正确。
- 版本：用户编辑/提案应用后旧引用 `VERSION_MISMATCH`；外部文件变化提示修复；manifest 损坏不覆盖用户文件；提案重启丢失且不伪造。
- 边界：重复 ID、目录穿越、符号链接、超大卡、非 UTF-8；内置包只读；用户包路径限制。
- 权限：Agent 搜索/读取只读，`propose` 只写提案内存；没有 Agent 工具能直接新增/修改/删除知识；用户 UI/应用提案写入不进入项目目录。
- 离线：内置/用户知识可搜索读取；模型在线失败不表述为知识库失败。
- 需求/原型会话检索知识、展示引用；用户未操作时文件不变；知识故障不阻断编辑/运行。
- `pnpm check` + 受影响构建；不新增测试代码/测试命令。

## 10. 完成标准

固定发行产物能真实搜索/读取/引用内置知识；用户能在知识库页签新增/修改/删除自己的卡，AI 能生成新增/修改提案且必须由用户确认后才写入；重启后用户知识与版本继续可用。Agent 没有直接写知识的工具，版本与出处可追溯，边界不被绕过。只有文档、manifest 或工具声明不算完成；内置初始卡片内容需团队确认，用户知识库不能作为“知识完整”的替代声明。
