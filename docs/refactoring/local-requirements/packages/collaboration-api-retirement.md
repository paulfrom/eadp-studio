# collaboration-api 与远程协同退役

状态：计划删除。用户范围明确取消协同后端及场景、确认、基线、交接；不把旧后端领域流程迁成本地服务。

## 1. 当前证据

- `apps/collaboration-api/src/routes.ts` 约 40 条路由；`service.ts` 46 KB 编排事务/身份/项目/材料；`modules/` 含占用、整合、原型、复用等；`persistence/repository.ts` 45.6 KB；`db/schema.sql` 99 KB、约 40 张表。
- `packages/studio-plugin/src/host/composition.ts` 默认连接 `http://100.119.183.44:6972`，装配 `CollaborationTransport/Session/Client`、GitLab 身份、发布授权、远端项目/材料/任务。
- 启动脚本 `start-backend.sh`、容器/部署配置、根 README/CONTEXT/AGENTS 中的协同规则。
- 删除目标是本地软件不再请求该服务，不是远程停机或删除服务数据；后者需要独立授权与数据处理范围，本次不执行。

## 2. 删除与保留

| 当前职责 | 目标 |
| --- | --- |
| Fastify、路由、PostgreSQL、Redis、认证、GitLab 成员权限 | 删除包、部署、客户端依赖、数据库定义 |
| 协同项目建仓/克隆/推送/远端固定 | 删除；改为 DSH Workspace + 普通目录 |
| 场景确认、来源约束、基线、交接收悉 | 删除整个产品能力，不迁入 SQLite |
| 占用、管理员释放、协作任务、候选合并、复用 | 删除，不替换成单机状态机 |
| 发布令牌/部署记录/发布/撤回 | 删除目标产品入口与专用代码；不关闭既有线上资源 |
| 文件修改安全 | 由 requirements/prototype 的 `ctx.fs` containment + 版本核对 |
| 防重复操作 | 文件版本条件写、提案内存、进程串行；不保留后端事务引擎 |
| 运行诊断 | 本地有界日志；删除远端业务审计表 |
| 桌面更新检查 | 复核现有调用方；不保留协同 API 仅为更新接口。若保留更新，使用独立 HTTPS 配置，不伪造“已是最新” |

## 3. 调用方和配置清理

- 删除 `host/adapters/collaboration/{client,session,transport}.ts`、协同凭据键、GitLab origin/成员/namespace/占用/任务/发布调用。
- 删除 `start-backend.sh`、后端容器/环境配置、工作区依赖与部署文档入口；检查脚本不再要求协同地址/GitLab 环境。
- 删除 `shared/studio.ts`/contracts 中 connected/account/member/occupation/task/baseline/handoff 等类型。
- 不无差别删除系统 Git、网络工具或用户自己的仓库；不删除模型凭据/原生会话。
- 桌面开发/打包的 `windows-package.env.example` 中协同 origin/更新配置按实际需要处理；删除仅为允许协同 HTTP 的策略编辑。
- 仓库缺口清单中仅服务协同的绕过（HTTP origin、秘密 IPC、消息准入等）一并删除或重新登记；当前 `docs/blocked-upstream.md` 缺失，实施前需按 AGENTS 恢复/重建。

## 4. Editor 参考

Editor 的“普通文件夹 + DSH 会话/模型权威 + 本地单用户”方向可参考；它没有本项目可复制的协同后端，取消服务后的职责边界才是参考对象。DSH 本地 Host 仍存在，不把“去后端”误读为删除 Host 或把文件权限交给 Renderer。

## 5. 删除顺序与验收

1. 代码内追踪所有 API/认证/配置/更新检查/发布/占用/任务调用。
2. 随本地项目/需求/原型/知识切片替换必要调用；直接删除取消功能，不设本地 CollaborationClient 模拟层。
3. 从最终发行组合移除旧包与配置后删除服务源码/数据库定义；更新锁文件、根 README、CONTEXT、AGENTS、构建说明。
4. 在协同服务不可达环境验证启动、项目打开、需求保存、原型运行、知识检索和原生 AI 会话；观察本地日志，无协同请求/无限重试。
5. `pnpm check`、受影响构建、最终安装包桌面闭环；不访问/停用/删除远端服务及数据库，不用清空本地缓存掩盖残留依赖。

以上尚未执行。
