# 新建项目长时间卡住 / 未收到成功状态：诊断与修复

2026-10-17。用户反馈桌面工作台新建项目时长时间停留在处理状态，最后报错且未收到成功状态。本轮修改 Studio Host/Client 的请求节奏与超时、本地部署代理配置，并在协同 API 引入本机 Redis 缓存 GitLab 读；未改协同 API 的业务语义、数据库或建仓校验。

## 现场与测量

真实运行服务为 compose（`eadp-collaboration-api-1`，`0.0.0.0:6972`，独立 compose 数据库）、真实企业 GitLab（`http://rddgit.changhong.com`）。复验当天 GitLab 单次 API 往返在 0.15s～7s 之间波动。

| 观察 | 结果 |
| --- | --- |
| 数据库中 `studio_project_creations` | 只有既有的 `测试项目`（GitLab 4025，`assigned`/ready）。用户失败的那次创建**没有**写入创建记录，说明客户端请求没走到登记，或停在登记前的 `namespace()` 校验 |
| `GET /v1/namespaces` | 45 个群组逐组校验成员，冷启动 26.2s，热 4.6～12s |
| `GET /v1/projects` | 1 个项目约 1.7～3s（每个项目 3 次 GitLab 往返） |
| 桌面客户端请求超时 | 原先固定 20s（`CollaborationClient`） |
| 状态轮询 | 每 5s 一次，串行进入 Host 命令队列 |
| 创建请求的 GitLab 链 | `create` 约 15 次串行 GitLab 往返（namespace 校验、`projectAt`、建仓、授权），慢速时段远超 20s |
| 后端代理 | `node --use-env-proxy` 生效，`NO_PROXY` 未含 GitLab 主机，每次 GitLab 调用都绕外部代理 |

结论：`state()` 每次都串行执行 `/v1/projects` 与 `/v1/namespaces`。当 `/v1/namespaces` 需要 5～26s 时，5s 轮询的入队速度快于出队速度，Host 命令队列持续增长；用户点击“创建项目”只是排到队尾，表现为长时间卡住。创建命令末尾还要再取一次 `state()`，任一请求超过 20s 就以客户端超时中止并报错，桌面端收不到成功状态。创建本身在慢速时段也会超过 20s（服务端仍可能继续执行，但客户端已报错）。

## 修改

桌面侧：

- `state()` 不再请求 `/v1/namespaces`；新增 `{ action: 'namespaces' }`，只在打开“新建 / 获取项目”对话框时拉取，结果保留在 Host 内存中供后续状态复用。登录/登出清空。
- 客户端请求超时改为可传参（默认 60s）；`/v1/namespaces`、`POST /v1/projects`、`POST .../initialize` 使用 180s，与服务端“逐次 GitLab 调用 15s 上限、创建流程多次串行”的实际边界匹配。
- 状态轮询改为“完成后再等 10s 再发起”，同一时刻最多一个状态请求，队列不会因远端变慢而堆积。
- 对话框在群组加载期间显示“正在加载可建仓群组…”。

服务端：

- 新增可选 `REDIS_URL`，按 GitLab 边界缓存读结果：用户身份 60s、仓库成员 30s、项目元数据 30s、群组建仓选项 60s；写入类授权（`edit=true`）与 `grantCreator` 全程实时校验，授权成功后失效成员缓存。建仓前仍实时复核用户与所选群组，缓存只服务列表与读取。
- 缓存故障自动退回远端读取（`ReadThrough` 捕获 Redis 错误），不阻塞协同操作；`createApp` 不等待 Redis 连接，Redis 不可达时 API 正常启动。
- compose 增加独立 `redis:7-alpine` 服务（无持久化），`start-backend.sh` 不变。
- `.env.example` 说明 `NO_PROXY` 必须包含 `GITLAB_URL` 主机；本机 `.env` 已加入 `rddgit.changhong.com` 并 recreate compose API。

## 验证

| 检查 | 结果 |
| --- | --- |
| `tests/gitlab-auth-host/projects.test.ts` | 8/8，新增用例断言轮询不读 namespace、对话框按需读取且只读一次 |
| `tests/windows-desktop/task-recovery.test.ts` + `session.test.ts` | 34/34 |
| `apps/collaboration-api` 单测（`gitlab.test.ts`、`cache.test.ts`、初始化、更新策略） | 37/37；覆盖缓存命中、缓存 `null`、失效、Redis 故障降级、读取缓存而建仓授权/写授权实时、授权后失效成员缓存 |
| `backend-lifecycle`（真实一次性 PostgreSQL） | 10/10 |
| `backend-consistency`（真实一次性 PostgreSQL） | 9/9 |
| `apps/collaboration-api` `tsc --noEmit` | 通过 |
| 变更 Host 文件临时 tsconfig 类型检查 | 通过 |
| 重启后真实服务 | `/health` ok；Redis 中出现 `namespaces:70`、`user:70`、`member:projects:4025:70:all`、`project:4025`；连续 `GET /v1/namespaces` / `GET /v1/projects` 均为约 3ms（缓存前 4.6～12s） |
| Redis 不可达（`redis://127.0.0.1:1`） | 读取返回缓存未命中并回源，`close()` 正常退出 |

未验证：Windows 安装包内的实际交互。桌面端需用本次源码重新打包（`./build-desktop.ps1`）后复验“新建项目”全流程；Linux 侧类型检查与模拟 API 用例不能替代。

## 边界

- 用户那次失败的具体错误文案没有取到；本轮修复的是已测量的卡住机制（轮询堆积、超时短于真实远端耗时、未命中缓存时反复走远端）。若重新打包后仍失败，需要记录界面报错文案与失败阶段（创建登记 / 本机 push / 后端初始化核验）。
- 缓存是读加速，不是权限来源：成员/项目/群组缓存最多陈旧 30～60s；建仓与写操作实时校验。Redis 数据不含材料正文、口令或 GitLab 管理令牌以外的凭证。
- 复验时执行人为诊断在真实 GitLab 群组 552 误建了项目 `probe-does-not-create`（GitLab 4026），已删除协同库中的登记与审计记录，但管理令牌与绑定用户都只有 Maintainer 权限，删除仓库返回 403，需有 Owner 权限者处置。
