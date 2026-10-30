# 上游缺失接口与现有绕过方式

本页登记本项目无法通过官方接口实现的集成点，以及当前在受维护发行装配里的绕过方式。**新增绕过必须先登记**；未登记的绕过视为违规，见 AGENTS.md「增强边界」。

每条记录包含：现绕过方式所在位置 → 缺少的官方接口。绕过实现都在 `apps/desktop-distribution/build/` 的锚定编辑或产品源码中，不使用 `.local/upstream` 缓存或 `.local/build` 装配树的手工修改。

## 1. 发行方默认 bundle

现改 `apps/desktop/src/project-manager.ts` 的 `WEB_PROFILE.bundles` 常量（`PROFILE_TEMPLATES.web`）与 `apps/cli/package.json` 依赖；恢复清理 `sanitizeProfile(..., WEB_PROFILE.bundles)` 会剥离未列入常量的 bundle。
缺：发行方可声明的默认 bundle 白名单扩展点（配置或 manifest 字段）。

## 2. 传输策略 origin

现改 `desktop-policy-environment.mjs` 与两个上游测试允许 HTTP。
缺：发行方可配置允许的 origin／scheme（或固定后端 HTTPS 化后即可回归）。

`desktop-policy-edits.mjs` 同时调整强制更新初始化：先注册策略 IPC，再创建主窗口并同步策略 UI；主窗口仅在配置策略时通过 `additionalArguments` 向 preload 传递启用标志，Windows preload 据此安装更新遮罩，避免无策略开发模式调用不存在的 handler。
缺：官方对可选强制更新策略的 preload 能力声明及 IPC 就绪启动契约。

## 3. 面板级设置入口

现以 `eadp:open-settings` CustomEvent 桥接 `ui-settings-general`。
缺：面板／插件打开宿主设置对话框的官方服务或 slot。

## 4. 秘密存储 IPC

现于 `host-process.ts`／preload 内联 `studio-secret-store` 通道。
缺：插件可用的凭据存储官方服务。

## 5. 浏览器视图承载

现以 `studio-prototype-view.ts`（`WebContentsView`）加 preload 桥承载原型编辑。
该桥的 layout 请求同时承载刷新与站内路由导航；导航仍绑定 Host 注册并选定的预览身份，只允许该 loopback origin。
缺：插件在受控沙箱中承载第三方视图的官方能力。

## 6. 运行时资源准备

现于 `prepare-runtime` 增加 studio-tools 准备步骤。
缺：发行方附加运行时资源的官方装配步骤。

## 7. `agent/pre-step` 载荷

现于 core agent 事件载荷增加 `assembly` 以支持模型切换提示去重。
缺：官方事件载荷扩展或提示归属 API。

## 8. 构建脚本 Windows／大仓适配

现改 `packaging` scope、commit hash、并发与 tar basename、typert `analyzeInBatches`。
缺：上游构建脚本对 Windows 盘符／大仓规模的官方支持。

## 9. 按项目指定原生会话存储位置

`SessionCommandController.create` 仅接收 `cwd`／workspace 身份，`JsonlSessionPersistence` 的 `Config.root` 是全局根，持久化接口没有逐项目存储路由或日志重定位能力。当前保持官方全局日志目录，不手工搬动会话文件，不新增绕过。
缺：可由可信 Host 按项目配置的会话存储路由，以及可核对完成结果的导出／重定位接口。在此能力具备并验证前，项目文件夹包含业务文件与插件过程数据，但不能宣称包含全部原生对话历史。目录设计见 `docs/design/project-workspace.md`。
