# Studio plugin

本包承载 DSH Host/client 插件，以及随包的原型模板快照。

## 入口

| 半边 | 源 | 产物 | 说明 |
| --- | --- | --- | --- |
| Host | `src/host/index.ts` | `lib/index.js` | 注册 `studio` Typert Remote 服务，注册为 Agent 工具以外的工作台入口 |
| client | `src/client/index.ts`、`src/client/studio/StudioPanel.tsx` | `lib/client.js` | 注册满窗 `main` 槽位面板并选中，注入会话保留与主题能力 |

`package.json` 声明 `dsh.client.platform = 'web'` 与 `exports["./client"]`，由上游 `ctx.clientModules` 扫描并注入启动图。

## 已实现范围

- 工作台命令：登录/退出、项目列表/创建/打开/初始化重试、分类、场景/需求/交接材料、AI 辅助评审、原型协作任务与开发占用/检查/预览/确认、复用资格与采用、交接回执、发布/撤回。
- Host 适配：本地原子状态、需求工作树与 Git、协同 API 客户端、DSH 会话、执行范围保护、模板生成与校验、预览和发布。
- 随包模板：`assets/prototype-template/` 源码快照、`AGENT.md` 规则契约及同级文件清单；模板依赖、锁定和运行规则独立维护。
- 构建输入与装配方式见 [`build/README.md`](build/README.md) 和 `apps/desktop-distribution/build/`。

## Studio 外壳样式

`src/client/studio/StudioPanel.tsx` 导入的 `../studio.tw.generated.css` 是构建产物（gitignored）：由 `@tailwindcss/cli` 从 `src/client/studio.tw.css`（拆分导入、无 preflight、无前缀）预编译生成。装配脚本 `apps/desktop-distribution/build/prepare-studio-plugin.mjs` 在复制插件源码前自动生成；手工改动外壳工具类后需重新运行装配。
