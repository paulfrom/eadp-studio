# G0 剩余编码交接

2026-10-15 完成 G0 剩余范围的 Linux 编码集成。G0-1 已有独立验收记录；本文仅记录本次实现与可用证据，不代表 G0 总体验收通过。

## 本次交付

- Studio 插件集成桌面 Host 与 Browser Client：Host 组合 DSH 会话、任务、原型模板、资产和协同后端适配器；Browser 提供工作台页面、资产/原型/协作交互。平台能力通过 DSH Host API 装配，不复制 agent loop。
- 模板与 Host 原型流程按固定模板 manifest 工作，含文件 SHA-256、受保护路径和可写路径。Umi/Webpack 在模块解析阶段拒绝越出工作区的资源路径；构建 loader 使用固定依赖配置。模板规则文档限制生成任务只编辑业务文件。
- GitLab OAuth 回调在插件本地完成，敏感值由 Host 安全存储；每个项目仅保存一个 Git remote URL。资产及协同后端按 G0-5/G0-6 接口实现，本地协同 API 默认 `127.0.0.1:3001`。不准备远程升级服务器。
- 桌面发行准备脚本将 Studio 源码、模板 allowlist、Host/Client TypeScript project references 和发行侧 DSH platform/browser 扩展装入忽略目录 `.local/build/dsh/`；发行改动保存在 `apps/desktop-distribution/build/`，上游缓存不作为源码维护。
- 已从 G0-6 计划正文移除明文数据库口令；实际数据库连接信息应由本机忽略配置提供。

## Linux 检查

- `pnpm --filter @eadp/collaboration-api typecheck` 通过。
- DSH 插件 Host 与 Client TypeScript project build 分别通过。
- `node apps/desktop-distribution/build/prepare-studio-plugin.mjs --stage-only` 可重复完成发行源码装配。
- 模板 `pnpm install --frozen-lockfile` 及 `pnpm run build` 通过。Webpack 正向构建通过；外部资源边界需在 Windows 实际桌面运行中复核。
- DSH 官方全工作区 `build:lib` 聚合构建在约 4、6、8 GB Node heap 下均因内存耗尽；未重复运行。该失败不影响 Host/Client 的独立 TypeScript 检查，但仍需 Windows 发行工具链确认。
- 使用本机 Docker PostgreSQL 17.10 的 `eadp_studio` 完成 schema 初始化与合成事务检查：并发认领唯一获胜、幂等重放、管理员释放及旧代次令牌拒绝均通过。测试合成项目和临时角色已清理，11 张 schema 表保留；未在仓库创建 `.env`。

## Windows 验收待办

在 Windows 工作站按项目开发环境和 G0-2 至 G0-6 计划完成实际桌面安装与启动，确认 DSH 官方插件加载、Host/Browser 通信、实际 GitLab OAuth 授权回调及凭证安全存储、单项目单 Git 地址、资产与协作 API；同时检查原型检查/预览/取消时进程退出和资源边界。当前本机 PostgreSQL 17.10 事务验证不代替 Windows 桌面连接、双客户端/断网恢复、TLS 与 G0-6 其余业务门禁验收。GitLab 回调地址和 OAuth 应用参数使用实际登记值。本机 Linux/browser 检查不能代替这些验收，也不能据此声明 G0 通过。
