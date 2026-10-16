# Linux 工作站：G0 后端问题交接

2026-10-16。用户已明确：数据库不用双作者协同验收；Windows 负责桌面修复，协同后端由 Linux 工作站负责。本轮没有修改 `apps/collaboration-api` 或数据库 schema，也没有对真实 GitLab/数据库写入。

## 待处理项

| 原验收 ID | 问题与依据 | Linux 复验要求 |
| --- | --- | --- |
| A04 | [Linux 部署交接](local-collaboration-deployment.md) 已记录真实登录、精确邮箱绑定 GitLab ID 70、会话恢复与撤销；真实 private 建仓到本机首 push 后 ready 尚未闭环 | 沿用已核实身份与既有权限，按当前严格契约验证 private 建仓、本机首 push 后 ready；不猜测绑定 ID 或放宽唯一匹配 |
| A07 | `CollaborationService.claim` 未读取实际稳定头；已有离线复现在旧集成 aborted、Git 头与认可头分歧时仍允许新 prototype claim | 修正孤立 Git 状态下的后继门禁，并验证管理员释放、响应丢失、旧代次和核对恢复；Windows 本轮不替代服务端判断 |
| A08 | `CollaborationService.state` 返回未确认实体标题及元数据，未落实其他成员只见占用状态的既定可见性 | 收口查询响应及可信身份授权，补适用的角色/成员查询负向用例；不把元数据缺口扩大描述为已读到完整 MD 正文 |

A03 的“数据库必须双作者协同验收”要求已由用户撤销，不要求为本次验收扩展测试账号、建立第二位作者或增加双作者数据库测试。不要把该项继续列为 Windows 或数据库验收阻断。

## 现有证据

- [首次审计报告](../acceptance/g0-2026-10-15.md) 保留发现过程和证据边界。
- 本机 `.local/acceptance/g0-review-20261015/backend/probe.ts` 与 `result.json` 复现 A07/A08；使用真实 service/repository/domain、内存 SQL/GitLab adapter，未运行真实事务/网络故障时序。合成第二 actor 仅用于证明响应裁剪缺口，不形成新的数据库双作者验收要求。
- Windows 桌面修复报告另行记录；Windows 工具链、模板、Electron 和安装包通过不能据此宣布后端修复通过。

后续在同一研发仓库及任务分支交接，不复制 Windows 依赖、缓存、凭证、运行数据库或完整 AI 会话。
