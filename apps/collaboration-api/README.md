# 协同 API

Fastify + PostgreSQL 模块化单体。工作台只登录本协同后端，使用独立协同用户和会话；后端将用户持久绑定到已存在的 GitLab 数字用户 ID，并按该用户的实际成员权限授权。每个项目只登记一个 GitLab 仓库及一条稳定分支。正文只保存在 Git，业务 API 的 JSON schema 拒绝正文及未知字段。旧 GitLab OAuth 直登源码和旧证据仅作 [legacy-oauth 归档](../../gitlab/legacy-oauth/README.md)，GitLab 管理 API 仍是当前实现。

## 本机运行

先在仓库根安装锁定依赖，然后复制 `.env.example` 为 `.env` 并配置数据库。凭证只保存在忽略的本机文件。`PG_SSL` 必须明确选择 `require` 或 `disable`，不会自动降级；`require` 校验证书，企业 CA 通过标准 `NODE_EXTRA_CA_CERTS` 配置。此前指定端点的匿名 SSL 协商未被接受，不因此自动禁用 TLS；本机 PostgreSQL 17.10 的既有四项事务证据见 [G0-6](../../dsh_eadp_studio_plan/G0-6-协同后端与持久占用.md)，不能代替新身份/初始化流程验证。

```sh
pnpm --filter @eadp/collaboration-api db:init
pnpm --filter @eadp/collaboration-api start
```

`db:init` 对新的 `public` schema 一次性执行 `db/schema.sql`，默认数据库由连接串指定。不维护迁移链、不自动清库、不修改现有表。不应对已有其他用途数据库直接执行。运行默认监听 `127.0.0.1:3001`；企业部署时在受控 TLS 入口后配置 HOST。`GET /health` 检查数据库连接。

GitLab 当前实例按计划使用 `http://rddgit.changhong.com`，后端保留 `GITLAB_URL` 与显式的 `GITLAB_ALLOW_HTTP=true` 测试入口约束。管理端将 `SEI_GITLAB_TOKEN` 注入后端运行配置；它只供后端查询成员、建仓/分配现有账号及受权限门禁限制的内容读取，不发送桌面、API 响应、Agent、日志或业务数据库。未配置时相关 GitLab 能力返回 503，不表明管理端没有该凭据，不自动改走客户端 OAuth。真实 API 可用性须由实际后端运行配置验证。

Host 只配置 `collaborationUrl`，安全存储 `collaboration-session` 保存后端会话 token/expiresAt；桌面不配置 GitLab OAuth 应用、PKCE/回调或 GitHub Device Flow。用户本机 Git 凭据独立用于 canonical HTTP(S) remote 的 init/push/clone，经可信 system/global credential helper 取用；协同 token 和管理 token 都不注入 Git 授权头、remote 或 askpass。

本工作站的测试服务使用本机 pg17、`0.0.0.0:6972` 及显式 GitLab 代理，实际服务管理、客户端连接配置和验收范围见 [本机部署交接](../../docs/development/handoffs/local-collaboration-deployment.md)。需要代理时在后端 `.env` 设置 `HTTP_PROXY`、`HTTPS_PROXY` 和绕过本地服务的 `NO_PROXY`，并用支持原生环境代理的 Node 启动；当前验证版本为 Node 22.22.3：

```sh
# 在 apps/collaboration-api 中运行；此命令启用 fetch 的环境代理。
node --use-env-proxy --env-file=.env --import=tsx src/bootstrap.ts
```

普通 `pnpm start` 不会添加该 Node 代理选项；curl 的 `-x` 也不会改变服务进程的网络配置。

## 登录、账号绑定与权限

默认预置单个测试管理员：显示名 `测试管理员`、邮箱 `songlin.liu@changhong.com`、用户名 `studioAdmin`、密码 `admin@123`、协同 ID `1`。账号资料邮箱与 GitLab API 返回的可选 `gitlabEmail` 分开保存/返回；密码以 scrypt 哈希保存；首次成功登录时，后端对既有 GitLab 账号做唯一精确查询，将确认的数字用户 ID 持久绑定，之后不自动重绑，不创建 GitLab 账号。账号不存在、匹配歧义、状态无效或无法完成绑定时拒绝；默认账号只证明单账号入口，不代表多人实名或双作者分权验收。

首次解析先读取 GitLab `/user` 的已认证 token 身份，仅在定位值与其 username/email/public_email 精确相等且账号有效时接受；其他账号仍通过用户目录唯一精确匹配。这样能够验证 token 所属账号的私有邮箱，无需将邮箱公开；不根据邮箱前缀猜测用户名，不因接口失败信任客户端自报身份。采用 [GitLab 当前用户接口](https://docs.gitlab.com/api/users/#retrieve-the-current-user) 的正式身份信息。

`POST /v1/auth/login` 接收 `{username,password}`，返回 `LoginResponse`：`{user,gitlabOrigin,token,expiresAt}`。其中 `user` 为 `StudioUser`，含 `id`、`username`、`name`、账号资料 `email`、`admin`、`gitlabUserId`、`gitlabUsername` 和可选 `gitlabEmail`；协同 ID 与 GitLab 用户 ID 互不替代。opaque Bearer 会话默认 8 小时，数据库只保存会话哈希；`GET /v1/me` 返回 `{user,gitlabOrigin}`，`POST /v1/auth/logout` 无请求正文并撤销当前会话。

后端目录、单项目及固定内容读取均按绑定用户的有效 GitLab 成员权限校验，包含继承、active 状态和到期：读取至少 Reporter（20），编辑至少 Developer（30）。公开仓库可读或管理 token 能读取不等于工作台有权限。管理员 `admin:true` 只授予明确的占用释放/集成纠正能力，不豁免仓库成员权限；不配置 `GITLAB_ADMIN_USER_IDS` 或 `STUDIO_ADMIN_USER_IDS`。发布权限单独使用 `STUDIO_PUBLISHER_USER_IDS` 的协同用户 ID（测试管理员需显式配置 `1`），不因 admin 标记自动授予。

可建仓群组目录从完整分页列表取得策略，以最多 8 个并发请求核验绑定用户的有效成员权限，保持返回顺序。仅群组成员读取的 403/404 表示本次无法证明该组资格并排除；认证失败、限流、未知策略及其他上游错误仍阻断。实际创建重新读取目标成员和群组策略，不缓存或信任之前目录结果。

## 固定材料

UTF-8 无 BOM、LF，文件名为稳定实体 ID（例如 `需求/<id>.md`），前置元数据块唯一：

````md
```eadp-metadata
{
  "entityId": "r1",
  "kind": "requirement",
  "title": "固定材料样例",
  "categoryId": "procurement",
  "scenarioIds": [],
  "prerequisites": [],
  "sources": [],
  "businessEvidence": [{ "label": "业务访谈记录", "reference": "原始材料编号" }],
  "coreRulesPresent": true,
  "acceptanceCriteriaPresent": true,
  "openQuestions": [],
  "referencedAssets": []
}
```

## 核心业务规则

由作者依据真实材料确认的规则。

## 验收条件

由作者确认的可判断条件。
````

完整字段及 schema 见 `@eadp/contracts`。交接 MD 位于根目录 `handoff.<id>.md`；独立批次基线 JSON 位于 `baseline.<id>.json`，格式为 `FixedManifestSchema` 的 `{schemaVersion:1,metadata}`。项目索引位于 `project.assets.json`，不新建第四个业务目录。非阻断疑问必须保留 `limitation` 和 `excludedScope`；阻断疑问拒绝确认。`businessEvidence` 只保存必要来源引用，不上传原始业务材料。`applicability: {status:"not-applicable",reason:"..."}` 可在确认的需求版本中明确不适用，阻止该版本生产/新采用；旧确认及完成历史继续保留。字段存在只支持结构核验，真实业务结论由当前可信作者确认。

后端读取前先校验当前协同用户绑定的 GitLab 有效仓库成员权限，再用后端管理 API 从登记项目的 raw file endpoint 按完整 commit SHA 读取内存字节；限制单文件 2 MiB、15 秒超时，独立计算 SHA-256、解析并比较元数据，不使用会转换编码的 JSON file content 字段。失败、无权限、不一致、未知均阻断。Fastify 关闭日志，错误只返回固定诊断及必要 ID，不返回正文、GitLab 响应、凭证或 SQL 错误。

## API 与推进

登录后的 `/v1` 业务路由使用 `Authorization: Bearer <Studio session token>`，每次核验有效协同会话和绑定成员权限；登录入口及既有专用短发布读取入口分别按其契约处理。客户端不能提交自填 userId、GitLab OAuth token 或管理 token 代替协同身份。

| 方法与路径（`P=/v1/projects/:projectId`） | 返回 |
| --- | --- |
| POST `/v1/auth/login`、POST `/v1/auth/logout`、GET `/v1/me` | 登录 token/期限、注销结果、当前协同身份及 GitLab origin |
| GET `/v1/namespaces` | 当前绑定用户可建仓的群组 `NamespaceView`：`{id,name,fullPath}` |
| GET `/v1/projects`、POST `/v1/projects` | 本人可见项目；创建 private 空库并登记 pending 项目 |
| POST `P/initialize` | 核验首提交/远端头/清单/三目录后 ready 的 ProjectView |
| GET `P` | `ProjectState`：项目、实体、集成操作、基线 |
| POST `P/categories`、POST `P/entities` | 项目、预留的稳定实体（revision 0） |
| POST `P/entities/:id/claim` | 带当前 occupation 的实体 |
| POST `P/entities/:id/cancel`、`admin-release` | 已中止/释放实体 |
| PUT `P/entities/:id/relations` | 新 revision 的实体 |
| GET `P/entities/:id/versions` | 当前资格投影的全部固定材料版本 |
| POST `P/entities/:id/eligibility` | 指定固定版本及最新资格 |
| POST `P/integrations`、GET `P/integrations/:id` | `IntegrationView` |
| POST `P/integrations/:id/complete` | 完成的集成操作，含确认事件 ID/可选基线 ID |
| POST `P/integrations/reconcile` | 管理员核对纠正后的项目 |
| GET `P/operations/:key` | `{action,result}`；当前操作者未知结果为 404 |
| GET/POST `P/adoptions` | 采用记录列表/本次受理记录 |
| POST `P/adoptions/:id/success` | 绑定目标确认后的复用成功记录 |
| GET/POST `P/entities/:id/receipts` | 交接收悉列表/记录 |
| POST `P/publication-authorizations`、GET `P/publication-current` | 仅可读取当前基线的 5 分钟特定发布授权/门禁结果 |
| GET/POST `P/deployment` | 唯一当前远程站点控制记录；未部署为 null |

新建项目只接受 `{name,namespaceId,path,idempotencyKey}`；namespace 必须来自后端的可建仓群组。群组有效成员还需满足 `project_creation_level`：developer 至少 30、maintainer 至少 40，未知策略阻断；不以管理 token 的建仓能力或可见群组代替用户权限。后端创建 private 空库（不初始化 README、不传仅适用于 README 初始化的 default_branch），给现有绑定创建者分配 Maintainer（40），记录 pending 后返回；稳定分支固定 main，由 Host 首次 push 建立。

`ProjectView` 含 `namespaceId`、`namespacePath`、`initializationStatus: pending|ready` 和 `recognizedHead: string|null`。pending 时认可头为 null，拒绝占用、材料确认、完成基线及发布。Host 本机 Git init，写固定三目录、模板和 `project.assets.json`，完成 root 首提交、push main，再向 initialize 发送 `{commitSha,idempotencyKey}`。后端核验真实远端头、root 首提交、三目录 tree 和 manifest 的 `schemaVersion:1`、`projectId`、`gitlabProjectId`、`repositoryUrl`、`stableBranch`、`directories: ["场景","需求","原型代码"]` 后，才原子置 ready 并登记认可初始头。客户端自报 `gitlabProjectId` 的旧 RegisterProject 入口不再支持。

建仓、分配成员、推送与 PostgreSQL 不构成一个事务；通过 `studio_project_creations` 保存 actor/key、请求哈希、稳定项目 UUID、namespace/path/name、随机 marker 和 reserved/creating/created/assigned 状态，按 pending 项目分段恢复，响应丢失先查询。相同请求的建仓窗口使用 PostgreSQL session advisory lock 串行，进程/连接结束自动释放，不开启跨 HTTP 调用的数据库事务；远端响应丢失时按 path 与 marker 核对归属，不接管未知仓库。同一幂等键及相同输入恢复同一结果，输入变化拒绝；不因 path 冲突接管未知仓库，不重复建仓，不覆盖或删除本地已有现场。initialize 未核验完成保留 pending，不伪报 ready。

持久业务写请求均含 `idempotencyKey`（短发布授权是一次性签发用途，不落库），同项目内同键只能对应同操作者、同动作和相同请求。重连先查询，404 表示后端尚无该操作者的受理结果，不能推断 Git 未发生。错误结构统一为 `{error:{code,message,details?}}`，冲突通常为 409。

材料与原型均走同一集成入口：Host 从 `recognizedHead` 构造候选并推送临时任务引用，上传固定材料引用/metadata 和精确候选检查证据；API 核验固定字节、唯一占用、代次/revision、输入/前置、冻结、源与候选差异及实际稳定分支；受理后 Host 以旧 SHA 条件更新稳定分支，再 complete。候选第一父提交须为 expectedHead，源与候选相对该头的差异须一致；认可头变更后须重建和重检，不能合入其他任务的未认可变化。普通材料检查名为 `materials`、`relations`；原型另须 `engineering`、`mock`、`browser`、`relations`。API 记录 Host 的检查哈希和可信作者确认方式，不代替桌面工程检查。

一次只受理一个项目集成窗口，其他需求的本地任务和占用继续。Git 与数据库没有分布式事务：实际分支与认可头不一致时阻断下一集成和发布；占用释放作废旧操作、原子解冻，但不撤销在途 Git。已推送候选且原占用有效时续办同一操作；占用撤销后保留 Git 证据，由管理员在 Git 做可追溯反向纠正，核验纠正树等于原认可树后登记新头。不执行强推或自动丢弃现场。

场景批次用 `purpose=scenario-batch` 领取场景占用，同事务冻结全部相关需求；任何相关占用/其他冻结导致整体拒绝。在批次内预留新需求时传 `batch:{scenarioId,token}`，会递增场景 `associationRevision`。提交须带最新 `expectedAssociationRevision`、完整 `batchRequirementIds`；已完成的当前版本只保留，变化范围派生新 ID，未开始的相关需求全部同事务确认。失败不接受部分更新。

前置按明确材料版本绑定已接受完成事件/认可 SHA。编辑新版本不篡改旧完成历史，也不会让新范围提前完成；明确指定旧完成版本仍可使用旧依据。完成产生单需求原型基线并自动释放；清单/批次基线是独立 `handoff`/`baseline` 实体，只聚合已接受的完成版本，不重新批准原型。收悉只记录接收人及固定清单确认依据。

## 验证边界

此前直接 OAuth 版本的 TypeScript、无外部依赖请求/内容与短发布 token 检查，以及本机 PostgreSQL 17.10 的四项事务检查，只按原记录范围计入；旧事实未改写为新方案已通过。当前协同登录、真实账号绑定和群组目录的本机部署验证见 [本机部署交接](../../docs/development/handoffs/local-collaboration-deployment.md)，隔离数据库的完整登录/建仓/初始化检查见 [身份与建仓交接](../../docs/development/handoffs/studio-auth-projects.md)。真实企业实例建仓/分配、用户本机首次 push、真实 pending/ready 初始化、双作者/双客户端与 Windows 宿主验收仍须目标环境执行，默认单测试账号不能代替；不据代码或合成检查宣布 G0 通过。

可选的 `pnpm --filter @eadp/collaboration-api check:transactions` 在已初始化的 G0 数据库中只创建一个合成项目，检查并发唯一占用、幂等重放、管理员释放与旧代次拒绝，最后删除其测试数据；不自动执行大套测试。

账号查询、群组建仓和成员分配采用 [GitLab Users API](https://docs.gitlab.com/api/users/)、[Groups API](https://docs.gitlab.com/api/groups/) 与 [Members API](https://docs.gitlab.com/api/members/)；当前官方文档不证明所选企业实例版本和实际能力已验收。固定内容与业务实现采用 [GitLab raw file API](https://docs.gitlab.com/api/repository_files/)、[项目权限 API](https://docs.gitlab.com/api/projects/)、[Fastify JSON schema 校验](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) 与 [PostgreSQL 显式锁](https://www.postgresql.org/docs/current/explicit-locking.html)。每个动作在短事务内按稳定项目 ID 排序加行锁，数据库部分唯一索引再保证同实体唯一有效占用；没有 TTL、续期或断线释放。

## 桌面强制更新检查

`GET /api/v0/check_client_update?scenario=<launch|periodic|manual|...>` 服务 DSH 桌面强制更新策略客户端。无需会话；客户端版本取自 `x-client-version` header。未配置 `DESKTOP_UPDATE_MIN_VERSION` 时永远返回放行 `{"code":0,"data":{"biz_code":0,"biz_data":null}}`；配置后低于该 semver 门槛、或版本头缺失/不可解析的客户端返回强制 `{"code":40005,"data":{"show_content":{...}}}`（fail-closed）。可选文案与 `DESKTOP_UPDATE_APP_LINK`（必须 HTTPS，且其 origin 需在该桌面构建的 `allowedPageOrigins` 内，否则客户端丢弃链接）。环境变量见 `.env.example`。

## Docker 运行与一键启动

多阶段 `Dockerfile` 以仓库根为上下文构建（含 workspace 依赖、非 root 运行、入口幂等建 schema）；`compose.yml`（postgres:17 + api，默认端口 `6972:3001`）仅用于本机一键拉起，企业形态仍是独立 PostgreSQL + 本镜像。

```sh
./start-backend.sh            # 需要 docker 与 compose 插件；读取 apps/collaboration-api/.env
EADP_API_PORT=6973 ./start-backend.sh   # 端口被占时覆盖
```

手动构建运行：`docker build -f apps/collaboration-api/Dockerfile -t eadp-collaboration-api:local .`，运行时显式传 `-e DATABASE_URL=... -e PG_SSL=disable -e GITLAB_URL=...` 等配置；镜像默认 `HOST=0.0.0.0`、容器内默认监听 3001，可用 `-e HOST=...` 覆盖。
