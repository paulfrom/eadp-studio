# 协同 API

本批已将阶段一场景的关系模型接入后端源码，运行时建表入口为 [db/schema.sql](db/schema.sql)，设计依据见[协同后台数据库设计](../../docs/design/scenarios/01-scenarios-database.md)与[设计建表 SQL](../../docs/design/scenarios/schema.sql)。按新库部署，删除旧 JSON 业务快照与独立项目创建表，不保留旧结构兼容层或迁移。本次仅在独立临时数据库验证，未修改现运行库。

本批修正范围为协同后端及共享契约；桌面端暂未适配本批破坏性契约。后端隔离验证不表示桌面、真实协同或阶段一全产品验收通过。

Fastify + PostgreSQL 模块化单体。工作台只登录本协同后端，使用独立协同用户和会话；后端将用户持久绑定到已存在的 GitLab 数字用户 ID，并按该用户的实际成员权限授权。每个项目只登记一个 GitLab 仓库及一条稳定分支。正文只保存在 Git，业务 API 的 JSON schema 拒绝正文及未知字段。旧 GitLab OAuth 直登源码和旧证据仅作 [legacy-oauth 归档](../../gitlab/legacy-oauth/README.md)，GitLab 管理 API 仍是当前实现。

## 本机运行

先在仓库根安装锁定依赖，然后复制 `.env.example` 为 `.env` 并配置数据库。数据库与缓存都用本机已共用的 PostgreSQL、Redis 实例，编排不再自建这两个服务。凭证只保存在忽略的本机文件。`PG_SSL` 必须明确选择 `require` 或 `disable`，不会自动降级；`require` 校验证书，企业 CA 通过标准 `NODE_EXTRA_CA_CERTS` 配置。此前指定端点的匿名 SSL 协商未被接受，不因此自动禁用 TLS；既有事务检查只按当时范围计入，不能代替新身份/初始化流程验证。

```sh
pnpm --filter @eadp/collaboration-api db:init
pnpm --filter @eadp/collaboration-api start
```

`db:init` 对新的 `public` schema 一次性执行 `db/schema.sql`，默认数据库由连接串指定。容器入口的 Schema 检查会以 `SCHEMA_MODEL_MISMATCH` 拒绝旧模型；不维护兼容结构或迁移链，不自动清库、不修改现有表。部署本批后端须使用新的独立数据库，不应对现运行库或已有其他用途数据库直接执行。运行默认监听 `127.0.0.1:3001`；企业部署时在受控 TLS 入口后配置 HOST。`GET /health` 检查数据库连接。

GitLab 当前实例按计划使用 `http://rddgit.changhong.com`，后端保留 `GITLAB_URL` 与显式的 `GITLAB_ALLOW_HTTP=true` 测试入口约束。管理端将 `SEI_GITLAB_TOKEN` 注入后端运行配置；它只供后端查询成员、建仓/分配现有账号及受权限门禁限制的内容读取，不发送桌面、API 响应、Agent、日志或业务数据库。未配置时相关 GitLab 能力返回 503，不表明管理端没有该凭据，不自动改走客户端 OAuth。真实 API 可用性须由实际后端运行配置验证。

Host 只配置 `collaborationUrl`，安全存储 `collaboration-session` 保存后端会话 token/expiresAt；桌面不配置 GitLab OAuth 应用、PKCE/回调或 GitHub Device Flow。用户本机 Git 凭据独立用于 canonical HTTP(S) remote 的 init/push/clone，经可信 system/global credential helper 取用；协同 token 和管理 token 都不注入 Git 授权头、remote 或 askpass。

本工作站的测试服务使用本机 pg17、`0.0.0.0:6972` 及显式 GitLab 代理，服务配置以本文件和环境变量为准。需要代理时在后端 `.env` 设置 `HTTP_PROXY`、`HTTPS_PROXY` 和绕过本地服务的 `NO_PROXY`，并用支持原生环境代理的 Node 启动；当前验证版本为 Node 22.22.3：

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

UTF-8 无 BOM、LF，文件名为业务名称（例如 `需求/订单审核.md`），同项目重名依次追加 `-2`、`-3`，改名时文件随之改名；稳定身份只在唯一的 `eadp-metadata` 块中。下例假定项目 `p1` 已接受场景 `s1` 的第 1 版，且同一确认提交中包含列出的依据文件：

````md
```eadp-metadata
{
  "entityId": "r1",
  "kind": "requirement",
  "title": "订单审核",
  "summary": "提交后审核，退回后可修改并重新提交。",
  "templateId": "requirement",
  "templateRef": { "commitSha": "<40 位小写提交 SHA>", "path": ".template/requirement.md", "sha256": "<模板文件 SHA-256>" },
  "scenarioIds": ["s1"],
  "prerequisites": [],
  "sources": [{ "projectId": "p1", "entityId": "s1", "version": 1 }],
  "businessEvidence": [{
    "label": "业务访谈记录",
    "reference": "用户选定的订单审核访谈",
    "files": [{
      "path": ".eadp/evidence/9f0787051a57072353e7ec3d04f921992b285ed854ad898792683f2ec45096e5.txt",
      "sha256": "9f0787051a57072353e7ec3d04f921992b285ed854ad898792683f2ec45096e5"
    }],
    "ranges": [{
      "path": ".eadp/evidence/9f0787051a57072353e7ec3d04f921992b285ed854ad898792683f2ec45096e5.txt",
      "startLine": 1,
      "endLine": 1
    }]
  }],
  "files": [],
  "coreRulesPresent": true,
  "acceptanceCriteriaPresent": true,
  "openQuestions": [],
  "referencedAssets": []
}
```

## 审核约定

提交后由审核员审核；退回后申请人可以修改并重新提交。

## 如何验收

提交后审核员能处理该订单，退回后申请人能再次提交。
````

示例依据文件使用 UTF-8、LF，内容为以下一行并以换行符结束，上述 SHA-256 对应该文件的实际字节：

```text
业务访谈确认：订单提交后由审核员审核，退回后允许修改并重新提交。
```

完整字段及 Schema 见 `@eadp/contracts`。每个需求至少绑定一个同项目已确认场景及其固定版本，`scenarioIds` 与场景 `sources` 一一对应，可有多个来源。场景与需求均不含分类字段，都必须含 `templateId` 和 `templateRef: {commitSha,path,sha256}`（分别指向场景/需求模板目录中的已接受固定版本）；业务编号由后台分配，不写成可由材料修改的编号字段。场景必须适用；只有需求可声明 `applicability: {status:"not-applicable",reason:"..."}`，该确认版本会阻断后续生产与新采用，旧历史保留。

`businessEvidence` 是用户选定的正式依据：原始文件及实际引用的抽取文本归档于用户工程 `.eadp/evidence/`，每项记录来源、文件路径、SHA-256 及实际引用的文本行范围。二进制原件可与 UTF-8 抽取文本分别列入 `files`，`ranges` 指向已归档的可读文本。材料顶层 `files` 是显式关联文件的路径/hash 清单。两类文件本体都必须能从材料确认的同一提交读取，允许该树中未修改的文件；缺失、越界、hash 不符或引用范围不成立均阻断。未选资料、会话、提示词及工具过程只留本地。

后端保存确认固定引用、标题/摘要、适用性、来源关系和确认事实，不保存整包 `metadata`、正式依据清单或确认文件快照。当前关联文件路径表只用于目录投影。确认请求不上传 `metadata`，后端从固定 Git 材料读取并校验；`FixedVersion.metadata` 仅在读取响应时从 Git 补齐，不落业务表、集成请求、幂等结果或审计。历史材料及清单始终按对应确认 `commitSha` 读取，不能用当前目录投影重建。

确认门禁依据显式业务声明：必须有正式依据、核心规则、验收条件且无 blocking 问题；非阻断疑问保留 `limitation` 和 `excludedScope`。不再通过固定章节名称或字数推断质量，示例标题也不是强制模板。作者对实际业务结论负责，AI 评审为可选步骤。交接 MD 位于 `交接/<名称>.md`；独立清单基线 JSON 位于 `baseline.<id>.json`，格式为 `FixedManifestSchema` 的 `{schemaVersion:1,metadata}`，均保留既有后续阶段语义。

后台先校验绑定用户的有效 GitLab 仓库成员权限，再从登记项目的 raw file endpoint 按完整 commit SHA 读取字节；单文件上限 2 MiB，GitLab 请求超时 15 秒，独立计算 SHA-256 并解析固定内容。失败、无权限、不一致、未知均阻断。Fastify 关闭日志，错误只返回固定诊断及必要 ID，不返回正文、GitLab 响应、凭证或 SQL 错误。

## API 与推进

登录后的 `/v1` 业务路由使用 `Authorization: Bearer <Studio session token>`，每次核验有效协同会话和绑定成员权限；登录入口及既有专用短发布读取入口分别按其契约处理。客户端不能提交自填 userId、GitLab OAuth token 或管理 token 代替协同身份。

| 方法与路径（`P=/v1/projects/:projectId`） | 返回 |
| --- | --- |
| POST `/v1/auth/login`、POST `/v1/auth/logout`、GET `/v1/me` | 登录 token/期限、注销结果、当前协同身份及 GitLab origin |
| GET `/v1/namespaces` | 当前绑定用户可建仓的群组 `NamespaceView`：`{id,name,fullPath}` |
| GET `/v1/projects`、POST `/v1/projects` | 本人可见项目；创建 private 空库并登记 pending 项目 |
| POST `P/initialize` | 核验首提交、远端头、清单、四个业务目录及默认场景模板后 ready 的 ProjectView |
| GET `P` | `ProjectState`：项目、实体、集成操作、基线 |
| POST `P/entities` | 预留的稳定实体（revision 0）；场景仅名称即可创建并取得 `SC-0001` 形编号；需求须传 `templateId`/`templateRef` 与至少一个同项目已接受场景来源，取得 `REQ-0001` 形编号 |
| PUT `P/entities/:id` | 持有效设计占用更新名称/摘要，返回新 revision；不接受编号字段 |
| GET `P/entities/:id/revision-impact` | 已确认场景的修订影响清单及当前 revision，不领取占用 |
| GET `P/templates` | 按已接受 Git 头读取默认模板及模板固定引用，不保存后台模板清单 |
| PUT `P/entities/:id/template` | 持有效占用显式切换场景模板绑定，返回新 revision |
| POST `P/entities/:id/repairs` | 本次用户授权对应的 RepairTaskView |
| GET `P/repairs/:repairId` | 当前授权者的修复控制状态、hash 及累计轮数 |
| POST `P/repairs/:repairId/events` | 记录 round/pause/resume/terminate 控制事件并返回任务状态 |
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
| POST `P/consistency-comparisons`、GET `P/consistency-comparisons`、GET `P/consistency-comparisons/:id` | 提交/查询一致性对比记录（列表可按 `entityId` 过滤并分页） |
| GET `P/entities/:id/consistency-context` | 纯 SQL 的正式关系目录投影（场景来源、关联需求、前置及确认引用），不读取 Git |
| POST `P/publication-authorizations`、GET `P/publication-current` | 仅可读取当前基线的 5 分钟特定发布授权/门禁结果 |
| GET/POST `P/deployment` | 唯一当前远程站点控制记录；未部署为 null |

新建项目只接受 `{name,namespaceId,path,idempotencyKey}`；namespace 必须来自后端的可建仓群组。群组有效成员还需满足 `project_creation_level`：developer 至少 30、maintainer 至少 40，未知策略阻断；不以管理 token 的建仓能力或可见群组代替用户权限。后端创建 private 空库（不初始化 README、不传仅适用于 README 初始化的 default_branch），给现有绑定创建者分配 Maintainer（40），记录 pending 后返回；稳定分支固定 main，由 Host 首次 push 建立。

`ProjectView` 含 `namespaceId`、`namespacePath`、`initializationStatus: pending|ready` 和 `recognizedHead: string|null`。pending 时认可头为 null，拒绝占用、材料确认、完成基线及发布。Host 本机 Git init，写固定四目录、模板和 `project.assets.json`，完成 root 首提交、push main，再向 initialize 发送 `{commitSha,idempotencyKey}`。后端核验真实远端头、root 首提交、四目录 tree 和 manifest 的 `schemaVersion:1`、`projectId`、`gitlabProjectId`、`repositoryUrl`、`stableBranch`、`directories: ["场景","需求","交接","原型代码"]`、`scenarioTemplates` 与 `requirementTemplates` 双模板目录后，才原子置 ready 并登记认可初始头。初始化还要求 `.template/` tree、清单中可读且非空的默认模板与全部模板文件，以及 `场景/通用场景.md` 的字节精确系统预置文档。客户端自报 `gitlabProjectId` 的旧 RegisterProject 入口不再支持。

建仓、分配成员、推送与 PostgreSQL 不构成一个事务；统一使用 `studio_projects` 保存创建人/key、原请求哈希、稳定项目 UUID、namespace/path/name、随机 marker 及 reserved → creating → created → assigned → ready 生命周期，不再复制到独立项目创建表。失败保留已确定阶段，响应丢失先核对。相同请求的建仓窗口使用 PostgreSQL session advisory lock 串行，进程/连接结束自动释放，不开启跨 HTTP 调用的数据库事务；远端响应丢失时按 path 与 marker 核对归属，不接管未知仓库。同一幂等键及相同输入恢复同一结果，输入变化拒绝；不因 path 冲突接管未知仓库，不重复建仓，不覆盖或删除本地已有现场。initialize 未核验完成保留 pending，不伪报 ready。

持久业务写请求均含 `idempotencyKey`（短发布授权是一次性签发用途，不落库），同项目内同键只能对应同操作者、同动作和相同请求。重连先查询，404 表示后端尚无该操作者的受理结果，不能推断 Git 未发生。错误结构统一为 `{error:{code,message,details?}}`，冲突通常为 409。

场景新建请求为 `{idempotencyKey,kind:"scenario",title}`，可显式选择已接受的 `templateId`；不传模板时绑定当前共享默认模板。场景不接受分类、编号或来源字段。后台独立提交编号预留，以项目计数器行锁按类型原子分配 `sequence` 与 `SC-0001`/`REQ-0001` 格式的 `code`，超过 9999 自然增长；同一新建键重试复用实体 UUID 与编号，改名/修订不变，失败可留空号但不回收。需求不使用分类，创建时必须传 `templateId`、`templateRef`（指向需求模板目录默认项或显式选择的已接受版本）和 `sources`，每项含同项目场景 ID 与已接受版本（内置通用场景的系统预置版本同样可绑定）。更新需求关联时同时传 `scenarioIds`、`sources`、`prerequisites` 及占用 token，保持来源一一对应；前置必须绑定已接受的需求材料版本（`PREREQUISITE_UNCONFIRMED`），并校验自引用、重复与环（`INVALID_PREREQUISITE`/`DUPLICATE_PREREQUISITE`/`DEPENDENCY_CYCLE`）。

目录更新请求为 `{idempotencyKey,token,title,summary?}`，只接受当前材料设计占用。已确认场景只读打开不领取占用；可先 GET `revision-impact` 查看影响，然后直接以 `purpose:"design"` 占用独立修订并确认，没有批次或冻结概念，修订不自动改写关联需求或其来源绑定。

材料与原型复用集成底座，材料分支的 `stage` 为 `material` 或 `prototype`，携带 `entityId`、`token`、`sourceSha`、`expectedHead`、`candidateSha`、`allowedPaths`、`checks` 和 `confirmations`。每次集成只确认其占用的单个实体（`confirmations` 长度必须为 1 且指向根实体，否则 `SINGLE_ENTITY_REQUIRED`）。每项 confirmation 包含 `{entityId,expectedRevision,fixed,readHash,authorConfirmed:true,confirmationMethod}`，其中 `fixed={commitSha,path,sha256}`，`readHash` 必须等于最终固定材料的 SHA-256；不传 `metadata` 或业务清单。`direct` 对应用户阅读版本；`ai-assisted` 另传绑定候选与输入的 `reviewEvidence`；`ai-repair` 另传 `repairTaskId`，对应任务最终已记录 hash。

Host 从 `recognizedHead` 构造候选并推送临时任务引用，API 读取固定内容并校验当前占用、代次/revision、输入/前置、来源、完整 diff 及稳定分支。受理后 Host 以旧 SHA 条件更新稳定分支，再 complete。候选第一父提交须为 `expectedHead`，源与候选相对该头的差异须一致；认可头变化后重新预览、构造和检查。材料 diff 仅允许本批确认材料及其显式关联文件，不得借附件清单修改其他场景/需求、项目清单或模板；项目根目录只允许 `CONTEXT.md`，其余根目录文件不进入写入范围。材料改名时仅允许删除该确认材料自己的旧路径。原型只允许 `原型代码/` 范围并保持已确认需求输入字节不变。普通材料检查名为 `materials`、`relations`；原型检查名为 `engineering`、`mock`、`browser`、`relations`。complete 重新校验固定内容、权限、占用与来源，后台接受后才算确认。

场景模板保存在 `.template/<模板ID>.md`。项目 `project.assets.json` 的共享模板声明为：

```json
{
  "scenarioTemplates": {
    "defaultTemplateId": "default",
    "templates": [{ "id": "default", "name": "默认场景模板", "path": ".template/default.md" }]
  }
}
```

该片段属于完整项目清单，清单本身不写包含自身的 commit hash。模板发布使用 `stage:"template"` 的独立请求分支：`{idempotencyKey,stage,expectedProjectRevision,sourceSha,expectedHead,candidateSha,allowedPaths,checks}`；检查名为 `templates`，只允许 `.template/`、`project.assets.json` 的模板声明以及项目根 `CONTEXT.md` 的变更，不传场景 `entityId`、占用 token 或 confirmations，不确认材料、不产生原型基线。只发布 `CONTEXT.md` 时不需要重复声明模板目录；发布模板仍须声明目录。已有模板身份不能删除，项目身份与四目录声明不能改写。模板 complete 只传 `{idempotencyKey}`。接受之前新默认不共享，结果未知先查询原操作/集成；已确认场景的历史绑定仍可读取。

清单的 `scenarioTemplates` 只对新初始化必填。早于模板目录存在的已接受项目没有该片段：读取其清单不失败，`GET /projects/:id/templates` 返回空目录（`templates: []`、无默认项），此时新建场景以 `PROJECT_TEMPLATES_REQUIRED` 阻断；用户发布模板即按上面的模板分支补齐清单与 `.template/`。详见 [ADR-0006](../../docs/adr/0006-legacy-project-readonly-compatibility.md)。

显式切换模板请求为 `{idempotencyKey,token,templateId,templateRef}`，引用必须在项目已接受 Git 历史中，且路径/hash 与该提交清单的模板身份一致。切换只更新绑定与 revision，不改写正文；进行中的修复授权或待接受确认须先处理。

授权修复开始请求为 `{idempotencyKey,token,userActionId,startHash}`，只接受当前材料 design 占用。事件均携带 `idempotencyKey`、`token`、`expectedHash`：`round` 另含 `hashAfter`、`improved`；`pause` 的原因固定为 `business-answer-required`；`resume` 必须含新的显式 `userActionId`；`terminate` 原因为 cancelled/concurrent-edit/missing-evidence/no-improvement/round-limit。累计最多 3 轮，暂停/续接不清零；无改善、并发修改、资料不可读、额度耗尽或用户取消时终止，结束占用撤销未完成授权。普通聊天不能续接任务，终止任务不能恢复。后台只记录授权和控制事件，不接收业务补答全文、会话、提示词或工具日志，也不新增 AI 端点。

一次只受理一个项目集成窗口，其他需求的本地任务和占用继续。Git 与数据库没有分布式事务：实际分支与认可头不一致时阻断下一集成和发布；占用释放作废旧操作，但不撤销在途 Git。已推送候选且原占用有效时续办同一操作；占用撤销后保留 Git 证据，由管理员在 Git 做可追溯反向纠正，核验纠正树等于原认可树后登记新头。不执行强推或自动丢弃现场。

前置按明确材料版本绑定已接受完成事件/认可 SHA。编辑新版本不篡改旧完成历史，也不会让新范围提前完成；明确指定旧完成版本仍可使用旧依据。完成产生单需求原型基线并自动释放；清单基线是独立 `handoff`/`baseline` 实体，只聚合已接受的完成版本，不重新批准原型。收悉只记录接收人及固定清单确认依据。

## 通用场景预置

每个项目固定内置「通用场景」：建仓预留实体时即以专用操作键预留 `SC-0001` 编号，初始化事务核验 `场景/通用场景.md` 与系统约定的字节内容精确一致后，在同一事务写入实体与 `acceptance_kind='system-provisioned'` 的第 1 版接受记录；系统预置不填写业务确认人，真实初始化发起人保存在初始化接受记录中。`system-provisioned` 与 `user-confirmed` 互斥，只能由初始化事务写入；普通材料确认路径无法产生该途径。通用场景拒绝占用与编辑（`BUILTIN_SCENARIO_IMMUTABLE`），其固定读取走严格字节比对契约，不在普通解析失败后回退。需求可像普通已确认场景一样绑定其第 1 版作为来源。

## 一致性对比

一致性对比是独立、非阻断的记录能力，不执行任何 Git 操作、不加载固定材料正文。`POST P/consistency-comparisons` 提交当次结论与冲突摘要（`trigger: manual|confirmation`，confirmation 触发须绑定目标实体的一次材料确认且仅可记录一次）；记录落库即封存，对比与冲突不可变、无处理状态，也不存在修改/删除路由。列表与详情读取按 `entityId` 过滤并分页；`GET P/entities/:id/consistency-context` 以纯 SQL 投影正式关系目录（固定场景来源、关联需求、前置及其确认引用与占用提示），供客户端先行比对正式关系。

提交走白名单契约：未知字段与任何越限（ID/操作键 ≤100 字符、摘要 ≤500 字符、每次冲突 ≤100 条、每条冲突涉及材料 1–100 个、序号 1–100 连续）整体拒绝（400/422），不截断。幂等按表自带 `operation_key`：同键同请求重放返回原记录，同键不同请求拒绝（`IDEMPOTENCY_CONFLICT`）；对比相关路径不产生 Git 读取。写要求仓库编辑成员权限，读要求读取成员权限。

## 验证边界

本批验证分为共享契约/后端类型检查、后端单元测试、隔离 PostgreSQL 的数据库与 API 集成检查。隔离 GitLab HTTP fixture 验证请求、固定字节与故障路径，不能证明真实企业 GitLab 实例已验收。当前运行库未被本批更新；桌面仍待适配新建场景、模板、确认、修复和需求来源等破坏性契约。真实建仓/成员分配、用户工程 Git 推送、双作者/双客户端、实际模型资料读取及 Windows 原生宿主仍须单独验收。

后端源码检查命令在仓库根执行：

```sh
pnpm --filter @eadp/contracts typecheck
pnpm --filter @eadp/asset-domain typecheck
pnpm --filter @eadp/collaboration-api typecheck
pnpm --filter @eadp/collaboration-api exec tsx --test src/*.test.ts src/auth/*.test.ts src/modules/*.test.ts src/persistence/*.test.ts
```

`tests/collaboration/backend-lifecycle.test.ts`、`backend-scenarios.test.ts`、`backend-consistency.test.ts`、`backend-comparisons.test.ts` 使用 `STUDIO_TEST_DATABASE_URL`，各自须指向一个命名为 `eadp_auth_check_<字母数字>` 的空白、可丢弃临时数据库；各套件会执行整份新 Schema，不能共用一个非空测试库，也不能在同一库上合并为一次运行。未配置变量时数据库用例跳过，跳过不算通过。`tests/collaboration/scenario-schema.test.mjs` 另用 `SCENARIO_SCHEMA_TEST_DATABASE_URL`，命名和空库门禁以测试源码为准。临时库建在本机共用的 PostgreSQL 实例里，不再另起数据库容器；每次运行前重建空库，运行后删除整个临时库：

```sh
# 在共用实例中重建空的临时库；实例名与账号按本机实际情况替换。
docker exec pg17 psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS eadp_auth_check_backend"
docker exec pg17 psql -U postgres -d postgres -c "CREATE DATABASE eadp_auth_check_backend OWNER scenario_test"
STUDIO_TEST_DATABASE_URL=postgresql://scenario_test:scenario_test@127.0.0.1:5433/eadp_auth_check_backend \
  pnpm --filter @eadp/collaboration-api exec tsx --test ../../tests/collaboration/backend-lifecycle.test.ts
```

`pnpm --filter @eadp/collaboration-api check:transactions` 仅在显式配置 `SCENARIO_TRANSACTION_TEST_DATABASE_URL`、库名符合 `eadp_scenario_transaction_check_<字母数字或下划线>` 且 public 为空时运行。它初始化独立 Schema，检查编号预留/并发/失败重试、幂等、占用与释放；保留不可变记录供检查，由调用方删除整个临时数据库，不在已初始化业务库创建或清理测试数据。

账号查询、群组建仓和成员分配采用 [GitLab Users API](https://docs.gitlab.com/api/users/)、[Groups API](https://docs.gitlab.com/api/groups/) 与 [Members API](https://docs.gitlab.com/api/members/)；当前官方文档不证明所选企业实例版本和实际能力已验收。固定内容与业务实现采用 [GitLab raw file API](https://docs.gitlab.com/api/repository_files/)、[项目权限 API](https://docs.gitlab.com/api/projects/)、[Fastify JSON schema 校验](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) 与 [PostgreSQL 显式锁](https://www.postgresql.org/docs/current/explicit-locking.html)。每个动作在短事务内按稳定项目 ID 排序加行锁，数据库部分唯一索引再保证同实体唯一有效占用；没有 TTL、续期或断线释放。

## 桌面强制更新检查

`GET /api/v0/check_client_update?scenario=<launch|periodic|manual|...>` 服务 DSH 桌面强制更新策略客户端。无需会话；客户端版本取自 `x-client-version` header。未配置 `DESKTOP_UPDATE_MIN_VERSION` 时永远返回放行 `{"code":0,"data":{"biz_code":0,"biz_data":null}}`；配置后低于该 semver 门槛、或版本头缺失/不可解析的客户端返回强制 `{"code":40005,"data":{"show_content":{...}}}`（fail-closed）。可选文案与 `DESKTOP_UPDATE_APP_LINK`（必须 HTTPS，且其 origin 需在该桌面构建的 `allowedPageOrigins` 内，否则客户端丢弃链接）。环境变量见 `.env.example`。

## Docker 运行与一键启动

多阶段 `Dockerfile` 以仓库根为上下文构建（含 workspace 依赖、非 root 运行、入口幂等建 schema）。`compose.yml` 只构建并运行 api 一个服务，数据库与缓存使用本机已共用的 PostgreSQL 与 Redis 实例，编排内不再启动 postgres/redis 容器，也不重复拉取这两个镜像。api 服务不使用宿主机网络，而是由 Docker 把端口发布到宿主机（默认 `6972` → 容器 `3001`），因此外部机器按宿主机地址访问；宿主机防火墙只拦截本机绑定的套接字，Docker 发布的端口走转发路径，不受该规则影响。容器通过宿主机在 Docker 网桥上的地址（`172.17.0.1`）访问共用的数据库与缓存；该地址对容器和宿主机进程同时有效，`.env` 因此只需一个地址。企业形态仍是独立 PostgreSQL + 本镜像。

可选 `REDIS_URL` 启用共用 Redis 缓存 GitLab 读：用户身份（60s）、仓库成员（30s）、项目元数据（30s）、群组建仓选项（60s）；每次建仓仍实时复核用户与群组，写操作（`edit=true`）不读缓存。缓存不可用时自动退回远端读取，不影响协同正确性。

```sh
./start-backend.sh            # 需要 docker 与 compose 插件；读取 apps/collaboration-api/.env
EADP_API_PORT=6973 ./start-backend.sh   # 端口被占时覆盖
```

`start-backend.sh` 只构建 api 镜像并等待其健康，`--remove-orphans` 会清除本项目此前遗留的数据库与缓存容器。数据库与缓存的地址、凭证和 TLS 决定都在 `.env` 里，脚本不再代替它们选择实例。宿主机防火墙若只放行 ssh 等少数端口，发布端口不受影响；若改用宿主机网络模式监听本机套接字，则必须先在防火墙上放行该端口。

手动构建运行：`docker build -f apps/collaboration-api/Dockerfile -t eadp-collaboration-api:local .`，运行时显式传 `-e DATABASE_URL=... -e PG_SSL=disable -e GITLAB_URL=...` 等配置；镜像默认 `HOST=0.0.0.0`、容器内默认监听 3001，可用 `-e HOST=...` 覆盖。
