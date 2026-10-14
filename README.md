# EADP Studio

人与 AI Agent 协作整理业务材料和演示成果的桌面工作台。

研发仓库：`git@github.com:paulfrom/eadp-studio.git`。Linux 与 Windows 共享同一源码基线、规划、配置和任务交接；依赖、上游缓存和运行现场各自生成。

## 当前状态

已落实单仓库开发布局、Git 属性、独立模板快照及校验、固定 DSH 归档获取入口。当前尚未实现可运行的工作台插件、协同 API 或 Windows 安装包，不代表 G0 通过。详细范围见 [开发准备交接](docs/development/handoffs/repository-setup.md)。

## 文件位置

| 路径 | 内容 |
| --- | --- |
| `packages/studio-plugin/` | 随包模板；后续 Host/client 插件源码 |
| `apps/desktop-distribution/` | 固定上游版本及发行装配脚本 |
| `.local/upstream/dsh/` | 获取成功后生成的本机 DSH 源码，不提交 |
| `scripts/` | 可实际运行的开发准备与校验脚本 |
| `docs/development/` | 开发环境和任务交接 |
| `docs/adr/`、`CONTEXT.md` | 架构决策及领域定义 |
| `dsh_eadp_studio_plan/` | 产品设计、实施任务与验收要求 |

`asset-domain`、`contracts`、协同 API 和测试模块随实际任务加入，当前不预建空实现。用户项目的 `场景/`、`需求/`、`原型代码/` 属于产品运行时管理的业务工程，不混入本研发仓库。

## 开发准备

使用 Node `22.22.0`、pnpm `11.28.5` 和 Git。pnpm workspace 仅匹配 `apps/*`、`packages/*`，不安装嵌套模板的依赖。当前产品 workspace 无业务依赖；模板缺少自己的锁文件，不能进行冻结安装或发行验收。

```sh
git clone git@github.com:paulfrom/eadp-studio.git
cd eadp-studio
node scripts/check-repository.mjs
node scripts/fetch-dsh.mjs --archive-only
```

满足源码解包权限后，运行 `node scripts/fetch-dsh.mjs` 准备完整 DSH 工作副本。Windows 需要真实符号链接创建能力；当前工作站此项失败，已校验的归档保留在 `.local/`，不发布不完整源码。Linux 的解包和运行仍待实际验证。

环境准备及换机步骤见 [setup.md](docs/development/setup.md)。后续开发从 [G0 编码启动](dsh_eadp_studio_plan/08-G0编码启动.md) 继续。
