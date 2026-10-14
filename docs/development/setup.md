# 两工作站开发与交接

## 共享范围

Windows 和 Linux 各自 clone 同一个 GitHub 仓库。所有源码与必要配置均来自 Git；路径使用仓库相对路径。开发 Node 固定为 `22.22.0`，pnpm 固定为 `11.28.5`；`.node-version`、`package.json` 和根锁文件共同维护。

```sh
git clone git@github.com:paulfrom/eadp-studio.git
cd eadp-studio
pnpm install --frozen-lockfile --ignore-scripts
node scripts/check-repository.mjs
node scripts/fetch-dsh.mjs --archive-only
node scripts/fetch-dsh.mjs
```

使用前需安装指定版本的 Node/pnpm；当前工作站系统 pnpm 是 `11.5.1`，不能视为已切换。仓库准备校验脚本仅使用 Node 内置 API，无需先安装模板依赖。`fetch-dsh` 需要 HTTPS 网络访问及标准 `tar`；归档获取、哈希校验成功与完整源码就绪分别报告，默认解包失败不会切换其它来源。

当前 Windows 对真实文件符号链接创建返回 `EPERM`，tar 对归档链接创建失败。维护者须在具备符号链接权限的环境准备源码；本项目脚本不修改系统开发者模式、安全策略或将链接转换为普通文件。Linux 尚未实测。源准备成功也不表示桌面构建、插件接入、签名或安装通过。

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
