# 材料确认修复设计：状态记录、卡死恢复与自动合并

日期：2026-10-26。来源：远端提交验收发现的三项缺口，本文档是修复的唯一权威设计。

## 验收缺口回顾

1. 本地材料 git 状态变化不向协同后端记录，后端也没有接收端点。
2. 确认提交后「待核对：确认已提交，正在核对原结果」可永久卡住：后台集成异步失败时真实错误不透传到确认视图，且无任何自动重试出口。
3. 远端 head 分叉时集成直接报错「Git 集成头已变化」（`git-integrations.ts:130`），无自动合并、无合并提示、无 AI 冲突处理。

## 已确认的决策

| 决策点 | 结论 |
| --- | --- |
| 修复范围 | 三项全做 |
| 摘要来源 | git 变更机械生成为主，AI 可用时补充语义描述，总长 ≤500 字 |
| 冲突处理 | AI 直接产出合并结果，不要求用户二次确认 |
| 状态记录时机 | 只在动作点记录（占用开始、保存成功、确认提交前），不做持续观察 |
| 合并方案 | git 三路合并（merge commit），非重放式 |

## 一、本地材料 git 状态记录（后端纯记录）

### 后端（apps/collaboration-api）

- 新追加型记录表 `studio_material_status_reports`：
  - `id`、`project_id`、`entity_id`；
  - 触发动作枚举 `studio_status_trigger AS ENUM ('occupation-start','save','pre-confirmation')`；
  - `base_head`、`worktree_head`（各 40 位 SHA）、`changed_path_count`、`summary varchar(500)`；
  - 创建四审计字段（`creator_*` / `created_date`），遵循 `db/schema.sql` 现有约定：状态用枚举、COMMENT 不超过 10 字。
- 路由：
  - `POST /v1/projects/:projectId/entities/:entityId/status-reports`，幂等沿用 `studio_operations` 键模式；
  - `GET …/status-reports`（项目/实体维度查询，供界面展示）。
- service 层只做认证、权限、实体存在性校验，**不含业务逻辑**——后端是纯记录方。
- 契约：`packages/contracts` 新增 TypeBox Schema 与 View 类型，`summary` 上限 500。

### Host（packages/studio-plugin/src/host）

- 三个动作点采集该实体材料的 git 状态（相对 base 的变更路径、worktree head）：
  1. 占用开始（claim 成功）；
  2. 需求保存成功；
  3. 确认提交前。
- 摘要生成：
  - 机械部分（确定性兜底）：变更文件清单与状态（新增/修改/删除）；
  - AI 补充：`compareConsistency` 同款一站式推断端口可用时追加一句语义描述；
  - 拼接后截断至 500 字。
- 上报失败本地留存、按现有 pending/重试模式恢复。

## 二、待核对卡死修复

- **错误透传**：`GitIntegrations.run` 失败时已把集成操作置 `phase='unknown'` 并记录真实 message；在 `MaterialConfirmations.advance` 的 child 检查处把 child 的真实错误同步进确认操作的 message，`view()` 优先呈现真实错误，不再只显示「确认已提交，正在核对原结果」。
- **自动恢复出口**：`state()` 投影读取时对 `phase='unknown'` 的集成操作重新 `schedule`（BackgroundLane 的失败 key 不记忆，天然支持下次读取重试）；加最小重试间隔（60 秒）防止前端 10 秒轮询放大请求压力。手动「查询并恢复」按钮降级为兜底。
- 分叉类失败不再滞留待核对——直接进入第三节的自动合并子流程。

## 三、分叉自动合并 + AI 冲突处理

`publish` 发现远端 head 分叉（`head !== expectedHead && head !== candidateSha`）时，替代现有抛错，转入合并子流程：

1. fetch 稳定分支，取新远端 head；
2. `WorkspaceGit` 新增 `merge` 能力，在原任务 worktree 内 `git merge <新head>`；
3. **合并干净**：merge commit 作为新候选——第一父为新 head、diff 仍限于本材料 allowedPaths，后端 `verifyCandidate` 现有校验天然兼容，**后端零改动**。重新生成检查证据（material 重算 materialEvidence，prototype 走 `ports.checks`），以新幂等键重新 prepare，继续原集成流程；
4. **存在冲突**：复用现有 AI 会话通道（`ports.session`/`prompt`，同 requirement-candidates、scenario-repairs 模式），指令 AI 在 worktree 内直接产出冲突文件的合并结果，`git add` 后完成 merge commit，回到第 3 步。AI 失败或超时：确认操作进入 recovery，保留现场并报告真实错误，不自动重试 AI；
5. **用户提示**：自动合并与 AI 合并的文件清单记入确认操作，确认视图呈现「已自动合并：X、Y；AI 合并：Z」；
6. 原候选对应的旧集成记录标记为被新候选承接（superseded 语义），幂等键不复用；
7. 任务现场已销毁（worktree 不存在）时无法合并：保留现有报错与人工恢复出口。

## 四、错误处理原则

- 任何一步失败都保留本地现场，报真实错误，不回滚用户改动（沿用 syncMain 的"绝不覆盖本地工作"原则）。
- 幂等键一律一次性；重试走"核对原结果 → 未发生则重发"的现有模式。

## 五、测试

- 后端：status-reports 路由、幂等重放、500 字上限、越权拒绝（`tests/collaboration/`）。
- Host：合并子流程三种走向（干净合并 / AI 解决冲突 / AI 失败保留现场）、失败透传到确认视图、自动重试间隔生效（沿用 `tests/` 现有 Host 测试模式）。
