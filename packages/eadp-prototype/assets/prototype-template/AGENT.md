# 原型工程规则（eadp-prototype 1.0.0-local.1）

本工程用于本地需求的合成数据演示。工程根 `AGENT.md` 是唯一规则入口；不创建另一份规则或兼容路径。本文件自包含，不能依赖维护者机器上的目录、外部 skill 或主应用。

## 工作范围

- 依据当前需求文档和明确授权的原型范围实现；业务规则不清楚时保留问题，不生成假业务结论。
- 原型代码是项目 `原型/` 下的普通工程；不改写需求、知识库或其它项目目录。
- AI 负责编辑代码；依赖安装、启动和停止由用户在工作台操作，不通过模型执行命令。

## 技术栈与具体命令

- React 18.3.1、TypeScript 5.6.3、Umi 4.6.53、Less，UI 为 `@ead/suid` 2.1.62，图标为 `@ead/suid-icons` 1.2.11。
- Node 22.22.3、pnpm 11.28.5；独立 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml`。不共享工作台根依赖，不混用 npm/yarn，不升级包。
- 先读取已安装同版本组件 `.d.ts`、实现或官方同版本文档，再使用 props；不能从 Ant Design 经验推断企业扩展 API。
- 从工程根执行 `pnpm install --frozen-lockfile`，冻结安装失败须记录真实原因。
- 独立类型检查：`pnpm run typecheck`（`umi setup` 后 `tsc --noEmit`）。
- 独立 lint：`pnpm run lint`。静态构建：`pnpm run build`，输出目录固定 `dist/`。
- `pnpm run check` 按序运行以上三项；失败不修改工程配置来绕过。
- 工作台固定执行 `pnpm run start`（`umi dev --host 127.0.0.1`），端口由 Host 分配；在系统浏览器中查看页面。

## 代码组织

- 页面放在 `src/pages/<PageName>/`；复用组件放在 `src/components/`，文案沿用 `src/locales/`。
- 本地业务样例与请求分别放在 `src/mock/fixtures.ts`、`src/mock/handlers.ts`；页面服务调用 `requestMock`，不增加后端透传。
- 路由在 `config/routes.json` 声明；保持固定布局与路由加载器约定，不引入可执行路由配置。
- 保留锁定依赖、构建资源围栏、Less 限制和敏感文件过滤；不通过配置变更绕过错误。
- 不覆盖他人未提交成果，不删除无关页面。

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

## 本地业务 Mock 与资源边界

- Less 只编译样式，不启用反引号 JavaScript 或 `@plugin` 指令；禁止在可写样式中运行宿主代码。

- Umi/Webpack 解析每个模块、上下文目录、静态资源和 loader；真实路径必须留在当前原型工程内；源文件请求不得用 `!` 覆盖 loader，loader 只由受保护构建配置指定。拒绝绝对外部路径、URI scheme、内联 loader、`.env`、Git 元数据及密钥文件；无法解析时构建失败。
- 应用 `render` 先等待 `initializeMock()`；页面请求仅使用本地 handler，加载失败显示实际错误。
- `requestMock` 初始化前拒绝；按精确 method/path 查 handlers；未知请求抛错，不透传服务、远程 Mock、企业网关或登录系统。
- 不调用原生 fetch/XHR、第三方远程 store、动态远程脚本、iframe、表单提交或浏览器弹窗访问业务目标。组件 store 必须适配本地 handler，不能让组件副作用偷偷请求网络。
- 资源仅同站点或本地 data/blob；字体、图像和附件不引用真实生产地址。不新增 Service Worker 或依赖浏览器扩展。
- 不把真实账号、个人信息、业务附件、内部数据、令牌或密钥写入模板、fixture、代码、日志或静态产物。
- 模拟数据仅当前页面内存，刷新重置；提供明确重置操作，不描述为跨用户共享或后端持久化。
- 覆盖正常/空列表、加载、请求错误、详情、编辑、取消、保存失败；按需求补充筛选、分页、联动、金额日期校验和破坏操作确认。
- 保存失败保留草稿，取消恢复原记录；执行中防重复操作；反馈须匹配真实内存状态。

## 验证与交付

- 核对类型、lint、静态构建和需求交互；检查由维护者执行，不给 AI 增加命令执行权限。
- 核对键盘、焦点、窄窗口、长文案、滚动、空值及错误定位；页面可访问不证明业务正确。
- 未执行的安装、构建、启动、停止、浏览器与桌面行为必须明确记录为未验证，不沿用历史结果。
- 本工程不包含自动浏览器验收、规则回执、候选、基线、Git 提交或发布流程。
- 不提交依赖、dist、凭证、完整 AI 过程、草稿或工具日志；本地运行状态不进入业务文档。
