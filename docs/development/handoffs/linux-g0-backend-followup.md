# Linux 工作站：G0 后端问题交接

2026-10-16。用户已明确：数据库不用双作者协同验收；Windows 负责桌面修复，协同后端由 Linux 工作站负责。本轮没有修改 `apps/collaboration-api` 或数据库 schema，也没有对真实 GitLab/数据库写入。

## 2026-10-16 A07/A08 修复记录

分支 `feat/g0-backend-consistency`。原则：认领等变更入口必须与后端认可头一致；未确认材料对其他成员只暴露占用状态（02-项目架构.md 可见性边界）。

- **A07**：`CollaborationService.claim` 在授权之后、mutate 之前增加与 `prepare` 同款的 `UNRECOGNIZED_GIT_HEAD`（409）点检：实际稳定分支头必须等于 `recognizedHead`。一次性点检、非锁；管理员释放占用不清除该门禁，reconcile 恢复后认领放行。
- **A08**：`EntityView` 新增 `authorId`（`reserve` 记录创建者）；contracts 新增 `EntityOccupancyView`；`state()` 返回前经 `modules/visibility.ts` 投影——非作者且未确认的实体只返回 `{id, kind, revision, taskStatus, occupation?}`，标题/分类/关系/确认内容不外泄；已确认实体对项目内全员开放；管理员与其他成员同一可见性规则。`studio-plugin` 消费方按联合类型做 `'title' in` 等最小窄化，他人未确认草稿不再渲染进目录。
- 持久化：实体为 jsonb，`authorId` 仅新字段，无 DDL/迁移；存量行按非作者处理（规则 0，不留兼容）。

证据（真实一次性 PostgreSQL + 测试私有 GitLab fixture；合成 actor 仅用于跨作者可见性，不扩测试账号）：

| 检查 | 结果 |
| --- | --- |
| `backend-consistency.test.ts`（新增） | 9/9：A07a 正控 / A07b 分歧拒绝且实测读取分支头 / A07c reconcile 恢复后放行 / A07d 释放不清门禁；A08a 作者全量 / A08b 他人裁剪键集精确且标题串不出现 / A08c 非作者 admin 同等裁剪 / A08d 确认后对全员开放 |
| `backend-lifecycle.test.ts`（追加 HTTP 用例） | 分歧头下 claim 409 `UNRECOGNIZED_GIT_HEAD`，恢复后 200；原 8 用例保持绿 |
| `pnpm --filter @eadp/collaboration-api typecheck`、DSH Host/Client tsc、platform-git 3/3、task-recovery 19/19 | 通过 |

边界：以上为内存 fixture 与合成 actor 下的语义验证；未声称真实 PostgreSQL 竞态时序或企业 GitLab 行为。**A04（真实 private 建仓→本机首 push→ready 闭环）仍开放**，需部署本修复后按已核实身份执行。

## 待处理项

A04、A07、A08 已于 2026-10-17 在真实运行服务（systemd + 持久 pg17 + 真实企业 GitLab）完成闭环与复验，证据与边界见 [G0 Linux 复验报告](../acceptance/g0-linux-2026-10-17.md)：A04 建仓→本机首 push→ready 通过（测试仓库登记已清理，GitLab 项目 4024 的删除待有权限者执行）；A07 孤立头阻断/树一致核对/纠正后放行全链路通过；A08 在真实 pg17 上以合成 actor 验证（单账号不产生第二作者真实 HTTP 用例，A03 已撤销）。Windows 侧 alpha.4 + 界面改版构建的安装/首启复验与 G0-5 端到端证据仍为 G0 未闭环项。

A03 的“数据库必须双作者协同验收”要求已由用户撤销，不要求为本次验收扩展测试账号、建立第二位作者或增加双作者数据库测试。不要把该项继续列为 Windows 或数据库验收阻断。

## 现有证据

- [首次审计报告](../acceptance/g0-2026-10-15.md) 保留发现过程和证据边界。
- 本机 `.local/acceptance/g0-review-20261015/backend/probe.ts` 与 `result.json` 复现 A07/A08；使用真实 service/repository/domain、内存 SQL/GitLab adapter，未运行真实事务/网络故障时序。合成第二 actor 仅用于证明响应裁剪缺口，不形成新的数据库双作者验收要求。
- Windows 桌面修复报告另行记录；Windows 工具链、模板、Electron 和安装包通过不能据此宣布后端修复通过。

后续在同一研发仓库及任务分支交接，不复制 Windows 依赖、缓存、凭证、运行数据库或完整 AI 会话。
