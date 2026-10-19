# 旧 GitLab OAuth 直接登录实现

2026-10-15 用户确定改用“只登录协同后端、绑定既有 GitLab 账号、后端受控管理 API 建仓/分配、本机用户 Git 初始化推送”。本目录仅归档被替代的客户端 GitLab OAuth/PKCE/loopback 直接登录源码，不是当前运行代码，不是受支持的兼容实现，也不作为 fallback。GitLab 管理 API 仍是当前在用能力，入口见 [上级说明](../README.md)。

快照来源为任务基线 `46fdb5d6734e1bdbae537ae14dc4ba8ca1eabc99`，原相对路径和原始字节保留，逐文件 SHA-256 与来源见 [archive-manifest.json](archive-manifest.json)。没有复制真实 `.env`、管理 token、用户凭据、依赖、构建产物或运行数据。历史计划、验收与交接文档已清理，不再随归档保留。

| 位置 | 历史内容 |
| --- | --- |
| `implementation/packages/studio-plugin/src/host/adapters/gitlab/auth.ts` | 旧 Host OAuth/PKCE、loopback 回调与安全存储 |
| `implementation/apps/collaboration-api/src/auth/gitlab.ts` | 旧客户端 GitLab token 实时身份及项目权限校验 |

这是选取的历史源码，不能独立运行。根 pnpm workspace 只匹配 `apps/*`、`packages/*`；归档没有 package 入口，不参与当前 TypeScript 构建或发行装配，当前代码不得导入它。

后续若重新选择 OAuth，须另作明确实施决策，重新验证实际实例、应用注册、真实授权/刷新/撤销、最小 scope、安全保存及 Windows 宿主；不能直接把旧源码接回当前依赖图。

当前依据为 [ADR 0002](../../docs/adr/0002-backend-transient-git-validation.md)、[ADR 0003](../../docs/adr/0003-studio-auth-and-project-provisioning.md) 及 [API README](../../apps/collaboration-api/README.md)。
