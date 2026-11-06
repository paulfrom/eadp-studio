# 本地业务原型模板

独立 React / Umi / SUID 工程，使用浏览器内存业务 Mock，不依赖登录服务或业务后台。刷新恢复样例数据。页面服务通过 `src/mock/runtime.ts` 调用精确的本地 handler，未知 method/path 拒绝。

使用 Node 22.22.3、pnpm 11.28.5。工作台创建项目后，用户分别点击“安装依赖”和“运行”；安装执行 `pnpm install --frozen-lockfile`，运行固定执行 `pnpm run start`（`umi dev --host 127.0.0.1`）。Host 分配端口，页面由系统浏览器打开。

维护者可在本目录执行既有静态检查：`pnpm run typecheck`、`pnpm run lint`、`pnpm run build`。类型检查先执行 `umi setup` 生成 `src/.umi/`；`dist/` 是构建产物，不随模板复制。依赖、锁文件与运行时版本固定，不共享工作台根依赖。

示例页 `/#/demo` 包含正常/空列表、请求错误、加载、详情编辑、取消、保存失败、重置。路由只在 `config/routes.json` 中声明；加载器验证字段、外部重定向、重复路径和页面目录外的组件。组件使用 `./PageName`（指向 `src/pages/`），嵌套路径使用绝对路由；整体布局固定在 `config/config.ts`。

构建资源围栏保留对模块、上下文目录、静态资源和 loader 的工程内真实路径检查，以及敏感文件与源文件内联 loader 限制；Less 不启用 JavaScript 或插件指令。该边界不构成完整操作系统沙箱。

生成规则见 `AGENT.md`。维护来源为 `packages/eadp-prototype/assets/prototype-template/`，完整文件校验值由其旁的 `prototype-template.manifest.json` 固定；用户工程是运行时复制所得的独立工程。

当前版本未完成依赖安装、类型检查、lint、构建或真实桌面运行验收。Umi 启动与端口就绪、系统浏览器打开、停止进程树、失败恢复及 Windows 行为均未验证；静态检查通过也不能证明上述行为或生产就绪。
