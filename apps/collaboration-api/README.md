# 协同 API

Fastify + PostgreSQL 模块化单体，服务端使用当前操作者的 GitLab OAuth access token 验证真实用户和项目权限。每个项目只登记一个 GitLab 仓库及一条稳定分支。正文只保存在 Git，业务 API 的 JSON schema 拒绝正文及未知字段。

## 本机运行

先在仓库根安装锁定依赖，然后复制 `.env.example` 为 `.env` 并配置数据库。凭证只保存在忽略的本机文件。`PG_SSL` 必须明确选择 `require` 或 `disable`，不会自动降级；`require` 校验证书，企业 CA 通过标准 `NODE_EXTRA_CA_CERTS` 配置。已提供的测试端点没有接受 SSL 协商，本轮未进行数据库认证或建表。

```sh
pnpm --filter @eadp/collaboration-api db:init
pnpm --filter @eadp/collaboration-api start
```

`db:init` 对新的 `public` schema 一次性执行 `db/schema.sql`，默认数据库由连接串指定。不维护迁移链、不自动清库、不修改现有表。不应对已有其他用途数据库直接执行。运行默认监听 `127.0.0.1:3001`；企业部署时在受控 TLS 入口后配置 HOST。`GET /health` 检查数据库连接。

GitLab 当前实例按计划使用 `http://rddgit.changhong.com`，示例通过 `GITLAB_ALLOW_HTTP=true` 明确允许该已选择测试入口。维护者变更地址时，Host 的 OAuth origin、API 的 `GITLAB_URL` 和仓库 URL 必须对应同一实例。服务端不保存 access token，不替用户注册 OAuth 应用、不运行 Agent。OAuth PKCE/loopback 回调由桌面 Host 处理，API 仅验证 Bearer token。

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

后端从登记 GitLab 项目的 raw file endpoint 按完整 commit SHA 读取内存字节，限制单文件 2 MiB、15 秒超时，独立计算 SHA-256、解析并比较元数据；不使用会转换编码的 JSON file content 字段。失败、无权限、不一致、未知均阻断。Fastify 关闭日志，错误只返回固定诊断及必要 ID，不返回正文、GitLab 响应、凭证或 SQL 错误。

## API 与推进

所有 `/v1` 路由要求 `Authorization: Bearer <GitLab OAuth access token>`；读取要求能访问项目，编辑要求 GitLab Developer 或更高的有效项目/组权限。管理员 ID 由服务端 `GITLAB_ADMIN_USER_IDS` 配置，只额外授予明确占用释放/集成纠正权，不授予项目编辑权。

| 方法与路径（`P=/v1/projects/:projectId`） | 返回 |
| --- | --- |
| GET `/v1/me`、GET `/v1/projects`、POST `/v1/projects` | 当前身份、可见项目、登记结果 |
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

持久业务写请求均含 `idempotencyKey`（短发布授权是一次性签发用途，不落库），同项目内同键只能对应同操作者、同动作和相同请求。重连先查询，404 表示后端尚无该操作者的受理结果，不能推断 Git 未发生。错误结构统一为 `{error:{code,message,details?}}`，冲突通常为 409。

材料与原型均走同一集成入口：Host 从 `recognizedHead` 构造候选并推送临时任务引用，上传固定材料引用/metadata 和精确候选检查证据；API 核验固定字节、唯一占用、代次/revision、输入/前置、冻结、源与候选差异及实际稳定分支；受理后 Host 以旧 SHA 条件更新稳定分支，再 complete。候选第一父提交须为 expectedHead，源与候选相对该头的差异须一致；认可头变更后须重建和重检，不能合入其他任务的未认可变化。普通材料检查名为 `materials`、`relations`；原型另须 `engineering`、`mock`、`browser`、`relations`。API 记录 Host 的检查哈希和可信作者确认方式，不代替桌面工程检查。

一次只受理一个项目集成窗口，其他需求的本地任务和占用继续。Git 与数据库没有分布式事务：实际分支与认可头不一致时阻断下一集成和发布；占用释放作废旧操作、原子解冻，但不撤销在途 Git。已推送候选且原占用有效时续办同一操作；占用撤销后保留 Git 证据，由管理员在 Git 做可追溯反向纠正，核验纠正树等于原认可树后登记新头。不执行强推或自动丢弃现场。

场景批次用 `purpose=scenario-batch` 领取场景占用，同事务冻结全部相关需求；任何相关占用/其他冻结导致整体拒绝。在批次内预留新需求时传 `batch:{scenarioId,token}`，会递增场景 `associationRevision`。提交须带最新 `expectedAssociationRevision`、完整 `batchRequirementIds`；已完成的当前版本只保留，变化范围派生新 ID，未开始的相关需求全部同事务确认。失败不接受部分更新。

前置按明确材料版本绑定已接受完成事件/认可 SHA。编辑新版本不篡改旧完成历史，也不会让新范围提前完成；明确指定旧完成版本仍可使用旧依据。完成产生单需求原型基线并自动释放；清单/批次基线是独立 `handoff`/`baseline` 实体，只聚合已接受的完成版本，不重新批准原型。收悉只记录接收人及固定清单确认依据。

## 验证边界

已执行 TypeScript 检查、一次无外部依赖的请求/内容边界核对及发布 token 作用域/签名/独立权限核对。实际 PostgreSQL、真实 GitLab OAuth/权限/固定内容、双客户端并发与 Windows 宿主均留给后续目标环境验收。本轮没有启动远端服务、没有创建远程升级服务器。

可选的 `pnpm --filter @eadp/collaboration-api check:transactions` 在已初始化的 G0 数据库中只创建一个合成项目，检查并发唯一占用、幂等重放、管理员释放与旧代次拒绝，最后删除其测试数据；不自动执行大套测试。

实现采用 [GitLab raw file API](https://docs.gitlab.com/api/repository_files/)、[项目权限 API](https://docs.gitlab.com/api/projects/)、[Fastify JSON schema 校验](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) 与 [PostgreSQL 显式锁](https://www.postgresql.org/docs/current/explicit-locking.html)。每个动作在短事务内按稳定项目 ID 排序加行锁，数据库部分唯一索引再保证同实体唯一有效占用；没有 TTL、续期或断线释放。
