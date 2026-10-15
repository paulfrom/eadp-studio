# 协同登录与 GitLab 项目初始化交接

2026-10-15，用户逐项确定并授权实施：当前业务托管保持 GitLab，工作台只登录协同后端，由后端绑定既有 GitLab 账号并管理建仓/成员；本机用户 Git 凭据完成初始化和推送。此前候选 GitHub 实现/文档不合入当前代码；本记录不改写旧 OAuth 检查事实。

## 当前契约

- 默认测试管理员为 `studioAdmin` / `admin@123`（显示名“测试管理员”，账号邮箱 `songlin.liu@changhong.com`，协同 ID 1）；账号邮箱作为 Studio `email` 字段返回，与 GitLab API 的 `gitlabEmail` 独立。后端 scrypt 密码校验，首次成功登录对 `songlin.liu@changhong.com` 唯一精确匹配并持久绑定 GitLab 数字用户 ID；不创建 GitLab 账号，后续不自动重绑。opaque 会话默认 8 小时，保存 token 哈希，登出撤销。
- Host 仅配置 collaborationUrl，安全存储 collaboration-session 保存协同 token/expiresAt。`SEI_GITLAB_TOKEN` 仅由后端管理端注入；桌面不读取、不接收，API/Agent/日志不返回。项目目录及群组按绑定用户有效成员过滤，不以管理 token 或 admin 标记扩权。read ≥ Reporter20、edit ≥ Developer30；群组创建还满足实际 project_creation_level；创建者分配 Maintainer40。发布需 `STUDIO_PUBLISHER_USER_IDS` 独立配置协同 ID。
- `POST /v1/projects` 只接受 name/namespaceId/path/idempotencyKey，先 private 空库、分配现有人、登记 pending；Host 写三目录/模板/manifest、root 首提交并以本机 Git helper push main，再 `initialize {commitSha,idempotencyKey}`。后端验证真实 head、root 提交、manifest 和三目录 tree 后 ready；pending 时 recognizedHead=null，禁止业务占用/确认/基线/发布。旧自报 GitLab 仓库 ID 注册入口删除。
- Git URL 为后端 canonical HTTP(S) .git；专用 Git 凭据操作使用可信 system/global credential helper，拒绝本地 helper/hooks/URL 改写/filter/include 等配置，禁用 hooks，不注入后端 token/授权头/askpass，不转换 SSH fallback。本机项目按协同 user.id 隔离，与后台可见目录分别记录。
- 固定正文仍留 Git；后端先核验绑定成员读权，再管理 API 临时读取固定字节并核验哈希/元数据。正文不进数据库/日志/落盘缓存/错误响应，读取在短事务外，事务内重核验占用/revision；五阶段、无 TTL 持久占用与精确集成规则不变。当前 G0 验收以本地预览为止；单站点发布是独立 M2-2 功能。

认证表为 studio_users/studio_sessions；建仓持久过程表 studio_project_creations 保存 actor/key、请求哈希、稳定 UUID、namespace/path/name、marker 和阶段。同请求建仓窗口使用 session advisory lock，HTTP 不跨数据库事务；按 path/marker 和稳定操作查询恢复，不能接管未知远端或覆盖本地现场。

## 文档与旧认证归档

[ADR 0003](../../adr/0003-studio-auth-and-project-provisioning.md) 记录本次身份、绑定、权限与分段初始化决策；[ADR 0002](../../adr/0002-backend-transient-git-validation.md) 增补管理 token 读取前的绑定成员验权。01–08/G0-4/G0-6 和 [API README](../../../apps/collaboration-api/README.md) 同步当前职责；旧 handoff 明确认证入口被替代，保留原日期与执行事实。

根 [gitlab/legacy-oauth](../../../gitlab/legacy-oauth/README.md) 按基线 46fdb5d 原字节保留旧 Host auth、旧后端 auth 和六份旧文档/证据，含 SHA-256 清单；不归档当前 GitLab 管理 API，不进入 workspace/构建，不提供兼容或 fallback。

## 验证边界

离线验证结果（Linux）：后端 `tsc --noEmit` 通过；GitLab 成员授权和 root 首提交校验单测 16 项通过；使用专用临时 PostgreSQL 17 数据库和本地 GitLab HTTP fixture 的完整登录/创建/恢复/初始化生命周期 9 项通过，结束后已删除临时数据库、角色和连接文件。桌面端 Host/client TypeScript 构建通过；本机 Git 凭据隔离与协同登录测试 10 项通过，项目创建/推送/初始化断点恢复测试 7 项通过。仓库检查报告 207 个文件、47 个模板哈希一致；`git diff --check` 通过。以上 fixture 不代表真实企业 GitLab API 或原生 Windows 宿主验证。

修复前的真实实例只读探测（2026-10-15，curl 经用户提供的显式 HTTP 代理）：管理凭据访问 `/api/v4/user` 返回 200，`/api/v4/groups?all_available=true` 第一页返回 84 条；不带凭据的 `/api/v4/version` 返回 401。指定邮箱搜索返回 200 但无匹配；用户名 `songlin.liu` 返回 active 用户 ID 70，但 `/api/v4/users/70` 的 `email` 与 `public_email` 均不能核实该邮箱，因此当时不能将其认定为已验证绑定。该版本 `resolveUser` 只查询目录精确邮箱，真实登录绑定会被拒绝。此前默认代理/直连下 HTTPS 超时、HTTP 403；通过显式代理的 curl 后 API 读请求可达。该轮未执行远端写操作。

后续同日按用户提供的本机 pg17、显式代理和 6972 端口实际部署，确认 `/user` 精确返回 token 本人的邮箱与 ID 70，修复首次解析并完成真实登录。部署配置、客户端连接方式及逐项实际结果见 [本机部署交接](local-collaboration-deployment.md)。Windows 安全存储/本机 helper/本地预览与协同、双作者/双客户端仍按 G0 门槛验收。G0-1/2 桌面打包已完成；当前无需签名或升级验收。单站点发布独立列为 M2-2。默认单测试管理员不能代替多人实名或权限隔离证据，不宣称 G0 总体通过。
