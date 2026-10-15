# G0-5 / G0-6 编码交接

2026-10-15，Linux 自审（self_review）。本轮完成编码，不宣称 Windows 原生、真实 GitLab 或真实 PostgreSQL 验收通过。

2026-10-15 身份修订：以下为原“客户端 GitLab OAuth 直登”编码和当时检查记录；当前协同登录、既有 GitLab 账号绑定及后端建仓方案已替代其认证/注册入口。原字节副本与旧认证源码见 [legacy-oauth 归档](../../../gitlab/legacy-oauth/README.md)，当前运行配置与结果见 [本次交接](studio-auth-projects.md) 和 [API README](../../../apps/collaboration-api/README.md)。下述旧 GITLAB_* 用户角色名单、OAuth/PKCE 和客户端令牌要求仅作为历史记录，不再用于当前身份路径。

新增 `@eadp/contracts`、`@eadp/asset-domain` 与 `@eadp/collaboration-api`。API 的运行、固定材料格式、完整路由和恢复约束见 [协同 API README](../../../apps/collaboration-api/README.md)，字段以共享 TypeScript/JSON schema 为准。

已实现：GitLab OAuth access token 实时身份和项目读写权限；独立后端管理员/发布者权限；单项目单仓库；分类与稳定 ID 预留；无 TTL 的持久占用、代次/revision、取消及管理员释放；前置图和固定完成版本门禁；场景关联集合冻结、派生新需求与完整批次原子确认；统一 Git 集成受理/最终接受、认可头/基线、幂等核对、纠正及旧占用拒绝；固定材料确认与自动复用资格、明确停用/恢复、跨项目来源读取与采用及目标成功依据；独立清单/交接收悉；当前部署元数据与仅可读取当前已确认基线的短发布授权。

数据库只保存必要控制元数据。固定 Git raw 字节在短事务外读取、核验 SHA-256 和受控元数据，事务内复查占用及业务条件。正文、OAuth token、发布短 token 不进入数据库或日志。发布 token 仅有 5 分钟的特定读取用途，不改变占用永不自动过期的规则；普通 API 不接受它。独立发布者须在服务端白名单明确授权，不能从仓库 Developer 权限推导。

## 本轮执行

- contracts、asset-domain、collaboration-api TypeScript 检查通过。
- 一次无外部依赖边界核对通过：拒绝正文/未知字段且错误不回显；缺少可信登录拒绝；内存 raw MD 精确字节通过、旧 hash 拒绝。
- 新增发布授权后单独核对：项目作用域、签名篡改拒绝及独立发布者拒绝通过。
- 未执行数据库认证、SQL 建表、真实并发/故障注入、GitLab 登录/固定文件访问或 Windows 原生验证，未创建远程升级服务。按用户本次要求没有扩展为大套测试。

`pnpm --filter @eadp/collaboration-api check:transactions` 是留给目标 G0 测试库的可选小检查：合成项目内执行并发唯一占用、精确幂等重放、管理员释放与重占后旧代次拒绝，退出前清理该测试项目。它不替代真实双作者/双客户端和 Git/DB 响应丢失验收。

## 本机配置与后续验证

后端工作树已建立忽略的 `.env`，凭证只在该本机文件中；默认 `PG_SSL=require`，不因既往 SSLRequest 返回 N 自动降级认证。维护者在实际可信测试网确定连接策略后明确选择 PG_SSL 并执行建表。根工作树需按需复制这份本机文件；Git 提交仅包含 `.env.example`。计划曾出现的明文数据库密码应由主 Agent 清理，不能复制到交接记录、日志或源码。

运行入口为 `db:init` 与 `start`，均在 `@eadp/collaboration-api` 中；schema 是当前唯一建库定义，无迁移或兼容分支。初始化只在新建的 G0 数据库执行，不会自动重置已有表。

发布功能额外配置 `GITLAB_PUBLISHER_USER_IDS`、`PUBLIC_API_URL` 与不少于 32 字节的 `PUBLICATION_TOKEN_SECRET`。Host 先以正常用户 token 请求 `POST /v1/projects/:id/publication-authorizations`（`{baselineId}`），把返回的特定 `url` 和短 `token` 交给受控发布入口；远端仅 GET 该 URL 获得 `{baselineId,commitSha,acceptedHead,completionEvidence}`。资格依赖当前基线/认可头且存在待核对集成时拒绝。未配置发布凭证及服务器不影响其他编码能力，本轮不准备更新服务器。

Windows 验收重点：OAuth PKCE 与权限；两个客户端的持久占用及旧代次；真实固定 raw 文件的授权/哈希/元数据拒绝；前置与场景冻结竞态；精确候选自动合并及未知结果恢复；材料确认与资格停用的幂等顺序；固定完整包采用及目标确认；独立发布权限与当前基线门禁。GitLab 实际 compare、raw、merge_base API 能力按所选实例实测，不支持时阻断，不自动切换后备契约。
