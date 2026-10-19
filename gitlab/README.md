# GitLab 当前接入与旧 OAuth 归档

GitLab 仍是当前业务项目的代码托管平台。工作台只登录协同后端；后端把独立协同用户绑定到已存在的 GitLab 数字用户 ID，按绑定成员权限过滤目录/群组，并通过仅后端管理的 `SEI_GITLAB_TOKEN` 调用受控建仓、成员和固定内容 API。用户本机 Git 凭据负责 clone/push；桌面不接收管理 token。

当前实现位于正常的 `apps/`、`packages/` workspace 中，具体身份/建仓契约见 [ADR 0003](../docs/adr/0003-studio-auth-and-project-provisioning.md) 及 [API README](../apps/collaboration-api/README.md)。本目录只保留被替代的 [客户端 GitLab OAuth 直接登录方案](legacy-oauth/README.md)，不表示当前 GitLab 管理 API 被归档或暂停。

旧 OAuth/PKCE/loopback 与候选 GitHub Device Flow 都不作为当前运行入口；不实现双身份路径、兼容或 fallback。默认测试管理员只证明单账号测试，真实 GitLab 管理 API、用户本机凭据、Windows 和双作者验收仍须目标环境执行。
