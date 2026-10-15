# G0-3 模板编码交接

2026-10-15 已完成模板与 Host 原型模块编码；Windows 原生、目标 DSH 规则加载与最终发行验收待用户执行。此文不将 Linux 工程检查记为 G0 通过。

## 已实现

- 模板版本 `eadp-prototype@1.0.0-g0.3`，保留企业 React 18 / Umi 4 / SUID 2.1.62、locale、hash 路由；删除真实认证、网关代理、qiankun、旧 PWA/Service Worker 及专属登录实现。
- Node 22.22.3 / pnpm 11.28.5，独立 workspace 和完整 lock。pnpm 11 的 registry 在 `.npmrc`，其余配置在 `pnpm-workspace.yaml`，通过 `allowBuilds` 明确允许 esbuild，明确跳过只提供安装提示的依赖脚本。
- 不使用 `--ignore-workspace`：实际验证其会忽略本地 workspace 的 overrides/allowBuilds。嵌套 workspace 本身隔离工作台根工程。
- 生成任务只写 manifest 的业务区域；保护区包含规则、依赖、执行命令、应用根、初始化、网络护栏和预览服务器。随包复制只使用完整 manifest allowlist，校验实际文件和 SHA-256，不覆盖已有目标目录。
- 浏览器在 bundle 之前安装不可替换的网络护栏；静态 CSP `connect-src 'none'` 同时约束真实连接。Mock 只有浏览器内存，无主应用/后端服务依赖；未 ready 与未知 method/path 均拒绝。
- `window.__EADP_MOCK__` 为冻结且不可替换的只读状态对象，`verify()` 返回 `{ready, unknownRejected}`，供 Host 对真实静态页面验证。
- 示例包含正常/空列表、加载、请求错误、详情编辑、取消、保存失败和重置。Money/MoneyInput 的 props 已直接核对企业 2.1.62 发布包类型与实现。
- 独立 typecheck、script/style lint、静态 build、动态端口 loopback preview。预览实例 ID 防止 ready 误认旧服务；检查记录绑定源码 SHA、输入 hash、产物 hash、需求、资产、会话、规则 hash 和模板版本。

## Host 接口

`packages/studio-plugin/src/host/prototype/`：

- `template.ts`：`verifyTemplate`、`copyTemplate`、`verifyPrototypeContract`、`prototypeInputHash`、`readTemplateManifest`。
- `generation.ts`：`loadPrototypeRules`、`assertRuleBinding`、`assertWritablePrototypePaths`。
- `checks.ts`：`installPrototypeDependencies`、`runPrototypeChecks`、`assertCurrentPrototypeChecks`。
- `preview.ts`：`startPrototypePreview`，返回 URL、固定引用、受管进程和 stop。

任务输入为 `{prototypeRoot, manifestPath, assetId, requirementId, sessionId, sourceSha}`。规则 loader 必须通过真实 DSH 入口返回相同 sessionId/sha256 和明确 entrypoint；不把文件存在或模型口头回复视为回执。缺失、不符或版本变化时 fail closed。绑定与检查结果由调用方写入任务现场；不会写进原型正式源码。

`manifest.contract.writablePrefixes` 中末尾 `/` 的是目录前缀，其余是精确文件，注册平台执行 scope 时分别传 writablePrefixes/writablePaths；protectedPaths 优先。普通任务不能凭保护文件校验自行获得额外权限。

## 实际最小检查

Linux、Node 22.22.3、pnpm 11.28.5 已完成：

1. 企业 registry 实际依赖安装与冻结安装。
2. 独立 typecheck、script/style lint、静态 build。
3. 新 Host 原型模块与平台 runtime 联合 strict TypeScript 检查。
4. loopback 静态 ready endpoint、headless Chrome 静态首屏渲染两条合成样例。
5. 最小模块检查证实 Mock 未 ready、未知路径拒绝；网络护栏拒绝 fetch、XHR、WebSocket、EventSource、Worker、SharedWorker、beacon、原生表单提交。

没有添加测试套件或运行大规模回归。Chrome MCP 因无 X server 未启动，静态首屏使用系统 headless Chrome；该证据不能替代 Windows Electron 验收。规则加载与浏览器强制隔离由主 Host 装配实现，此分支不虚构目标 DSH 已加载记录。

## Windows 待验

在实际复制的 `原型代码/` 执行：

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run preview -- --port 4173
```

验证最终桌面内置 Node/pnpm 的实际路径与版本、DSH 官方会话规则回执、保护区域拒写、安装/检查/预览取消后进程树退出。静态页面验证正常与错误交互、`__EADP_MOCK__.verify()`、未就绪/未知请求/组件副作用和绕过网络拒绝；验证静态站点子路径下资源与 hash 路由。使用新输入或修改 dist 后应拒绝旧检查证据。

模板有修改时，维护同级 manifest 的完整清单、每文件 hash、保护区与版本，先 `git add` 后执行根 `pnpm run check:repository`。依赖、dist、Umi 输出、凭证和完整 AI 过程不入 Git。
