# G0-1 最小切片交接

日期：2026-10-14。范围：对接 G0-1 基线、准备上游依赖与构建、采集真实接口清单。尚未实现插件或桌面发行装配代码。

## 目标

按 [G0-1](../../../dsh_eadp_studio_plan/G0-1-最小插件与接口清单.md) 建立内置最小 Host/client 插件的定制桌面发行验证件，复用固定上游 `d743267388641bc76f17c45ce8b4c231aed1d32c` 的真实构建管线，不虚构 DSH API、不新造 Electron 壳或 Agent loop。

## 已完成（本机 Linux）

- 对接并集成 `f762702`（工具准入范围调整）到 `main`，对应提交 `6030bad`；两个任务分支从同一基线分叉，各一个 writer。
- 重建 worktree：`.local/worktrees/g0-plugin`（`feat/g0-1-plugin`）、`.local/worktrees/g0-desktop`（`feat/g0-1-desktop-assembly`），均在 `6030bad`，`check:repository` 通过。
- 源码就绪证据入 `release.lock.json`（平台化）与 [单仓库开发准备交接](repository-setup.md)。
- 上游依赖与构建按上游契约准备，见下表。
- 产出 [G0-1 真实接口清单](../g0-1-interface-inventory.md)：面板、通信、会话、事件、审批、取消、恢复的固定 SHA/路径/symbol/限制，未知项显式标注。

## 验证环境与结果（Linux）

| 项 | 值 |
| --- | --- |
| Node / pnpm | `v22.22.3` / `11.28.5`（满足上游 `^22.19.0 \|\| >=24`、`pnpm@11.28.5`） |
| 依赖安装 | `.local/upstream/dsh` 内 `pnpm install --frozen-lockfile`，退出 0，`node_modules` 约 2.1G |
| 上游构建 | `pnpm run build` 退出 0：`native/system/packages/linux-x64/bin/glibc/system.node`、`build:lib`（host+client）、`build:web`（357 个 client artifact） |
| 桌面构建 | `pnpm run build:desktop` 退出 0，产物 `apps/desktop/lib/` |
| 关键校验值 | `system.node` `d7cb1782…707e7`；`apps/desktop/lib/main.js` `9360edbf…6acba`；`apps/web/dist/index.html` `414155b3…87200` |
| 日志 | `.local/logs/dsh-install.log`、`.local/logs/dsh-build.log` |

这些是 Linux 构建/检查结果，不替代 Windows 原生验收。

## 未完成与阻塞

- 未实现最小 Host/client 插件与桌面发行装配入口：Studio 插件进入核心包集还是 profile 补丁层、如何默认启用并成为满窗主面板，均待实现和实测。
- `apps/desktop/scripts/package-target.ts` 只支持 `mac-arm64`/`mac-x64`/`win-x64`，且 `win-x64` 要求 Windows x64 构建主机；Linux 不能产出 Windows 安装包。
- Windows 侧完整源码准备仍受符号链接阻塞（见 `release.lock.json` 的 `sourceExtractionBlockers.windows`），安装/签名/首启/升级/卸载/共存全部未验证。
- 未执行 DeepSeek `deepseek-flash` 真实会话用例：输入、事件、审批、取消、重启恢复均未实测。
- 未安装模板依赖、未验证模板规则加载与静态 Mock（属 G0-3）。

## 下一步

1. 在 `g0-plugin` 落地最小 Host/client 插件（面板、会话输入、事件、审批、取消、恢复验证所需调用），只做切片必要内容。
2. 在 `g0-desktop` 落实内置默认启用与发行装配入口，复用上游 `cordis.patch.yml` 与 electron-builder 管线；共享接口冻结后再并行。
3. 回填接口清单中标注「未验证」的项，并补 Linux 运行与 Windows 原生分开的证据。
4. 同一任务分支、同一时间仅一台工作站写入；交接时更新本文件并推送 WIP 提交。
