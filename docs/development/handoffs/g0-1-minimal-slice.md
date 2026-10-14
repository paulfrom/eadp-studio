# G0-1 最小切片交接

日期：2026-10-14。范围：对接 G0-1 基线、准备上游依赖与构建、采集真实接口清单、落地最小 Host/client 插件与装配入口。尚未在真实桌面运行验证，也未完成安装包装配。

## 目标

按 [G0-1](../../../dsh_eadp_studio_plan/G0-1-最小插件与接口清单.md) 建立内置最小 Host/client 插件的定制桌面发行验证件，复用固定上游 `d743267388641bc76f17c45ce8b4c231aed1d32c` 的真实构建管线，不虚构 DSH API、不新造 Electron 壳或 Agent loop。

## 已完成（本机 Linux）

- 对接并集成 `f762702`（工具准入范围调整）到 `main`，对应提交 `6030bad`；两个任务分支从同一基线分叉，各一个 writer。
- 重建 worktree：`.local/worktrees/g0-plugin`（`feat/g0-1-plugin`）、`.local/worktrees/g0-desktop`（`feat/g0-1-desktop-assembly`），均在 `6030bad`，`check:repository` 通过。
- 源码就绪证据入 `release.lock.json`（平台化）与 [单仓库开发准备交接](repository-setup.md)。
- 上游依赖与构建按上游契约准备，见下表。
- 产出 [G0-1 真实接口清单](../g0-1-interface-inventory.md)：面板、通信、会话、事件、审批、取消、恢复的固定 SHA/路径/symbol/限制，未知项显式标注。
- 落地最小 Host/client 插件：`packages/studio-plugin/src/host/index.ts`、`src/client/index.ts`、`src/client/StudioPanel.tsx`，`package.json` 声明 `dsh.client` 与 `exports[./client]`；client 半边注册满窗 `main` 槽位并 `ctx.layout.selectPanel`。
- 落地装配入口：`apps/desktop-distribution/build/prepare-studio-plugin.mjs`，从已校验源码建立构建树、把插件放到固定位置 `packages/eadp/studio-plugin`、注入上游 workspace 依赖、补 `tsconfig.client.json` 引用，再跑上游 `build:lib:client`。已验证可重复执行。

## 验证环境与结果（Linux）

| 项 | 值 |
| --- | --- |
| Node / pnpm | `v22.22.3` / `11.28.5`（满足上游 `^22.19.0 \|\| >=24`、`pnpm@11.28.5`） |
| 依赖安装 | `.local/upstream/dsh` 内 `pnpm install --frozen-lockfile`，退出 0，`node_modules` 约 2.1G |
| 上游构建 | `pnpm run build` 退出 0：`native/system/packages/linux-x64/bin/glibc/system.node`、`build:lib`（host+client）、`build:web`（357 个 client artifact） |
| 桌面构建 | `pnpm run build:desktop` 退出 0，产物 `apps/desktop/lib/` |
| 关键校验值 | `system.node` `d7cb1782…707e7`；`apps/desktop/lib/main.js` `9360edbf…6acba`；`apps/web/dist/index.html` `414155b3…87200` |
| 日志 | `.local/logs/dsh-install.log`、`.local/logs/dsh-build.log`、`.local/logs/assemble-plugin.log` |

插件装配（构建树 `.local/build/dsh`，不修改已校验源码）：

| 项 | 值 |
| --- | --- |
| 装配命令 | `node apps/desktop-distribution/build/prepare-studio-plugin.mjs`，退出 0 |
| Host 产物 | `packages/eadp/studio-plugin/lib/index.js`，`sha256 01e3d280…41c489`，ESM `export { apply }` |
| client 产物 | `packages/eadp/studio-plugin/lib/client.js`，`sha256 9eceeba9…b2b4d2`，`window.__ModuleLoader__.load({ id: '@eadp-studio/studio-plugin', … })`，`react/jsx-runtime` 为外部依赖 |
| 构建边界 | client bundle 必须复用固定上游 `packages/client/tsdown.client.ts` 预设（依赖上游仓库内模块），不能在产品 workspace 单独构建 |

两次独立运行（手工试验与脚本运行）产出相同 SHA256。装配脚本以 `CI=true` 运行上游安装，避免上游 lefthook postinstall 向外层产品仓库写入 git hook；本轮已清理一次误写入的 `.git/hooks/prepare-commit-msg`（非 Git 受管内容）。

这些是 Linux 构建/检查结果，不替代 Windows 原生验收。

## 未完成与阻塞

- 插件已产出两个 bundle，但**尚未默认启用**：进入发行包集/profile 补丁层、成为安装后即满窗 Studio 的默认入口，以及安装包装配均未实现。
- 未在实际定制的 DSH 桌面上运行该插件：会话输入、事件、审批、取消、重启恢复均未实测；`deepseek-flash` 真实调用未执行。
- `apps/desktop/scripts/package-target.ts` 只支持 `mac-arm64`/`mac-x64`/`win-x64`，且 `win-x64` 要求 Windows x64 构建主机；Linux 不能产出 Windows 安装包。
- Windows 侧完整源码准备仍受符号链接阻塞（见 `release.lock.json` 的 `sourceExtractionBlockers.windows`），安装/签名/首启/升级/卸载/共存全部未验证。
- 未执行 DeepSeek `deepseek-flash` 真实会话用例：输入、事件、审批、取消、重启恢复均未实测。
- 未安装模板依赖、未验证模板规则加载与静态 Mock（属 G0-3）。

## 下一步

1. 在 `g0-desktop` 落实插件默认启用：核心包集/`desktop-packages.json` 与 profile `cordis.patch.yml` 行，并用上游桌面构建入口取得可运行切片（Linux 只到构建与装配，`win-x64` 要求 Windows 构建主机）。
2. 在实际定制桌面验证满窗 Studio、会话输入、事件、审批、取消与重启恢复，分列 Linux 与 Windows 结果。
3. 回填接口清单中标注「未验证」的项。
4. 同一任务分支、同一时间仅一台工作站写入；交接时更新本文件并推送 WIP 提交。
