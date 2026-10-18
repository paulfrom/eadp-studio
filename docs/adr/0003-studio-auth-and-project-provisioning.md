# 协同后端登录、既有 GitLab 账号绑定与分段初始化

2026-10-15 已确认。当前业务代码托管仍为 GitLab，工作台登录改为协同后端独立会话。此前客户端直连 GitLab OAuth/OIDC、PKCE/loopback 回调及候选 GitHub Device Flow 都不作为当前运行路径；原 GitLab OAuth 专用源码与旧证据仅保存在 [legacy-oauth 归档](../../gitlab/legacy-oauth/README.md)，不进入构建或运行时回退。

## 身份、凭据与权限

工作台通过 `POST /v1/auth/login` 的 `{username,password}` 登录协同后端；后端签发有期限的 opaque Bearer 会话，保存会话哈希，`POST /v1/auth/logout` 撤销当前会话，`GET /v1/me` 查询可信身份。会话寿命由后端 `STUDIO_SESSION_TTL_DAYS` 配置，默认 90 天；桌面端只把会话 token 缓存进系统安全存储，不写密码，也不在本机长期缓存任何长期刷新凭据。协同用户有独立 ID，不能将会话 token 当作 GitLab Git 凭据或把 GitLab 用户 ID 当作协同 ID。Host 通过安全设施保存协同会话，client、普通 Agent 和本机 Git 操作不取得后端管理 token。

当前只预置一个测试管理员：显示名 `测试管理员`、用户名 `studioAdmin`、密码 `admin@123`，协同用户 ID 为 `1`，绑定定位值为既有 GitLab 账号 `songlin.liu@changhong.com`。后端首次成功登录时查询并进行唯一精确匹配，确认存在且有效后持久绑定 GitLab 数字用户 ID；之后不因登录或邮件变化自动改绑，不新建 GitLab 账号。该默认账号是本次测试入口，只证明单账号行为；多人实名身份、账号分配与真实管理员分权仍需独立验收，不能借它宣称完成。

账号解析先读取已认证 `/user`，定位值与该账号的 username/email/public_email 精确相等时使用其已核验数字 ID；其他账号使用原有用户目录唯一精确查询。普通 token 查询用户目录不能证明私有邮箱不存在，而 `/user` 可提供 token 本人邮箱的正式证据；不推断邮箱与相似用户名的关系，不在请求失败时绕过身份校验。本机真实实例验证和部署结果见 [本机部署交接](../development/handoffs/local-collaboration-deployment.md)。

`SEI_GITLAB_TOKEN` 只由后端管理端配置，用于查询和受控 GitLab 管理 API（建仓、给已存在绑定用户分配成员、受门禁约束的固定字节读取等）。管理端可提供该凭据；是否在实际运行后端中配置并可用须运行验证，当前执行进程未继承它不等于凭据不存在。桌面不读取、不接收该 token；用户 clone/push 使用自己机器上的 Git 凭据，凭据与协同会话完全独立。

可见项目与可建仓群组均依据绑定 GitLab 用户的实际权限过滤。项目访问须核验有效成员权限，群组选择须核验有效直接/继承成员、成员状态/到期及群组 `project_creation_level`；`developer` 要求至少 Developer，`maintainer` 要求至少 Maintainer，未知策略/状态阻断。管理 token 可看见或可创建不代表协同用户可看见或可创建；登录管理员也不豁免仓库权限。发布权限仍由 `STUDIO_PUBLISHER_USER_IDS` 的协同用户 ID 独立配置，不由管理员或 GitLab 项目角色推导。

## 项目创建与恢复

用户填写项目 `name`、仓库 `path` 并选择 `GET /v1/namespaces` 返回的 GitLab 群组；当前不创建个人命名空间或 GitLab 用户。`POST /v1/projects` 只接受 `{name,namespaceId,path,idempotencyKey}`。后端重新核验目标群组权限，创建 private 空仓库，向现有绑定用户分配所需成员权限，记录业务 project ID、GitLab project ID、remote、namespace 与 `pending` 状态。空仓库创建不设置 README，不凭空设初始 SHA；稳定分支约定 `main`，由 Host 的首次 push 建立。

Host 收到 pending 项目后，在受管理本机目录执行 Git init，写项目清单及 `场景/`、`需求/`、`原型代码/`，复制指定模板，完成首个 root commit 并以用户本机 Git 凭据推送 `main`。随后调用 `POST /v1/projects/:id/initialize` 的 `{commitSha,idempotencyKey}`；后端核验真实远端分支头、root 首提交、项目清单身份与仓库引用、固定三目录 tree 后，才原子登记认可初始头并将项目置为 `ready`。

ProjectView 的 `initializationStatus` 为 `pending` 或 `ready`，`recognizedHead` 在 pending 时为 null；另含 `namespaceId`、`namespacePath`。ready 前不得认领业务占用、确认材料、生成完成基线或发布。旧 `RegisterProject` 客户端自报 GitLab 仓库 ID/初始头的路径删除，不保留兼容入口。

远端建仓、成员分配、本机初始化与 PostgreSQL 不构成一个事务。以 studio_project_creations 的稳定操作、随机 marker、阶段和项目记录分段恢复；同请求建仓窗口使用可随连接终止释放的 PostgreSQL session advisory lock，HTTP 调用不放入数据库事务。响应不明时按 path 与 marker 核对归属：响应丢失先查询，同一幂等键和相同输入恢复同一项目；不得借 path 冲突接管未知仓库，不因部分失败反复建仓，不清理或覆盖用户本地已有现场。初始化失败保留 pending，不伪报 ready；远端头变化、清单不符或条件不满足时明确阻断。

## 不变边界与验收

Git 保存固定正文，后端只持久保存身份、会话/控制元数据与固定引用。管理 token 取字节前先按绑定用户权限核验，正文只在内存校验，取用/解析位于短事务外，事务内重核验占用、revision 和门禁；不接受业务正文上传，不落盘/进日志，沿用 [ADR 0002](0002-backend-transient-git-validation.md)。持久占用无 TTL、精确候选与认可集成头、独立 Host 单站点发布等业务规则不变。

采用 GitLab 官方 [Users API](https://docs.gitlab.com/api/users/)、[Groups API](https://docs.gitlab.com/api/groups/)、[Members API](https://docs.gitlab.com/api/members/) 与 [Projects API](https://docs.gitlab.com/api/projects/) 的常规账号查询、成员权限和建仓模式。官方当前文档只支持选用成熟模式，不证明企业实例的版本或这些调用已可用；目标实例须实际验证精确账号解析、继承/到期成员、群组建仓策略、private 空仓库与成员分配、固定首提交读取及响应丢失恢复。

本决策及合成/隔离数据库检查不等于真实 GitLab 或 Windows 验收。默认单账号不证明双作者隔离，旧 OAuth 探测也不证明新的协同登录/管理 API 路径通过。实际结果分别记录在对应 G0 交接，不改写历史日期事实，不新增兼容、迁移或 fallback。
