# Studio plugin

本包承载 DSH Host/client 插件。当前已导入 `assets/prototype-template/` 源码快照、具体 `AGENT.md` 及同级文件清单；规则加载与执行保护仍待验证。

## 入口

| 半边 | 源 | 产物 | 说明 |
| --- | --- | --- | --- |
| Host | `src/host/index.ts` | `lib/index.js` | 官方 Host 插件入口；最小切片暂为空 `apply` |
| client | `src/client/index.ts`、`src/client/StudioPanel.tsx` | `lib/client.js` | 注册满窗 `main` 槽位面板并选中 |

`package.json` 声明 `dsh.client.platform = 'web'` 与 `exports["./client"]`，由上游 `ctx.clientModules` 扫描并注入启动图。业务模块后续按 `06-代码架构` 落在 `src/host/application/`、`src/host/adapters/` 与 `src/client/features/`。

## 构建

本包不在产品根 workspace 直接构建：client bundle 必须复用固定上游 `packages/client/tsdown.client.ts` 预设，该预设依赖上游仓库内模块。装配方式、目标位置和依赖注入见 [`build/README.md`](build/README.md) 与 `apps/desktop-distribution/build/`。

模板保留自己的依赖、锁定和运行规则，不作为根 workspace 子包安装。生成的用户业务原型不放入本包。

## Studio 外壳样式

`src/client/studio/StudioPanel.tsx` 导入的 `../studio.tw.generated.css` 是构建产物（gitignored）：由 `@tailwindcss/cli` 从 `src/client/studio.tw.css`（拆分导入、无 preflight、无前缀）预编译生成。装配脚本 `apps/desktop-distribution/build/prepare-studio-plugin.mjs` 在复制插件源码前自动生成；手工改动外壳工具类后需重新运行装配。
