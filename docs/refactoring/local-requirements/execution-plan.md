# 全局重构执行计划（静态验证版）

状态：执行计划，待执行。设计依据为本目录 `README.md`、`architecture.md`、`evidence.md`、`user-flows.md`、`permissions-runtime.md`；切片行为与删除范围以 `implementation.md` 为准。本计划只做一处实质调整：**全部验证改为静态验证，不做任何真实桌面/运行时验证**；原设计中的桌面验收与前置核实项按第 4 节规则移交。本文件是过程文档，在阶段 7 与其它过程文档一并删除。

## 0. 目标与边界

- 完成“本地需求与原型工作台”改造：`eadp-shell` / `eadp-requirements` / `eadp-prototype` / `eadp-knowledge` / `eadp-contracts` 新包替代 `packages/studio-plugin`、`packages/asset-domain`、`apps/collaboration-api`；最终发行只装配新实现。
- 验证边界：只做静态验证——根 `pnpm check`、受影响包 `tsc --noEmit`、受影响插件构建；阶段 6 增加 `pnpm build:desktop` 装配校验。**不启动桌面、不跑真实模型、不做任何运行时行为验收。**
- 不宣称任何桌面行为“完成”或“生产就绪”；未验证项集中登记在最终文档，逐条可核对。

## 1. 硬约束（来自仓库 AGENTS.md 与权威技能，全程有效）

1. 动手前读 `.agents/skills/creating-dsh-plugins/SKILL.md`；Client 半边以官方 dual-face 契约为准，不猜测 slot/service 签名。
2. 只通过官方 slot/service/seam 扩展；官方接口不足时登记 `docs/blocked-upstream.md` 标记 blocked-upstream，不 hack。
3. 不保留兼容层、migration、fallback、双模式、旧 API 模拟；过时实现直接删除。
4. 工具 API 硬规则：`defineTool` 必须提供 `output.schema` + `output.render`；必填字段 `required: true`，禁止 `required: false` 与 required 数组；对象 schema 显式 `additionalProperties`。
5. 仓库不新增测试代码与测试命令。
6. 上游修改唯一通道是 `apps/desktop-distribution/build/` 的 fail-closed 锚定编辑；锚点缺失即失败；每条编辑在 `build/README.md` 记录用途。
7. 涉及 `cordis.patch.yml` 必须显式声明依赖的 service 与 slot。
8. 删除前按引用核查实际调用方，不只删菜单；先保护无法从 Git/锁定制品重建的唯一成果。
9. 不推送、不发布；是否本地提交由执行人按阶段决定（建议每阶段一次，便于回溯）。

## 2. 阶段划分

### 阶段 0：静态前置核实（替代原切片 0 的桌面核实）

用 `.local/upstream/dsh/` 固定 rc.2 源码做纯静态核对（只读，不改上游缓存）：

| 核实项 | 核对内容 |
| --- | --- |
| Workspace 服务 | `workspaceRegistry`、`workspaceController`、`ui-workspace`、`fs-sandbox`、`sandboxPolicy` 是否包含在 desktop profile/bundle 装载链 |
| 会话绑定 | `sessionController.create({workspaceId,agentPreset})`、`agents.create(meta.cwd)`、`attachSession` 的签名与 cwd 相等校验源码 |
| `ctx.fs` | `resolve/contains/stat/readText/listDir/watch/writeText` 与 `createIfAbsent/replaceIfVersion`、`FS_STALE_VERSION` 等错误码 |
| 工具与守卫 | `ToolGuard`、`ctx.tools.guard/restrict`、`tools/pre-execute` 语义、`tool-fs` 配置面、guard 参数不可改写证据 |
| 工具 schema | `defineTool` 对 `output.schema/render`、`required:true`、`additionalProperties` 的校验 |
| 客户端扩展 | 官方 slot 名单、`ctx.uiWorkspace`、`ctx.workspaces`（client）、Typert Remote 生成机制 |
| 桌面品牌 | `DSH_HOME`/`userData` 编辑点、`window.open` 处理代码位置（仅定位，不运行） |

产出：

- 重建 `docs/blocked-upstream.md`：缺口、当前绕过、涉及锚定编辑逐条登记。
- 无法静态核实的项（运行时行为、真实模型、Windows 进程/端口等）写入第 4 节未验证清单的文档落点。
- 门禁：`pnpm check` 通过。发现接口与 evidence.md 不符时，以源码为准修正 evidence，并同步相关设计段落。

### 阶段 1：包骨架、契约与装配（原切片 1）

- 新建 `packages/eadp-shell`、`eadp-requirements`、`eadp-prototype`、`eadp-knowledge`、`eadp-contracts` 骨架；`eadp-contracts` 先落 ProjectId/SessionRole/slot 名/基础错误码。
- `eadp-shell`：首页 Workspace 列表、工作台布局、原生会话承载（Host 侧 agent setup/guard/动态上下文骨架）；`flushActive` 空实现占位。
- `desktop-distribution`：新插件装配最小骨架；新面板是唯一入口；协同登录、旧阶段导航、协同设置项不进新装配。
- 门禁：各包 `tsc --noEmit`、`pnpm check`、受影响插件构建。

### 阶段 2：需求编辑与保存（原切片 2，无 AI）

- `eadp-requirements` Host：`ctx.fs` 读/版本写 + Node fs 目录/改名/删除（containment、敏感路径拒绝）；Client：文件树、编辑器、DraftBuffer 抽象复用（去场景字段）、IME、外部改动、离场 flush。
- 删除范围按 implementation.md 切片 2：远端三阶段保存、metadata/模板/来源/候选/门禁链路；保留并抽象 DraftBuffer。
- 门禁：同阶段 1。

### 阶段 3：AI 需求提案（原切片 3）

- `eadp_requirements_list/read`、`eadp_requirement_propose` 工具（遵守工具 API 硬规则）；提案内存、apply/discard、版本核对；提案面板与行级 diff。
- 需求角色 guard：write/edit 关闭 + 工具级拒绝。
- 删除：聊天代码块提案解析、章节确认/选择性应用、来源/候选链路、不再需要的 `session/prompt-admission` 编辑。
- 门禁：同阶段 1。

### 阶段 4：原型创建、查看、运行与停止（原切片 4）

- `eadp-prototype`：模板复制（不覆盖非空）、只读文件树/查看与过滤、受管进程原语抽取、固定 `pnpm run start`、端口/就绪、停止进程树、运行状态表。
- 删除：preview/checks/generation/publication/snapshot、画布、浏览器运行时与自动验收、playwright/Chromium 资源。
- 门禁：同阶段 1。

### 阶段 5：原型 AI 守卫与知识库（原切片 5）

- 原型角色 guard（限 `原型/`、拒 shell/run_code 等）；需求读取工具复用。
- `eadp-knowledge`：内置只读卡 + 用户知识库（manifest/hash/version）、搜索/读取工具、`eadp_knowledge_propose` 提案/应用、知识库 UI。
- 删除：prototype-collaboration 及候选/基线/复用/交接全链路、旧资料导入转换。
- 门禁：同阶段 1。

### 阶段 6：旧实现退役与发行（原切片 6）

- 删除 `packages/studio-plugin`、`packages/asset-domain`、`apps/collaboration-api` 及 db/部署入口/协同客户端/凭据键/旧契约 schema。
- 原型模板移入 `packages/eadp-prototype/assets/`，移除 preview 专用脚本，更新 manifest 与 `pnpm check` 路径。
- 锚定编辑逐条复评：删除协同策略/秘密 IPC/设置桥/画布浏览器/消息准入等失效编辑；保留品牌、插件装配、运行时资源、打包/typert。
- 门禁：`pnpm check`、受影响构建、**`pnpm build:desktop` 装配通过**（不安装、不运行）。

### 阶段 7：文档与事实清理（收尾，含本计划的删除）

1. 删除 `docs/refactoring/` 全部内容（本计划随之删除）；设计文档不作为现行规范保留。
2. 同步根 `README.md`、`CONTEXT.md`、`AGENTS.md`：移除协同/场景/确认/基线/交接/任务/浏览器验收叙述；结构表改为新包；生产门槛改为本地闭环（写明桌面验收未执行、逐项未验证清单所在）。
3. `docs/blocked-upstream.md` 与实际锚定编辑逐条对账，只保留真实存在的缺口与绕过。
4. `apps/desktop-distribution/build/README.md` 逐条记录保留/新增编辑的用途、锚点、失败行为。
5. 全库描述与代码事实核对：规模数字、路径、包名、命令、slot 名；删除一切与最终代码不符的描述。
6. 最终门禁：`pnpm check` + `pnpm build:desktop`；未验证项清单落盘在 AGENTS 或 README 指定位置。

## 3. 每阶段通用门禁

- `pnpm check` 必须通过；受影响包 `tsc --noEmit`；受影响插件构建（Host→Client 顺序、Typert 生成）。
- 门禁失败即停止修正，不绕过、不手工改 `.local/` 或装配树冒充通过。
- 不新增测试代码/命令；静态验证结果记入阶段说明，不伪报运行时行为。

## 4. 桌面验收项移交规则

原 `implementation.md` 第 2 节（前置核实）、各切片“真实桌面验收”、第 5/6 节验收矩阵与竞态样本，全部不做。移交方式：

- 能在 rc.2 源码中静态核对的：阶段 0 核对，结论写入 blocked-upstream 或设计修正。
- 不能静态核对的（guard 真实通道覆盖、`ctx.fs` Windows 行为、`window.open`、Umi 端口/就绪、进程树停止、会话恢复、真实模型闭环、知识检索与提案运行时行为等）：集中列入最终 `AGENTS.md`（或 README 指定小节）的“未验证项”清单，逐条写明要核实的操作与预期；在这些项通过前，任何文档不得宣称对应能力完成或生产就绪。

## 5. 完成标准（静态版）

- 新五包替代旧三包，发行只装配新实现；`pnpm check` 与 `pnpm build:desktop` 通过。
- 仓库中不存在与代码事实不符的描述；过程文档（含本计划）已删除；仍有效决策与未验证缺口有简明入口可定位。
- 未验证项清单完整落盘；明确声明：静态验证通过 ≠ 桌面验收通过 ≠ 生产就绪。
