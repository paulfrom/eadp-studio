# 本机协同后端测试部署

2026-10-15，按用户指定环境部署：本机 Docker pg17、GitLab 显式 HTTP 代理、工作站对外端口 6972。本记录面向客户端联调，不代表 Windows 原生或双作者协同验收完成。

## 运行配置

| 项目 | 实际配置 |
| --- | --- |
| API 监听 | `0.0.0.0:6972` |
| 局域网入口 | `http://192.168.88.101:6972` |
| Tailscale 入口 | `http://100.119.183.44:6972` |
| 数据库 | Docker `pg17`，PostgreSQL 17.10，`127.0.0.1:5433/eadp_studio` |
| 数据库账号 | 独立运行角色 `eadp_collaboration`，表 DML/序列权限；不使用 postgres 作为服务账号 |
| 数据库传输 | 本机 loopback，显式 `PG_SSL=disable` |
| GitLab | `http://rddgit.changhong.com`，显式允许测试 HTTP |
| GitLab 代理 | `HTTP_PROXY` / `HTTPS_PROXY` 为 `http://100.70.11.40:7897` |
| 代理绕过 | `NO_PROXY=localhost,127.0.0.1,::1,192.168.88.101,100.119.183.44` |
| Node | 22.22.3，启动时添加 `--use-env-proxy` |
| 配置与凭据 | `apps/collaboration-api/.env`，权限 0600，Git 忽略；管理 token 仅在后端 |

部署前逐表确认原有 11 张旧业务表均为零行，在锁表事务内再次核验后删除旧空表，并执行当前 `db/schema.sql` 建立 14 张表。没有删除业务数据，没有保留旧 schema 的兼容或迁移路径。原空 schema 的快照仅保存在忽略的 `.local/deployment/`，不作为运行依赖。

## 服务管理

运行在已有 linger 支持的用户级 systemd 下，服务文件为 `~/.config/systemd/user/eadp-collaboration-api.service`，已启用随用户管理器启动、失败重启。工作目录为本仓库 `apps/collaboration-api`，ExecStart 使用已安装 Node 的绝对路径及以下参数：

```sh
node --use-env-proxy --env-file=.env --import=tsx src/bootstrap.ts
```

服务依赖本仓库及锁定安装的 workspace 依赖，不复制源码到运行缓存。不修改系统全局代理。`curl -x` 只影响单次 curl，普通 `pnpm start` 也不会自动启用 Node 的环境代理。

```sh
systemctl --user status eadp-collaboration-api.service
systemctl --user restart eadp-collaboration-api.service
systemctl --user stop eadp-collaboration-api.service
journalctl --user -u eadp-collaboration-api.service --no-pager -n 30
curl --noproxy '*' http://127.0.0.1:6972/health
```

## 客户端连接

提交 `7bc8fe5` 已将桌面默认地址改为 `http://100.119.183.44:6972`，使用该提交之后源码生成的安装包无需手工配置此地址。需要使用其他部署地址时，在桌面 profile 的 `cordis.patch.yml` 设置 `collaborationUrl`。未设置 `DSH_HOME` 时，文件位于 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`；设置了 `DSH_HOME` 则位于该目录下的 `profiles\desktop\cordis.patch.yml`。保留文件中其他 patch；如果已有 `studio-plugin` 项，修改其 config 并保留其他 Studio 配置，随后重启桌面。

```yaml
- id: studio-plugin
  config:
    collaborationUrl: http://100.119.183.44:6972
```

同一局域网可改为 `http://192.168.88.101:6972`。测试入口为 `studioAdmin` / `admin@123`；协同 ID 1 已通过真实 GitLab 绑定到 ID 70（`songlin.liu`），账号邮箱 `songlin.liu@changhong.com`。用户本机 Git 凭据独立配置；后端代理不会替 Windows Git 配置网络。

## 身份与验证范围

真实 `/user` 返回 token 所属 ID 70、用户名和精确邮箱；同一邮箱的 `/users?search=...` 返回空，用户名目录结果不含私有邮箱。因此解析使用 `/user` 的正式身份信息进行精确匹配；不同账号仍要求目录唯一精确匹配，不推断邮箱前缀、不自动重绑。接口语义见 [GitLab Users API](https://docs.gitlab.com/api/users/#retrieve-the-current-user)。

真实实例的可见群组列表包含无权读取成员的群组。目录只对群组成员读取的 403/404 排除该组，不把管理 token 可见性当作用户成员资格；401、限流、上游失败和未知建仓策略继续阻断。目录使用本次完整分页列表中的策略，最多 8 个并发成员查询，结果保持列表顺序。具体建仓仍重新读取当前成员和群组策略，不以目录旧结果授权。参见 [Groups API](https://docs.gitlab.com/api/groups/) 与 [Group members API](https://docs.gitlab.com/api/group_members/)。

最终验证环境为 Linux `7.2.9-200.fc44.x86_64`、x86_64、Node 22.22.3、pnpm 11.28.5、PostgreSQL 17.10；后端代码版本 `f859ccc`。本记录为 `self_review`，不计 Windows 或双作者独立复验。

| 检查 | 实际结果 |
| --- | --- |
| 本机 loopback、局域网 IP、Tailscale IP 的 `/health` | 三个入口从部署机访问均为 200，数据库连接有效；不替代另一台客户端网络检查 |

2026-10-16 端口冲突记录：当日 13:40 容器化验证（见 [桌面更新与容器化](desktop-update-and-containerization.md)）的 compose 容器被遗留运行，`docker-proxy` 占用宿主机 6972，导致本服务自 17:25 起重启循环（`could not start`，exit 1）。已停止 `eadp-collaboration-api-1`/`eadp-collaboration-db-1`，服务恢复独占 6972。两形态不要同时对外；容器验证后用 `docker compose -f apps/collaboration-api/compose.yml down` 清理。
| 未登录访问、错误密码 | 均为 401 |
| 登录、`/v1/me`、项目目录 | 均为 200；协同 ID 1 绑定 GitLab ID 70；尚无业务项目，目录为空 |
| 可建仓群组目录 | 200，返回 45 组，最终实际接口请求 12.48 秒，低于现有客户端 20 秒超时 |
| 服务重启 | 当前会话仍可 `/v1/me`，200，证明本次会话持久化恢复 |
| 注销与撤销后访问 | 注销 200，原会话随后为 401 |
| 真实 pg17 的聚焦事务检查 | 并发唯一占用、原结果幂等重放、管理员释放/新代次和旧代次拒绝通过；合成项目已清理 |
| 账号/权限/首提交单测 | 26 项通过，后端 TypeScript 检查通过 |
| 隔离 PostgreSQL + GitLab HTTP fixture 生命周期 | 9 项通过；临时数据库已删除，不计真实 GitLab 写操作通过 |
| 仓库检查 | 208 个跟踪文件、47 个模板哈希一致，差异格式检查通过 |

此前群组权限拒绝和超过 20 秒超时的失败未计为通过。最终实现独立调用测得 14.20 秒、86 个 GitLab 请求、最大并发 8、无逐组详情请求，随后上述实际 API 复验成功；代理网络波动仍可能触发客户端超时，不能把单次成功解释为延迟保证。脱敏的最终接口结果仅保存在本机忽略的 `.local/deployment/smoke-results.json`。

本轮没有在企业 GitLab 创建测试仓库、修改成员或推送 Git。下一步由 Windows 客户端连接上述地址，验证本机 Git helper、首次推送、pending/ready 初始化、真实业务认领及双客户端协同；这些未执行项与已通过的服务入口检查分别记录。完整临时输出、凭据和运行数据不入 Git。
