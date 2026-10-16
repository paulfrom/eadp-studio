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

满足源码解包权限后，运行 `node scripts/fetch-dsh.mjs` 准备完整 DSH 工作副本。Windows 需要真实符号链接创建能力；当前开发机已验证完整解包。Linux 原生完整准备与运行仍待实际验证，准备入口不代表 G0 或桌面发行验收通过。

## 从源码生成桌面安装包

在 Windows x64 工作站的仓库根目录执行：

```powershell
./build-desktop.ps1
```

也可使用 `pnpm run build:desktop` 或 `node scripts/build-desktop.mjs`。该入口安装本仓库依赖、获取并校验固定 DSH 源码、装配当前 Studio 源码及模板、构建插件和随包运行环境，再调用上游 Electron/NSIS 管线生成可安装文件。应用显示名、可执行文件和快捷方式名称为 `eadp studio`；安装包输出到 `artifacts/windows/eadp-studio-<版本>-win-x64-unsigned.exe`，同时输出绝对路径、SHA256 和同名 `.json` 记录。

构建要求原生 Windows x64、Node `^22.19.0 || >=24.0.0`、pnpm `11.x`、Git、tar、Visual Studio C++ Build Tools 与 Windows SDK、真实符号链接权限，以及源码/依赖/运行时下载网络。首次运行自动从受维护的无凭证配置创建构建树中的 `.env.windows`；已有文件保留，产品标识冲突或配置不完整会明确报错。`./build-desktop.ps1 --check` 检查主机、装配源码、安装构建依赖并执行上游打包前置校验；`--help` 查看参数。入口不修改校验过的上游源码缓存，也无需手工设置插件打包环境变量。

当前入口生成未签名的开发安装包；签名、升级发布及干净机发行验收仍遵循独立门槛。产品使用稳定 App ID `io.github.paulfrom.eadp.studio`、`eadp-studio://` 协议和 `%USERPROFILE%\.eadp-studio` 数据根，Electron 数据位于 `%APPDATA%\eadp studio`。旧 DSH 数据不迁移。配置及验证细节见 [桌面构建说明](apps/desktop-distribution/build/README.md)。

环境准备及换机步骤见 [setup.md](docs/development/setup.md)。后续开发从 [G0 编码启动](dsh_eadp_studio_plan/08-G0编码启动.md) 继续。
