# EADP Studio

人与 AI Agent 协作整理业务材料和演示成果的桌面工作台。

## 当前实现

- `packages/studio-plugin/`：DSH Host/client 插件。Host 通过 Typert Remote 暴露 Studio 命令服务；client 注册满窗工作台面板，覆盖登录、项目、场景/需求/交接材料、AI 辅助评审、原型认领/检查/预览/确认、复用资格与采用、交接回执、发布/撤回和主题设置。
- `apps/collaboration-api/`：Fastify + PostgreSQL 协同后端。实现协同会话、GitLab 账号绑定与成员权限校验、项目建仓/初始化、固定 Git 正文读取校验、持久占用、集成、复用记录、发布授权和桌面更新检查。
- `packages/asset-domain/`、`packages/contracts/`：资产领域模型与跨端契约。
- `packages/studio-plugin/assets/prototype-template/`：React / Umi / SUID 合成 Mock 原型模板，带路由校验、资源围栏和模板清单。
- `apps/desktop-distribution/`：固定 DSH 版本、装配 Studio 插件和模板、生成 Windows 未签名安装包。

## 文件位置

| 路径 | 内容 |
| --- | --- |
| `packages/studio-plugin/` | Studio Host/client 插件源码、随包模板及其构建输入 |
| `apps/collaboration-api/` | 协同登录、GitLab 绑定、建仓初始化及持久协同 API |
| `packages/asset-domain/` | 场景、需求、原型、交接和复用领域模型 |
| `packages/contracts/` | API 与客户端共享的 TypeBox 契约 |
| `apps/desktop-distribution/` | 固定上游版本、发行装配脚本和发布锁 |
| `scripts/` | 仓库校验、DSH 获取、桌面开发与打包入口 |
| `CONTEXT.md` | 架构决策及领域定义 |
|                              |                                                   |

用户项目中的 `场景/`、`需求/`、`原型代码/` 属于产品运行时管理的业务工程，不混入本研发仓库。

## 开发准备

使用 Node `>=22`、pnpm `11.x` 和 Git，不限制开发工具的补丁版本。根 `package.json` 的 `engines` 声明准入范围，`.node-version` 的 `22` 仅作版本管理器默认选择；依赖仍由根锁文件固定。pnpm workspace 仅匹配 `apps/*`、`packages/*`，不安装嵌套模板的依赖。模板依赖在模板自己的目录和锁文件下单独维护，不能将工具 workspace 检查当作模板或发行验收。

Linux 工作站预先安装 Bash、Git、满足上述范围的 Node/pnpm 和标准 `tar`，并准备 GitHub SSH 授权、HTTPS 网络访问及可创建真实符号链接的工作目录，然后执行：

```sh
git clone git@github.com:paulfrom/eadp-studio.git
cd eadp-studio
bash scripts/setup-linux.sh
```

`setup-linux.sh` 从根 `package.json` 读取 Node/pnpm 准入范围，依次检查仓库、冻结安装根 workspace 依赖、获取并完整解包固定 DSH 源码。仅准备校验归档时使用 `bash scripts/setup-linux.sh --archive-only`；参数说明见 `--help`。脚本不安装系统工具、模板或 DSH 依赖。后续执行 DSH 构建时，另按固定上游自身的工具契约准备。

Windows 工作站使用现有 Node 入口：

```powershell
git clone git@github.com:paulfrom/eadp-studio.git
cd eadp-studio
node scripts/check-repository.mjs
pnpm install --frozen-lockfile --ignore-scripts
node scripts/fetch-dsh.mjs --archive-only
```

满足源码解包权限后，运行 `node scripts/fetch-dsh.mjs` 准备完整 DSH 工作副本。Windows 需要真实符号链接创建能力。

## 本地桌面开发与调试

在原生 Windows x64 工作站的仓库根目录执行：

```powershell
pnpm dev:desktop
```

需要 Node `^22.19.0 || >=24.0.0`、pnpm `11.x`、Git、tar、真实符号链接创建权限及首次下载网络。该命令按需安装依赖、校验固定 DSH 源码、装配当前 Studio 和模板、构建并准备开发运行环境，随后启动上游 Electron 开发入口；首次执行会下载和构建较多内容。

后续仍执行同一条命令。输入、依赖和实际装配内容未变且构建产物校验通过时，复用已有准备与构建；源码修改、删除、模板更新或其他 worktree 改写共享构建树后，会先重新装配和构建。当前不监听源码变化：修改后退出本轮调试，再运行 `pnpm dev:desktop`。产品源码在本仓库维护，`.local/build/dsh` 是可重新生成的构建副本。

默认打开 DevTools；主进程、Renderer 和插件 Host 调试端口分别为 `9229`、`9222`、`9230`。开发数据与 Electron 配置位于 `.local/build/dsh/apps/desktop/.desktop-build/development/`，与安装版 `%USERPROFILE%\.eadp-studio` 隔离。退出应用或按 `Ctrl+C` 结束调试后，入口释放共享构建锁；调试期间不能同时打包或从另一 worktree 启动同一构建树。

`pnpm dev:desktop --prepare` 执行相同的源码准备、构建及运行环境检查，不打开 Electron；`pnpm dev:desktop --help` 查看说明。准备或构建失败时不会启动桌面。强制杀进程或机器断电留下的 `.local/build/.studio-desktop-build.lock`，会在下次启动时根据持有者的 PID 和进程启动时间自动回收；仍在运行的会话继续互斥。若进程树清理失败，锁会保留，须先检查相关进程再人工清理。

## 从源码生成桌面安装包

在 Windows x64 工作站的仓库根目录执行：

```powershell
./build-desktop.ps1
```

也可使用 `pnpm run build:desktop` 或 `node scripts/build-desktop.mjs`。该入口安装本仓库依赖、获取并校验固定 DSH 源码、装配当前 Studio 源码及模板、构建插件和随包运行环境，再调用上游 Electron/NSIS 管线生成可安装文件。应用显示名、可执行文件和快捷方式名称为 `eadp studio`；安装包输出到 `artifacts/windows/eadp-studio.exe`，同时输出绝对路径、SHA256 和同名 `.json` 记录。

构建要求原生 Windows x64、Node `^22.19.0 || >=24.0.0`、pnpm `11.x`、Git、tar、Visual Studio C++ Build Tools 与 Windows SDK、真实符号链接权限，以及源码/依赖/运行时下载网络。首次运行自动从受维护的无凭证配置创建构建树中的 `.env.windows`；已有文件保留，产品标识冲突或配置不完整会明确报错。`./build-desktop.ps1 --check` 检查主机、装配源码、安装构建依赖并执行上游打包前置校验；`--help` 查看参数。入口不修改校验过的上游源码缓存，也无需手工设置插件打包环境变量。

Electron-builder 工具缓存固定在主 checkout 的 `.local/cache/electron-builder`，由入口创建并通过其官方 `ELECTRON_BUILDER_CACHE` 变量传给打包进程，避免其他应用留下的全局缓存状态干扰本仓库构建。

当前入口生成未签名的开发安装包；签名、升级发布及干净机发行验收仍遵循独立门槛。产品使用稳定 App ID `io.github.paulfrom.eadp.studio`、`eadp-studio://` 协议和 `%USERPROFILE%\.eadp-studio` 数据根，Electron 数据位于 `%APPDATA%\eadp studio`。旧 DSH 数据不迁移。配置及验证细节见 [桌面构建说明](apps/desktop-distribution/build/README.md)。
