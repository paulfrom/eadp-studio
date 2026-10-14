# 单仓库开发准备交接

日期：2026-10-14。范围：落实已确认的源码位置和 Windows/Linux 开发同步，不实施完整 G0 插件或业务能力。

## 已完成

- 原目录无 Git 元数据；用户指定远程经只读检查无任何引用。初始化 `main`，登记 `origin` 为 `git@github.com:paulfrom/eadp-studio.git`。
- 保留既有产品规划、领域定义及 ADR；建立根 workspace、换行/编码约定、开发规则及交接文档。
- 根锁文件由 pnpm `11.28.5` 生成；同版本离线 `--frozen-lockfile --ignore-scripts` 安装通过，仅包含三个无业务依赖的 workspace 工程，不安装模板或 DSH 依赖。使用仓库内忽略的 npm/pnpm 缓存，系统 pnpm 未改变。
- 从干净的 `sei-blank-ts-app-2.0` 提交 `53a59662cb405533f672c209f532124c63464b39` 导入 59 个受管文件，排除原始 `.env`，增加 README 与无值 `.env.example`。61 个文件哈希对照一致；文本归一化为 UTF-8 无 BOM/LF，二进制原字节保留。
- DSH 固定归档：`d743267388641bc76f17c45ce8b4c231aed1d32c`，归档 SHA-256 `414db357dda081d11d531ea3e9969f48fa0502809ff579396c3c2bbf7e109253`。实际源码要求 Node `^22.19.0 || >=24.0.0`、pnpm `11.28.5`。完整源码只在获取校验及解包成功后发布到 `.local/upstream/dsh/`。

## 验证边界及阻塞

- 当前 Windows Node 实测为 `22.22.0`；系统 pnpm 为 `11.5.1`，根版本约定为 `11.28.5`。
- Windows 文件符号链接创建返回 `EPERM`，tar 对真实链接创建报错，完整 DSH 工作副本尚未就绪；归档校验与源码就绪分开，不能称桌面准备通过。
- Linux 实机、模板安装/构建、静态 Mock、规则加载、DSH SDK/插件运行、协同服务及安装包均未验证。
- 模板快照缺少依赖锁文件和 `AGENT.md`，manifest 中 `releaseReady` 为 false。

## 下一步

1. 在具备真实符号链接权限的环境运行源码获取脚本，核验完整工作副本。Linux 和 Windows 各自准备，不复制缓存冒充复现。
2. 按 G0-1 固定源码实际接口建立最小 Host/client 切片及发行装配；不虚构 SDK 入口。
3. 按 G0-3 维护随包模板的独立锁定、规则、合成 Mock 和负向验收。
4. 用同一任务分支和执行交接文档接续开发；本准备提交不作为 G0 通过或业务确认依据。
