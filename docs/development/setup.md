# 两工作站开发与交接

## 共享范围

Windows 和 Linux 各自 clone 同一个 GitHub 仓库。所有源码与必要配置均来自 Git；路径使用仓库相对路径。工作台开发准入为 Node `>=22`、pnpm `11.x`，不限制补丁版本；范围由根 `package.json` 的 `engines.node` 与 `engines.pnpm` 声明，不设置根 `packageManager` 补丁版本 pin。`.node-version` 的 `22` 仅作版本管理器默认选择，依赖版本继续由根锁文件固定。构建和验收记录实际使用的工具版本；DSH 上游与原型模板分别遵守自己的契约。

### Linux 工作站

使用真实 Linux 环境，预先准备 Bash、Git、Node、pnpm 和标准 `tar`。Node/pnpm 的准入范围以根 `package.json` 为准，安装方式参照 [Node.js 官方文档](https://nodejs.org/en/download) 和 [pnpm 官方文档](https://pnpm.io/installation)。准备 GitHub SSH 授权、依赖源和 DSH 归档的 HTTPS 访问，以及可写、可创建真实符号链接的工作目录。脚本不使用 sudo、不安装或切换系统工具，也不修改代理、证书或权限策略。

```sh
git clone git@github.com:paulfrom/eadp-studio.git
cd eadp-studio
bash scripts/setup-linux.sh
```

脚本按自身位置定位仓库，可从其它当前目录调用，路径包含空格时使用引号，例如 `bash "/home/dev/eadp studio/scripts/setup-linux.sh"`。支持 `--help` 和 `--archive-only`，其它参数拒绝执行。

执行顺序固定为：检查 Linux 与工具可用性、Node/pnpm 准入范围 → `node scripts/check-repository.mjs` → `pnpm install --frozen-lockfile --ignore-scripts` → `node scripts/fetch-dsh.mjs`。任一步失败立即停止；仓库检查未通过时不会安装依赖或获取源码。

默认成功后，根 workspace 按锁文件完成安装，已校验归档保存在 `.local/upstream/`，完整 DSH 工作副本位于 `.local/upstream/dsh/`，源码收据为 `.local/upstream/dsh.source.json`。`--archive-only` 仅跳过源码解包，仍检查仓库并安装根 workspace，且不会创建源码收据。已有完整源码不被覆盖；准备脚本不安装模板或 DSH 依赖，也不构建或启动桌面。继续 G0 时按固定上游实际入口准备其依赖和运行，见 [G0 编码启动](../../dsh_eadp_studio_plan/08-G0编码启动.md)。

### Windows 工作站

```powershell
git clone git@github.com:paulfrom/eadp-studio.git
cd eadp-studio
node scripts/check-repository.mjs
pnpm install --frozen-lockfile --ignore-scripts
node scripts/fetch-dsh.mjs --archive-only
node scripts/fetch-dsh.mjs
```

使用前需安装 Node `>=22` 和 pnpm `11.x`；准备阶段实测的 Windows Node `22.22.0`、pnpm `11.5.1` 均满足工作台开发范围。执行固定 DSH 的依赖安装和构建时，仍需另行满足该上游的实际声明，见 [G0 编码启动](../../dsh_eadp_studio_plan/08-G0编码启动.md)。仓库准备校验脚本仅使用 Node 内置 API，无需先安装模板依赖。`fetch-dsh` 需要 HTTPS 网络访问及标准 `tar`；归档获取、哈希校验成功与完整源码就绪分别报告，默认解包失败不会切换其它来源。

当前 Windows 对真实文件符号链接创建返回 `EPERM`，tar 对归档链接创建失败。维护者须在具备符号链接权限的环境准备源码；本项目脚本不修改系统开发者模式、安全策略或将链接转换为普通文件。Linux 原生完整准备尚未实测；受控命令模拟只验证脚本编排。源准备成功也不表示桌面构建、插件接入、签名或安装通过。

根 workspace 不包含原型模板。模板的原始 `.env` 已排除，`.env.example` 只列设置名；现已维护具体 `AGENT.md`，但目标 DSH 加载与执行保护尚未验证，仍缺独立依赖锁定和静态 Mock 验证，继续按 G0-3 补齐后再放行。严禁拷贝 `node_modules`、上游工作副本或构建输出作为另一机器的依赖准备。

## 换机

1. 原机器停止正在修改文件的任务和 Agent，保存编辑器内容。
2. 更新 `docs/development/handoffs/<任务>.md`：目标、已完成、未完成、验证环境/结果、阻塞和下一步。记录已有测试源码 SHA，不记录本次提交自身 SHA。
3. 检查 `git status` 和 diff，显式暂存代码及交接文档，在当前任务分支创建 WIP 提交并推送。推送失败或结果未知时不标记交接成功。
4. 目标机器检查本地未提交和未推送成果，再 `git fetch origin`、切换同一任务分支，使用 `git pull --ff-only` 更新；分叉须明确处理，不强制 reset 或覆盖现场。
5. 分别准备依赖和上游源码，运行实际检查，再继续同一任务。同一任务分支同一时间仅一台工作站写入。

`main` 保存已集成并注明验证范围的基线；任务用 `feat/<任务>` 或 `fix/<问题>`。不建立长期 `windows`、`linux` 分支。源码快照/WIP 提交与业务确认、G0 通过、产品发行分别记录。

## 本机文件

`.local/` 保存下载、上游源码、临时报告和克隆验收现场；`.gitignore` 排除它及依赖、构建产物、环境文件、证书。`build/` 是维护脚本目录，不全局忽略。凭证分别在两台机器授权，不随项目配置同步。完整 AI 会话、提示词和工具日志不加入交接文件。
