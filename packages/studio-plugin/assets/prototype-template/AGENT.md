# 原型工程规则（eadp-prototype 1.0.0-g0.8）

本工程用于已确认需求的合成数据演示。工程根 `AGENT.md` 是唯一规则入口；不创建另一份规则或兼容路径。本文件自包含，不能依赖维护者机器上的目录、外部 skill 或主应用。

## 开工与成果绑定

- Host 必须先校验模板 manifest 中的保护文件，并通过目标 DSH 官方会话入口加载本文件。
- 规则加载回执必须包含相同 sessionId 与本文件 SHA-256，绑定 assetId、requirementId、sourceSha 和模板版本。仅文件存在、模型声称已读、过期回执都不成立。
- 缺失规则、保护文件变化、会话或版本不符时立即阻断生成，不绕过保护配置。
- 使用已确认需求、固定场景依据和当前任务授权范围；核心规则不清楚时保留问题，不生成假业务结论。
- 检查结果绑定当前源码 SHA、全部输入文件 hash 和静态产物 hash；代码变化后不能复用旧检查或旧预览。

## 技术栈与具体命令

- React 18.3.1、TypeScript 5.6.3、Umi 4.6.53、Less，UI 为 `@ead/suid` 2.1.62，图标为 `@ead/suid-icons` 1.2.11。
- Node 22.22.3、pnpm 11.28.5；独立 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml`。不共享工作台根依赖，不混用 npm/yarn，不升级包。
- 先读取已安装同版本组件 `.d.ts`、实现或官方同版本文档，再使用 props；不能从 Ant Design 经验推断企业扩展 API。
- 从工程根执行 `pnpm install --frozen-lockfile`，冻结安装失败须记录真实原因。
- 独立类型检查：`pnpm run typecheck`（`umi setup` 后 `tsc --noEmit`）。
- 独立 lint：`pnpm run lint`。静态构建：`pnpm run build`，输出目录固定 `dist/`。
- `pnpm run check` 按序运行以上三项；失败不修改工程配置来绕过。
- 静态预览：`pnpm run preview -- --port <Host分配端口>`，只绑定 `127.0.0.1`，默认 4173。
- 预览 ready 路径 `/__eadp_preview_ready` 证明静态服务就绪；浏览器 `window.__EADP_MOCK__.ready` 另证明合成数据已初始化，两者不能混淆。
- `pnpm run start` 仅为维护者本地 Umi 开发服务；分享或验收使用静态产物。

## 普通生成可写区域

| 路径 | 可修改内容 |
| --- | --- |
| `src/pages/<PageName>/` | 已授权 TSX/TS 页面、局部 Less、子组件、service.ts、必要 model.ts |
| `src/components/` | 本需求确有调用方的复用组件，不预建通用框架 |
| `src/locales/` | 本次业务中英文文案，保留现有 locale 组织 |
| `src/mock/fixtures.ts`、`src/mock/handlers.ts` | 本需求合成 fixture、精确 method/path handler，不添加透传 |
| `config/routes.json` | 仅明确授权的 JSON 页面路由/标题；固定布局由保护配置维护 |

普通任务不得修改 `AGENT.md`、package/lock、`.npmrc`、`pnpm-workspace.yaml`、tsconfig、lint 配置、`config/config.ts`、`config/load-routes.ts`、`src/app.tsx`、`src/mock/runtime.ts`、`public/`、`scripts/` 或模板来源清单。规则加载、Mock 初始化、网络策略、预览实现、发布设置和凭证属于维护者职责。维护者修改保护区后必须重新固定 manifest 与验收。

不覆盖他人未提交成果、不删除无关页面。路由授权不扩展为工程配置授权。原型任务不改写其它资产目录、公共资产清单或工作台控制元数据。

## 页面组织与企业组件

- 页面入口 `index.tsx` 编排呈现；页面 `service.ts` 只调用 `@/mock/runtime` 的 `requestMock`；局部 state/hooks 优先，确需共享 effects 时才添加 model。
- 业务记录、编辑草稿、选项和模拟响应有明确类型；不用 any 或类型断言掩盖字段不一致。
- SUID 选型：下拉 `ComboList`，树选 `ComboTree`，金额 `MoneyInput`/`Money`，主表 `ExtTable`，日期区间 `FilterDate`，工具栏快速视图 `FilterView`，滚动 `Scrollbar`，附件 `Attachment`。
- 不默认用原生 Select、TreeSelect、InputNumber、Table、DatePicker.RangePicker 或 Upload 替代企业扩展。极简只读展示子表等例外说明具体依据。
- Form 内由 `Form.Item name` 绑定 ComboList，不再传独立 value；配置抽成普通 `{字段语义}Props` 对象。
- 核验当前版 `reader.extFields`（响应原始字段）与顶层 `extFields`（业务保存字段），按顺序对应；不将选项 id 覆盖单据 id。
- Combo store/reader/props/onChange 不用 useMemo/useCallback；无依赖时模块常量，有依赖时普通 const。ExtTable 整个 store 不用 useMemo。
- 选择、清空、联动、回填和编辑回显同步更新业务字段；清空不能残留旧关联值。
- 根上下文固定 `ConfigProvider > App > 页面`。页面不另建全局 Provider，反馈调用使用 App 上下文。
- 附件只用合成本地样例或浏览器内存文件。只读禁上传/删除，仍保留预览/下载；先核验当前版 allowUpload/allowDelete/allowPreview/allowDownload，不能猜 props。
- 不用整体 disabled 代替附件只读；编辑禁用区域与查看区域分开，不引入参考工程专属 helper。
- 金额区分空、零、负值、精度和币种；日期区分日期/时间，明确边界和时区，不用随意 toFixed 或当前日期填空。

## 合成数据与网络保护

- Less 只编译样式，不启用反引号 JavaScript 或 `@plugin` 指令；禁止在可写样式中运行宿主代码。

- Umi/Webpack 解析每个模块、上下文目录、静态资源和 loader；真实路径必须留在当前原型工程内，loader 仅可来自冻结依赖。拒绝绝对外部路径、URI scheme、内联 loader、`.env`、Git 元数据及密钥文件；无法解析时构建失败。
- `public/prototype-guard.js` 在 bundle 之前安装不可替换的 fetch/XHR/WebSocket/EventSource/Worker/sendBeacon/表单拦截。静态 CSP `connect-src 'none'` 同时拒绝绕过网络。
- 应用 `render` 先等待 `initializeMock()`；未安装保护脚本时仅显示错误，不渲染业务页面。
- `requestMock` 初始化前拒绝；按精确 method/path 查 handlers；未知请求抛错，不透传服务、远程 Mock、企业网关或登录系统。
- 不调用原生 fetch/XHR、第三方远程 store、动态远程脚本、iframe、表单提交或浏览器弹窗访问业务目标。组件 store 必须适配本地 handler，不能让组件副作用偷偷请求网络。
- 资源仅同站点或本地 data/blob；字体、图像和附件不引用真实生产地址。不新增 Service Worker 或依赖浏览器扩展。
- 不把真实账号、个人信息、业务附件、内部数据、令牌或密钥写入模板、fixture、代码、日志或静态产物。
- 模拟数据仅当前页面内存，刷新重置；提供明确重置操作，不描述为跨用户共享或后端持久化。
- 覆盖正常/空列表、加载、请求错误、详情、编辑、取消、保存失败；按需求补充筛选、分页、联动、金额日期校验和破坏操作确认。
- 保存失败保留草稿，取消恢复原记录；执行中防重复操作；反馈须匹配真实内存状态。

## 完成与作者确认

- 完成要求当前输入通过类型检查、lint、静态构建，并核对已确认需求和相关交互。按变更风险最少必要检查，不机械新增镜像实现的测试。
- 维护者验收模板还要验证 Mock 未就绪、未知请求、组件副作用与绕过网络；不能把禁止条款当成运行证据。
- 核对键盘、焦点、窄窗口、长文案、滚动、空值及错误定位；不只看截图。
- 作者可直接确认，也可 AI 辅助评审后自行确认；AI 不能代替作者确认，两条路径使用同一门禁。
- 保留确认方式、必要处置依据、固定源码、规则回执和实际检查结果；未运行不得写成通过。
- Git 提交、推送、集成和发布由工作台受控操作执行。WIP 不等于完成，预览不等于正式发布。
- 不提交依赖、dist、凭证、完整 AI 过程、草稿或工具日志；本地运行状态不进入正式资产。
