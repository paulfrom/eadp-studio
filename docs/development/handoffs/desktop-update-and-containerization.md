# 桌面强制更新接口与容器化部署

2026-10-16，按既定计划完成两项交付：DSH 桌面强制更新策略的服务端裁决接口，以及协同后端的 Docker 镜像与本机一键启动。本记录汇总 Tasks 1-5 的实现、契约来源与验证证据；桌面端为 unsigned 构建，Windows 原生验收不在本轮。

## 变更清单

| 变更 | 提交 | 内容 |
| --- | --- | --- |
| 桌面默认协同地址 | `7bc8fe5` | `packages/studio-plugin/src/host/composition.ts` 默认 `collaborationUrl` 指向 `http://100.119.183.44:6972`（Tailscale 入口） |
| 升级裁决模块 | `b429220` | `src/desktop-update.ts`（`parseVersion`/`compareVersions`/`decideDesktopUpdate`）+ `src/config.ts` 可选 `desktopUpdate` 配置（minVersion 合法 semver、appLink 必须 HTTPS 且无凭据） |
| 升级检查接口 | `88b99c2` | `GET /api/v0/check_client_update` 注册进 `src/routes.ts`，preHandler 会话豁免单行追加；`src/app.ts` 传入 `config` |
| 镜像与幂等建 schema | `1bffe30` | 多阶段 `Dockerfile`、`docker-entrypoint.sh`（非 root、入口幂等建 schema）、`src/persistence/schema.ts` + `ensure-schema.ts`、`initialize.ts` 改用共享 applySchema、根 `.dockerignore`；`pnpm-workspace.yaml` 增加 `allowBuilds: esbuild: true`（pnpm 11 fresh install 必需） |
| compose 与一键脚本 | `8485073` | `apps/collaboration-api/compose.yml`（compose 项目 `eadp-collaboration`，postgres:17 + api，卷 `eadp-pgdata`）与仓库根 `start-backend.sh`（读取 `apps/collaboration-api/.env`，`EADP_API_PORT` 覆盖端口） |
| 最终评审修正 | `5546679` `938f23c` `ec24b51` | `EADP_API_PORT` 改在 source `.env` 之后读取（health 兜底只认 `healthy`）；镜像 `ENV HOST=0.0.0.0` 使手工 `docker run` 默认可达；`pnpm deploy --prod --legacy` 运行时仅生产依赖（含 `@eadp/*` workspace 源码注入） |

配套文档：本 API README 追加「桌面强制更新检查」「Docker 运行与一键启动」两节，`.env.example` 追加 `DESKTOP_UPDATE_*` 变量说明。

## 契约来源

上游 DSH commit `d743267`，`.local/upstream/dsh/apps/desktop/src/mandatory-update-policy.ts`（本地缓存只读引用，不入 Git）：

| 契约点 | 出处 |
| --- | --- |
| 请求 `GET {origin}/api/v0/check_client_update?scenario=...`，`cache:'no-store'`、`redirect:'error'` | `check()` 内 URL 构造，该文件 :187-190 |
| 每次检查带 8 个 `x-client-*` header（含 `x-client-version`，桌面策略另加 `x-client-arch`/`x-client-update-channel`/`x-client-bundled-dsh-version`） | `requestHeaders()` :158-164；`platformClientHeaders()` 于 `packages/credentials/deepseek-account/src/index.ts:154-162` |
| 强制响应：`code:40005`，`data.show_content` 的 `title`/`detail`，`data.desktop_app_link` | `parsePolicy()` :115-121 |
| 放行响应：`code:0` 且 `data.biz_code:0` 且 `data.biz_data:null` | `parsePolicy()` :123 |
| 链接约束：`desktop_app_link` 必须 HTTPS、无凭据，且其 origin 必须 ∈ 该桌面构建的 `allowedPageOrigins`，否则客户端丢弃 | `desktopPolicyPage()` :100-106 |
| 已知强制决定在传输/解析失败时保留，直到一次新的放行成功 | `catch` 分支 :201-205 |

后端只实现服务端裁决与响应形状；策略轮询、退避、UI 发布均属上游桌面端，不在本仓库。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| Task 1 裁决模块 TDD | RED 后 GREEN：`desktop-update.test.ts` 7/7；全量 12/12；`tsc --noEmit` 无输出 |
| Task 2 路由接线 TDD | RED（未注册路由时新测试失败）后 GREEN：8/8；全量 34/34（21 auth/gitlab + 8 desktop-update + 5 project-initialization）；`tsc --noEmit` 干净 |
| 镜像构建 | `docker build -f apps/collaboration-api/Dockerfile -t eadp-collaboration-api:local .` 成功；初版镜像 `c7c3d53ec755` 482MB，最终评审后 `pnpm deploy --prod --legacy` 精简为仅生产依赖约 378MB（`ec24b51`） |
| ensure-schema 幂等（镜像内，`--entrypoint node` 隔离） | 第一次：`Created the current collaboration schema.` 退出 0；第二次：`Collaboration schema already present; skipping initialization.` 退出 0；表计数 14 |
| clear 模式 smoke（6973） | `curl 'http://127.0.0.1:6973/api/v0/check_client_update?scenario=launch'` → `{"code":0,"data":{"biz_code":0,"biz_data":null}}` |
| block 模式 smoke（`DESKTOP_UPDATE_MIN_VERSION=99.0.0`，6973） | 带版本头 `x-client-version: 0.2.1-alpha.2` → `{"code":40005,"data":{"show_content":{}}}`；无版本头（fail-closed）→ 同 40005 |
| compose 生命周期 | `down` 后幂等重启，schema 走 `already present` 分支、clear 恢复；`down -v` 容器、卷、网络全部清除 |

注：本机 6972 端口由既有 systemd 服务 `eadp-collaboration-api.service` 占用，本轮容器验证全部使用 6973，未触碰该服务。

## 使用方式

```sh
./start-backend.sh                      # 需要 docker 与 compose 插件；读取 apps/collaboration-api/.env
EADP_API_PORT=6973 ./start-backend.sh   # 端口被占时覆盖
```

手动构建运行：`docker build -f apps/collaboration-api/Dockerfile -t eadp-collaboration-api:local .`；容器内默认监听 3001，`DATABASE_URL`/`PG_SSL`/`GITLAB_URL` 等全部走环境变量，入口先幂等建 schema 再启动 API。停止与清理：`docker compose -f apps/collaboration-api/compose.yml down`（保留数据卷）/ `down -v`（连卷清除）。

## 边界与非目标

- unsigned 构建的 electron-updater feed 仍未启用；强制更新只通过上述接口给出阻断提示与页面链接。
- Windows 桌面原生验收不在本轮；接口语义由本机容器 + Fastify inject 测试证明，不代替桌面宿主真实轮询联调。
- `DESKTOP_UPDATE_APP_LINK` 必须 HTTPS 且无凭据，其 origin 还须在该桌面构建的 manifest `allowedPageOrigins` 内，否则客户端静默丢弃链接；HTTP 链接永远不会生效。
- `compose.yml` 仅用于本机一键拉起；企业形态仍是独立 PostgreSQL + 本镜像，compose 里的 postgres 服务不代表企业部署形态。
- 6972 端口当前被 systemd 服务占用；compose 默认映射 6972，本机实际用 6973 验证，两者不要同时对外。
- 本次验证的测试账号、GitLab 代理与真实绑定范围沿用 [本机协同部署交接](local-collaboration-deployment.md)，未在本轮重复。
