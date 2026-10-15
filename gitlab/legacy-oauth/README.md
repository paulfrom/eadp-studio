# 旧 GitLab OAuth 直接登录实现

2026-10-15 用户确定改用“只登录协同后端、绑定既有 GitLab 账号、后端受控管理 API 建仓/分配、本机用户 Git 初始化推送”。本目录仅归档被替代的客户端 GitLab OAuth/PKCE/loopback 直接登录方案，不是当前运行代码，不是受支持的兼容实现，也不作为 fallback。GitLab 管理 API 仍是当前在用能力，入口见 [上级说明](../README.md)。

快照来源为任务基线 `46fdb5d6734e1bdbae537ae14dc4ba8ca1eabc99`，原相对路径和原始字节保留，逐文件 SHA-256 与来源见 [archive-manifest.json](archive-manifest.json)。没有复制真实 `.env`、管理 token、用户凭据、依赖、构建产物或运行数据。历史文档内部相对链接沿用原文，当前导航以本页末尾入口为准。

| 位置 | 历史内容 |
| --- | --- |
| `implementation/packages/studio-plugin/src/host/adapters/gitlab/auth.ts` | 旧 Host OAuth/PKCE、loopback 回调与安全存储 |
| `implementation/apps/collaboration-api/src/auth/gitlab.ts` | 旧客户端 GitLab token 实时身份及项目权限校验 |
| `history/dsh_eadp_studio_plan/` | 旧 G0-4 探测与 04 待实测清单 |
| `history/docs/adr/` | 身份修订前的临时固定正文读取决策 |
| `history/docs/development/handoffs/`、`history/apps/collaboration-api/README.md` | 原编码报告、运行说明与当时证据边界 |

这是选取的历史源码和文档，不能独立运行。根 pnpm workspace 只匹配 `apps/*`、`packages/*`；归档没有 package 入口，不参与当前 TypeScript 构建或发行装配，当前代码不得导入它。

2026-10-14 对原实例 `http://rddgit.changhong.com` 做过匿名无 Cookie 的只读请求：HTTP 登录页 200、`/api/v4/version` 401、同 host HTTPS 登录页 200 且默认 TLS 验证通过、HTTPS OAuth 授权路由重定向到登录页。未登录、注册应用或修改实例；只证明当时入口可达，不证明实例版本、PKCE、回调、scope、真实用户令牌、Git 传输或固定正文授权读取成功，见 [旧 G0-4](history/dsh_eadp_studio_plan/G0-4-代码托管与单站点发布契约.md)。

2026-10-15 旧版本执行过 Linux TypeScript、无外部依赖的内容/请求和短发布 token 边界检查，未完成真实 OAuth 或 Windows 验收。原记录按原日期事实保留，未改写为当前协同会话/管理 API 已通过。旧本机 PostgreSQL 四项事务检查也只证明当时所测事务，不能证明新身份/初始化或多人权限。

后续若重新选择 OAuth，须另作明确实施决策，重新验证实际实例、应用注册、真实授权/刷新/撤销、最小 scope、安全保存及 Windows 宿主；不能直接把旧源码接回当前依赖图，也不能把历史路由探测算作授权通过。当前固定正文的“先按绑定成员验权、再在内存读取校验，不借管理 token 扩大读权”不受归档影响。

当前依据为 [ADR 0002](../../docs/adr/0002-backend-transient-git-validation.md)、[ADR 0003](../../docs/adr/0003-studio-auth-and-project-provisioning.md)、[API README](../../apps/collaboration-api/README.md) 及 [本次交接](../../docs/development/handoffs/studio-auth-projects.md)。
