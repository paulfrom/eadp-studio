# 桌面升级检查接口与协同后端镜像化设计

日期：2026-10-16。状态：已获用户确认（两阶段设计评审通过）。

## 背景与目标

1. 桌面端默认协同后端地址改为 `http://100.119.183.44:6972`（正式发布后再改）。
2. 协同后端实现桌面强制更新策略检查接口（DSH `mandatory-update-policy` 客户端契约，路由 `/api/v0/check_client_update`），替换当前 `unavailable` 状态。
3. 协同后端镜像化：交付 API 的 Dockerfile、本机一键拉起的 compose（不入企业交付），以及一键启动 bash 脚本。

## 1. 默认地址

- `packages/studio-plugin/src/host/composition.ts:35` 的回落值由 `http://127.0.0.1:3001` 改为 `http://100.119.183.44:6972`。仅一处定义，无测试依赖旧值；profile 的 `cordis.patch.yml` 仍优先于默认。

## 2. 桌面升级检查接口

### 客户端契约（上游 DSH commit d743267 取证，`.local/upstream/dsh/apps/desktop/src/mandatory-update-policy.ts`）

- 请求：`GET {origin}/api/v0/check_client_update?scenario=<launch|periodic|manual|foreground-or-resume|login-return>`；无鉴权（anonymous 模式不带凭据）；版本信息在 headers：`x-client-version`、`x-client-arch`、`x-client-platform`、`x-client-update-channel`（固定 `nightly`）、`x-client-bundled-dsh-version` 等。
- 放行响应：HTTP 2xx 且 body 严格为 `{"code":0,"data":{"biz_code":0,"biz_data":null}}`。
- 强制响应：`{"code":40005,"data":{"show_content":{"title"?,"detail"?},"desktop_app_link"?}}`；HTTP 状态码不参与判定；三个字段全部可选，裸 `{"code":40005}` 即阻断；未知字段被忽略。
- 其他一切（非 2xx、超时、畸形 JSON）客户端按「保留旧状态 + 退避重试」处理；已建立的阻断只有收到一次干净放行响应才解除。
- `desktop_app_link` 客户端约束：必须 HTTPS、无用户信息、长度 ≤2048、origin 在桌面 manifest 的 `allowedPageOrigins` 内，否则被静默丢弃（只阻断不给链接）。当前桌面构建的 `allowedPageOrigins` 无 HTTPS origin，故链接默认不配置。

### 服务端设计（`apps/collaboration-api`）

- 新模块 `src/desktop-update.ts`：解析请求 header 中的 `x-client-version`，按配置裁决；路由 `GET /api/v0/check_client_update` 注册于 `src/routes.ts`，并加入该文件头部既有的会话豁免名单（`:11`），此接口在 `/v1` 命名空间之外。
- 配置（`src/config.ts` 新增，全部可选，`.env.example` 同步）：
  - `DESKTOP_UPDATE_MIN_VERSION`：最低允许版本（semver）。未配置 → 永远返回放行。
  - `DESKTOP_UPDATE_BLOCK_TITLE` / `DESKTOP_UPDATE_BLOCK_DETAIL`：强制窗口文案。
  - `DESKTOP_UPDATE_APP_LINK`：可选下载页链接，配置时必须是合法 HTTPS URL，否则配置加载直接报错。
- 裁决语义：`x-client-version >= MIN_VERSION` → 放行；低于 → 强制；未配置 MIN_VERSION → 一律放行。header 缺失或版本无法解析 → 按强制处理（fail-closed），并记录日志。semver 比较优先复用仓库锁定依赖中已有的 `semver`，否则做最小自实现，不盲目加新依赖。
- `scenario` 参数不参与裁决，原样忽略。
- 文案缺省时强制响应可只含 `{"code":40005}`。

## 3. Dockerfile（交付物）

- 位置 `apps/collaboration-api/Dockerfile`，构建上下文为仓库根（workspace monorepo）。
- 多阶段：deps 阶段仅拷贝 `pnpm-workspace.yaml`、根及各 workspace 包 `package.json`、`pnpm-lock.yaml`，corepack 启用 pnpm 后 `pnpm install --frozen-lockfile`；runtime 阶段拷入 `apps/collaboration-api` 与 `packages/contracts` 源码及生产依赖（tsx 直接执行 TS，无构建产物），非 root 用户 `eadp` 运行。
- 基础镜像：与 `.node-version` 对齐的固定 Node 22 slim tag。
- 入口：entrypoint 检测 schema 是否已建（以 `studio_users` 表存在为标记），未建则在单事务内应用 `db/schema.sql`（与手工 `db:init` 同一文件），随后 `exec node --use-env-proxy --import=tsx src/bootstrap.ts`。容器重启/重建幂等。不改 `db:init` 语义，schema.sql 仍是唯一建库定义，无迁移路径。
- `EXPOSE 3001`；HEALTHCHECK 用容器内 node fetch `/health`。
- `.dockerignore`：排除 `.git`、`node_modules`、`.local`、文档与测试产物。

## 4. 本机 compose（非交付物）

- 位置 `apps/collaboration-api/compose.yml`。
- `db`：官方 `postgres:17` 镜像，命名卷持久化，healthcheck 就绪门控。
- `api`：本地 build（根上下文），`depends_on: db (service_healthy)`；环境变量模板默认 `DATABASE_URL` 指向 compose 内 db、`PG_SSL=disable`（沿用现有本机 loopback 约定）、`HOST=0.0.0.0`；GitLab 相关变量由使用方填写，显式代理 env 沿用。端口映射 `6972:3001`，与现有测试入口一致。
- 企业正式部署仍是独立 PG 实例 + 此 API 镜像；compose 不替代该形态。

## 4.1 一键启动脚本（交付物）

- 位置 `start-collaboration-backend.sh`（仓库根目录，chmod +x，入 Git）；compose.yml 仍在 `apps/collaboration-api/`，脚本内部以仓库根为定位基准（`cd` 到脚本所在目录后引用 compose 路径）。
- 行为：
  1. 检查 `docker` 与 `docker compose` 可用，缺失时明确报错退出。
  2. 环境变量取自 `apps/collaboration-api/.env`（Git 忽略）或已 export 的环境；compose 必需项缺失（如 `GITLAB_URL`）时明确报错并指向 `.env.example`，不静默带过。
  3. `docker compose up -d --build` 构建并拉起 `db` + `api`。
  4. 轮询等待 `http://127.0.0.1:6972/health` 就绪（带超时），成功后输出入口地址与常用命令提示（查看日志、停止），失败时输出最近日志并非零退出。
- 幂等：重复执行 = 重新构建并重启服务，不产生重复资源。

## 5. 验证与文档

- 单测：升级接口路由测试覆盖放行、强制、低于门槛、缺失/不可解析版本头（fail-closed）、链接配置校验；既有测试全绿；`pnpm --filter @eadp/collaboration-api typecheck` 通过。
- 实测：compose 拉起后 curl 验证 `/health` 与 `/api/v0/check_client_update` 两种模式（未配置门槛 → 放行结构；配置门槛 → 高/低于门槛各自响应）；并执行根目录 `start-collaboration-backend.sh` 做一次完整的一键启动/健康就绪/停止循环。
- 文档：`.env.example` 增补 4 个新变量；API README 增加升级接口与 Docker/compose 运行两节；按仓库惯例在 `docs/development/handoffs/` 记录部署与验证结果。

## 不变边界

- 不修改 `.local/upstream/dsh/` 上游缓存；`apps/desktop-distribution/build/desktop-policy-edits.mjs` 保持不变（已把策略 origin 放行 HTTP）。
- 不动 `db:init` 手工流程；不引入迁移/兼容层（仓库规则 0）。
- 本阶段不做签名构建、更新 feed（electron-updater）与升级验收——仍属 G0 之后的发行工作。
