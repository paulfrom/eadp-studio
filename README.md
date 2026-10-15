# EADP Studio

人与 AI Agent 协作整理业务材料和演示成果的桌面工作台。

研发仓库：`git@github.com:paulfrom/eadp-studio.git`。Linux 与 Windows 共享同一源码基线、规划、配置和任务交接；依赖、上游缓存和运行现场各自生成。

## 当前状态

当前业务托管为 GitLab，工作台只登录协同后端；后端绑定既有 GitLab 账号并按真实成员权限管理建仓/分配，Host 使用本机用户 Git 凭据初始化/push，后端核验后 ready。默认测试入口与接口见 [API README](apps/collaboration-api/README.md)，决策与证据边界见 [ADR 0003](docs/adr/0003-studio-auth-and-project-provisioning.md) 和 [本次交接](docs/development/handoffs/studio-auth-projects.md)。旧 OAuth 仅存 [legacy-oauth 归档](gitlab/legacy-oauth/README.md)，当前 GitLab 管理 API 继续使用。

已落实单仓库开发布局、Git 属性、独立模板快照及校验、模板 `AGENT.md` 规则契约、固定 DSH 归档获取入口。已有 Studio Host/client、协同 API 与发行装配编码；模板规则加载、执行保护、Windows 发行和真实协同按对应门槛继续验证，不代表 G0 总体通过。实际进展见 [G0 交接](docs/development/handoffs/g0-remaining.md)，早期准备见 [开发准备交接](docs/development/handoffs/repository-setup.md) 与 [模板规则交接](docs/development/handoffs/template-rules.md)。

## 文件位置

| 路径 | 内容 |
| --- | --- |
| `packages/studio-plugin/` | Studio Host/client 插件源码与随包模板 |
| `apps/collaboration-api/` | 协同登录、绑定成员授权、GitLab 建仓及持久协同 API |
| `gitlab/legacy-oauth/` | 旧直接 OAuth 登录源码/证据归档，不进入构建 |
| `apps/desktop-distribution/` | 固定上游版本及发行装配脚本 |
| `.local/upstream/dsh/` | 获取成功后生成的本机 DSH 源码，不提交 |
| `scripts/` | 可实际运行的开发准备与校验脚本 |
| `docs/development/` | 开发环境和任务交接 |
| `docs/adr/`、`CONTEXT.md` | 架构决策及领域定义 |
| `dsh_eadp_studio_plan/` | 产品设计、实施任务与验收要求 |

`asset-domain`、`contracts` 与协同 API 已按实际任务建立；后续模块随实际需求加入，不预建空实现。用户项目的 `场景/`、`需求/`、`原型代码/` 属于产品运行时管理的业务工程，不混入本研发仓库。

## 开发准备

使用 Node `>=22`、pnpm `11.x` 和 Git，不限制开发工具的补丁版本。根 `package.json` 的 `engines` 声明准入范围，`.node-version` 的 `22` 仅作版本管理器默认选择；依赖仍由根锁文件固定。pnpm workspace 仅匹配 `apps/*`、`packages/*`，不安装嵌套模板的依赖。模板依赖在模板自己的目录和锁文件下单独维护，不能将工具 workspace 检查当作模板或发行验收。

Linux 工作站预先安装 Bash、Git、满足上述范围的 Node/pnpm 和标准 `tar`，并准备 GitHub SSH 授权、HTTPS 网络访问及可创建真实符号链接的工作目录，然后执行：

```sh
git clone git@github.com:paulfrom/eadp-studio.git
cd eadp-studio
bash scripts/setup-linux.sh
```

[setup-linux.sh](scripts/setup-linux.sh) 从根 `package.json` 读取 Node/pnpm 准入范围，依次检查仓库、冻结安装根 workspace 依赖、获取并完整解包固定 DSH 源码。仅准备校验归档时使用 `bash scripts/setup-linux.sh --archive-only`；参数说明见 `--help`。脚本不安装系统工具、模板或 DSH 依赖。后续执行 DSH 构建时，另按固定上游自身的工具契约准备；工作台开发准入与上游要求分别核验。

Windows 工作站使用现有 Node 入口：

```powershell
git clone git@github.com:paulfrom/eadp-studio.git
cd eadp-studio
node scripts/check-repository.mjs
pnpm install --frozen-lockfile --ignore-scripts
node scripts/fetch-dsh.mjs --archive-only
```

满足源码解包权限后，运行 `node scripts/fetch-dsh.mjs` 准备完整 DSH 工作副本。Windows 需要真实符号链接创建能力；当前工作站此项失败，已校验的归档保留在 `.local/`，不发布不完整源码。Linux 原生完整准备与运行仍待实际验证，准备入口不代表 G0 或桌面发行验收通过。

环境准备及换机步骤见 [setup.md](docs/development/setup.md)。后续开发从 [G0 编码启动](dsh_eadp_studio_plan/08-G0编码启动.md) 继续。
