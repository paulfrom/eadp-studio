# Studio 设置、主题与视觉精修 · 下一步实现交接

> 日期：2026-10-18
> 设计源：`docs/dsign/dsign.html`（2026-10-18 重做，已用 headless Chrome 验证）
> 原桌面基线：`docs/img/ScreenShot.png`
> 状态：**设计稿与 Linux 实现已完成；Windows 原生验收尚未执行；本文档不代表 Windows 验收通过。**
>
> 当前工作区：`docs/dsign/dsign.html` 已重做但未提交；本文件为同一轮的交接文档。除这两个文件外，本轮未改代码。

## 1. 交接结论

本轮已确认用 2026-10-18 的 `docs/dsign/dsign.html` 取代此前“11px 高密度、浅色侧栏、indigo 主色”的 Studio 外壳视觉。新方向：

- 深色标题栏 + 深色 Studio 导航栏 + 暖中性内容区 + 单一深蓝主色。
- 设置入口回到工作台内（导航栏底部），账号退出、登录都在设置页。
- 主题使用宿主已有的 `light / dark / system` 能力，Studio 不另建主题服务。
- 登录状态表达为“协同后端持久会话”，但当前后端与客户端实现尚未改动，属于独立决策项。

本次已改设计文件与实现代码：`packages/studio-plugin` 外壳、设置弹窗与主题接入（T1–T4，按 D1 选 A）；协同后端会话寿命改为可配置、默认 90 天（T5 按 D2 决策落地）。Windows 安装/签名/首启验收仍由 Windows 工作站执行。

## 2. 已确认的设计决策

| 项 | 决策 | 证据 |
| --- | --- | --- |
| 视觉基线 | 深色标题栏 + 深色工作区导航 + 暖中性内容区 + 单一深蓝主色；不使用彩色状态堆叠 | `docs/dsign/dsign.html`；`docs/img/ScreenShot.png` |
| 设置入口 | 导航栏底部“设置 Ctrl+,”，打开宿主风格设置弹窗 | `docs/dsign/dsign.html` 侧栏 footer |
| 退出位置 | 只在“设置 → 账号与登录” | 同上；侧栏 footer 不再出现“退出” |
| 登录位置 | 未登录时“设置 → 账号与登录”内登录；首页 CTA、侧栏登录均跳到这里 | 同上 |
| 主题 | 默认跟随系统；可切浅色/深色；持久化由宿主设置负责 | `docs/dsign/dsign.html` 外观页；宿主 `ctx.theme` |
| 设置分节 | 账号与登录、外观、协同连接、模型与 Agent、关于 | 同上 |
| 菜单一致性 | 菜单项只保留 Studio 真正拥有的动作；不再让宿主菜单与首页内容脱节 | 设计稿“应用/编辑/视图/帮助”；实现方案见 D1 |

## 3. 代码现状与差距（证据）

| 需求 | 设计稿 | 当前实现 | 影响 |
| --- | --- | --- | --- |
| 深色导航栏 + 暖色内容区 | 深色 rail，浅色 content | `StudioPanel.tsx` 使用 `bg-white` 侧栏、`#f4f6fa` 内容、`text-[11px]` 高密度 | 需重做外壳 token 与布局 |
| 设置入口 | 侧栏 footer 的“设置 Ctrl+,” | 没有设置入口；宿主 sidebar 被满窗补丁隐藏后，DSH 自带的 `sidebar.settings` 也不再渲染 | 必须在 Studio 内补入口 |
| 退出登录 | 仅设置页 | `StudioPanel.tsx:114` 侧栏“退出”按钮 | 迁移并删除旧入口 |
| 登录 | 设置页登录表单 | 独立 `LoginDialog`（`dialog#studio-login-title`），由 `LOGIN_REQUIRED` 或首页 CTA 打开 | 迁移为设置页账号区；同步改 Windows 验证脚本 |
| 主题跟随系统 | 跟随系统/浅色/深色 | Studio 外壳只有硬编码浅色；没有 `ctx.theme` 接入 | 接入宿主主题，不写第二套偏好 |
| 菜单一致 | 应用/编辑/视图/帮助 | 原生标题栏只有“应用/编辑”（`apps/desktop/src/preload-menu.ts` 的 `createButton('application' \| 'edit')`） | 需 D1 决策；不能在插件里直接加原生菜单 |
| 登录缓存远端持久 | 设置页展示“协同后端 · 远端持久” | 后端 `studio_sessions` 已持久化，但 TTL 固定 8h（`apps/collaboration-api/src/auth/session.ts:8`）；客户端 token 在 safeStorage（`packages/studio-plugin/src/host/adapters/collaboration/session.ts`） | 需 D2 决策；不能只用 localStorage 冒充 |

补充：满窗补丁只移除了宿主左栏列，宿主标题栏仍在；宿主 `ui-settings-general` 的设置触发 seat 在 `sidebar.settings`，随左栏一起消失。设置入口因此必须由 Studio 提供。

## 4. 必须先确认的三项（D1–D3）

### D1. 原生菜单栏是否扩展

- **A（建议）**：保留宿主原生“应用/编辑”，不伪装原生“视图/帮助”。在 Studio 顶栏增加一个内容内的“视图”菜单，承载五阶段、主题与侧边栏折叠；“设置/关于”分别由侧栏入口和设置页承载。设计稿里的原生四菜单视为 mock，不纳入本轮验收。
- **B**：修改桌面发行补丁，让原生标题栏出现 Studio 菜单。需要改 `apps/desktop/src` 的菜单与 IPC、上游菜单模型，并单独做 Windows 原生验证；不建议与本轮视觉改造混做。

未确认前，任务 T4 不编码；先按 A 记录缺口，避免声称“顶部菜单已与首页一致”。

### D2. “登录缓存远端持久”的语义 —— 已决策：默认本机缓存 90 天

产品决策：登录策略默认为“本机缓存 90 天”。实现为：

- 后端会话寿命由 `STUDIO_SESSION_TTL_DAYS` 配置，默认 90 天（`apps/collaboration-api/src/config.ts`、`src/auth/session.ts`）；会话仍持久于 PostgreSQL，登出撤销。
- 桌面端 token 存系统安全存储（safeStorage），不写密码；重启可恢复至过期。
- 设置页只展示真实策略“本机安全存储 · 90 天”，不伪称“远端持久”，不写死“30 天”。
- 不做设备绑定 + refresh、不做 SSO/OIDC；不把本地缓存当作长期刷新凭据。

已更新 ADR 0003 的会话寿命表述；`/v1/auth/login` 仍返回 `expiresAt`，客户端按它判断过期，不再硬编码 8 小时。

### D3. 设置页可展示的真实数据

当前 `StudioState` 没有协同后端地址、版本、模型配置等字段。设计稿中的“服务地址 / 往返延迟 / 后端版本 / 当前模型”不能直接照搬到实现。

处理方式：

- 只展示 `StudioState` 已有字段（账号、GitLab 绑定、连接状态、项目、阶段、任务）。
- 需要展示后端地址/版本时，先加到 Host 投影或配置面（单独 ADR/接口变更），不在客户端硬编码。
- “模型与 Agent”若没有真实投影，降级为只读说明或暂不展示，不用假值。

## 5. 实施范围

### 本轮（T1–T4，前端）

1. Studio 外壳视觉重做：深色 rail、暖色 content、字号/间距/边框/阴影、暗色映射。
2. Studio 自有设置弹窗与侧栏设置入口；退出/登录迁移；删除旧独立登录入口（按“不留兼容层”处理，同步改测试）。
3. 外观页接入宿主 `ctx.theme`：跟随系统、浅/深切换、实时响应、宿主标题栏同步。
4. 菜单缺口按 D1 处理（建议 A：顶栏承载阶段/设置，原生菜单保持现状）。

### 不在本轮

- 后端会话 TTL/远端持久策略（T5，待 D2）。
- 原生菜单栏扩展（待 D1 选 B）。
- 新的协同 API 字段、数据库迁移、SSO。
- Windows 安装、签名、首启验收（在本机 Linux 完成后由 Windows 工作站执行）。

## 6. 任务拆分

### T1 · 外壳 token 与暗色映射

**文件**

- `packages/studio-plugin/src/client/studio/StudioPanel.tsx`（外壳 JSX class）
- `packages/studio-plugin/src/client/studio.module.css`（内部功能区样式，保留）
- `packages/studio-plugin/src/client/studio.tw.css`（如需 Tailwind token）
- `packages/studio-plugin/src/client/studio.tw.generated.css`（生成物，不提交）

**做法**

- 用 `docs/dsign/dsign.html` 的 token 建立 rail/content 变量；暗色使用宿主已写入的 `body[data-ds-dark-theme]`（`ui-layout` 的 theme presenter）作为选择器，不新增主题属性。
- 保留 Tailwind v4 管线（无 preflight、无前缀）；新 token 通过 `@theme` 或 CSS 变量提供。
- 保留 `data-studio-panel="studio"`；阶段标签保留可测的直接 span 结构，或同步修改 Windows 脚本。
- 不改 `call`、`retainSession`、轮询、五阶段数据流。

**验收**

- 1440/1280/1000 宽度下无横向溢出；rail 固定、content 可滚。
- 深/浅两套 token 都有对应值；切换宿主主题时颜色即时变化。
- `node --test tests/scripts/studio-frame-edits.test.mjs` 仍通过。
- `cd packages/studio-plugin && pnpm exec tailwindcss -i src/client/studio.tw.css -o src/client/studio.tw.generated.css --minify` 成功。
- `node apps/desktop-distribution/build/prepare-studio-plugin.mjs --stage-only` 成功。

### T2 · 设置入口、账号与登录迁移

**文件**

- 新建 `packages/studio-plugin/src/client/components/StudioSettings.tsx`（对话框与分节）
- 新建 `packages/studio-plugin/src/client/components/StudioSettings.module.css`（或纳入 `studio.module.css`）
- `packages/studio-plugin/src/client/studio/StudioPanel.tsx`（`settingsOpen`、`settingsSection` 状态；侧栏入口；登录/退出迁移）
- `packages/studio-plugin/src/client/components/LoginDialog.tsx`（删除或并入账号区，不保留双入口）
- `tests/windows-desktop/verify-studio-first-launch.mjs`（更新登录/设置断言）

**做法**

- 侧栏 footer：设置行（`设置` + `Ctrl+,`）+ 账号摘要；未登录时显示“登录”，点击打开设置账号区；不再有“退出”。
- 账号区：
  - 登录态：身份、GitLab 绑定、会话签发/保存位置（只展示真实可得的字段）、退出按钮。
  - 未登录：用户名/密码表单，提交仍走既有 `call({action:'login'})`。
- `LOGIN_REQUIRED` 时打开设置账号区，而不是旧的独立登录弹窗。
- 退出仍走 `call({action:'logout'})`；不要在前端自行清 state 以外另造认证逻辑。
- 设置入口位于 rail footer；宿主 sidebar 隐藏后仍可见。
- `data-studio-panel` 保留；`dialog` 的可访问名称、焦点环、Esc 关闭按宿主风格实现。

**验收**

- 侧栏无退出按钮；退出只在设置页。
- 未登录时首页 CTA、侧栏登录、设置入口都进入设置账号区。
- 登录成功后状态、项目、阶段恢复；退出后清空账号与选中项并回到首页。
- Windows 验证脚本同步更新；不保留旧 `studio-login-title` 断言作为兼容层。
- 现有权限/登录 API 语义不变。

### T3 · 主题接入宿主 `ctx.theme`

**文件**

- `packages/studio-plugin/src/client/index.ts`（`inject` 增加 `theme`；slot inject 增加 theme face）
- `packages/studio-plugin/src/client/components/StudioSettings.tsx`（外观分节）
- `packages/studio-plugin/src/client/studio/StudioPanel.tsx`（订阅/快照）

**做法**

- 宿主已有 `ctx.theme`：`getTheme()` 返回 preference、active.colorScheme、themes；`setTheme('system'|'light'|'dark')` 写入宿主设置并广播 `theme/change`。不要创建第二套主题 store 或 localStorage 偏好。
- 通过 slot inject 提供最小 face：
  - `getSnapshot()` → `ctx.theme.getTheme()`
  - `setPreference(id)` → `ctx.theme.setTheme(id)`
  - `subscribe(listener)` → `ctx.on('theme/change', listener)`，确保返回 disposer
- 组件使用 `useSyncExternalStore`；设置页“外观”读写该 face。
- Studio 暗色样式用 `body[data-ds-dark-theme]` 或快照驱动的根属性；宿主标题栏由 theme presenter 自动同步，无需插件另做。
- 需要确认 `@deepseek-ai/dsh-client-ui-theme` 的 type-only 依赖在插件构建中可用；若类型解析需要，补充 devDependency（运行时不引入）。

**验收**

- 默认“跟随系统”；系统浅/深切换即时生效。
- 设置页浅/深切换同时改变 Studio 与宿主标题栏（宿主 theme presenter 负责）。
- 重开应用保留主题偏好（宿主设置）。
- 不出现 Studio 独立主题状态与宿主不一致。

### T4 · 菜单/顶栏一致性（按 D1）

若选 A：

- 保留原生应用/编辑；Studio 顶栏增加内容内“视图”菜单（五阶段、主题、侧边栏折叠），并保留必要状态与刷新。
- 不声称原生菜单含“视图/帮助”；设计稿中的四菜单是示意，不作为验收项。
- 不新增宿主菜单补丁。

若选 B：

- 单独立项：`apps/desktop` 菜单/IPC + 锚点补丁 + Windows 原生验收；不与本轮视觉/设置迁移混做。

### T5 · 远端持久会话（待 D2，独立）

- 依据 D2 选项修改 `apps/collaboration-api`（session policy/refresh/SSO）与桌面 Host 凭据策略。
- 更新 ADR 0003；登录/`me` 响应返回策略；客户端只展示与遵守，不硬编码。
- 需要 PostgreSQL 迁移与撤销/过期测试；不把旧 token 缓存当作兼容层。

## 7. 测试契约影响

Windows 首启脚本 `tests/windows-desktop/verify-studio-first-launch.mjs` 当前断言：

- `[data-studio-panel="studio"]` 唯一且覆盖 main 槽。
- 五个阶段名，取 `button > span:nth-of-type(2)`。
- 首页按钮文本“登录协同工作台”。
- 侧栏按钮文本“登录”。
- `dialog[open][aria-labelledby="studio-login-title"]`。

实施 T2/T1 时必须同步修改脚本（设置入口、账号区、无侧栏退出），并保留 `data-studio-panel`。不要为了测试保留旧登录弹窗或旧退出入口。

## 8. 验证与验收

### Linux（本机必做）

```sh
node --test tests/scripts/studio-frame-edits.test.mjs
cd packages/studio-plugin
pnpm exec tailwindcss -i src/client/studio.tw.css -o src/client/studio.tw.generated.css --minify
cd ../..
node apps/desktop-distribution/build/prepare-studio-plugin.mjs --stage-only
test -f packages/studio-plugin/src/client/studio.tw.generated.css && echo OK
```

再用 headless Chrome 对设计稿做对照检查（不作为宿主验收）：

- 1440×900、1280×800、1000×800：rail/footer/设置入口/内容滚动正常。
- 系统浅/深切换、设置五节、菜单、登录/退出、阶段切换、窄窗口文档折叠。
- console 无 error；无横向溢出；标签闭合。

### Windows（另由 Windows 工作站执行）

```powershell
node tests/windows-desktop/verify-studio-first-launch.mjs --exe '<绝对路径>\DeepSeek Harness.exe' --timeout-ms 120000 --screenshot
```

目视核对：

- 无 DSH 侧栏；Studio 满窗；深色 rail + 暖色 content 与 `docs/dsign/dsign.html` 一致。
- 设置入口可见；退出只在设置；未登录登录在设置。
- 五个阶段、登录/项目弹窗、原生会话、审批/取消不回归。
- 系统主题切换后 Studio 与标题栏同步；重开保留偏好。
- 不得以 Linux 截图或浏览器结果代替 Windows 原生验收。

## 9. 风险与边界

- **原生菜单不可插件化**：不要为了“四个菜单”的 mock 伪造原生菜单；D1 选 A 时如实记录差异。
- **主题双源**：接入 `ctx.theme` 后必须删掉 Studio 自己的主题偏好，避免两处状态不同步。
- **登录入口迁移**：Windows 测试和用户心智都依赖旧的独立登录弹窗；迁移是一次性切换，不保留双入口。
- **设置数据**：没有投影的字段宁可缺少，不要硬编码地址/版本/模型。
- **会话安全**：D2 未确认前不动后端 TTL；远端持久不等于本地长期缓存 token。
- **Tailwind v4**：新 token 需重新生成 `studio.tw.generated.css`；生成物不入库。
- **上游漂移**：满窗补丁锚点缺失应抛错；不改 `.local/upstream/dsh` 缓存。

## 10. 参考

- 设计：`docs/dsign/dsign.html`
- 原桌面截图：`docs/img/ScreenShot.png`
- 旧外壳 spec（样式章节已被本方向取代，满窗补丁/Tailwind 管线仍有效）：`docs/superpowers/specs/2026-10-16-studio-homepage-dsign-redesign-design.md`
- 旧实施计划：`docs/superpowers/plans/2026-10-16-studio-homepage-dsign-redesign.md`
- 满窗补丁：`apps/desktop-distribution/build/studio-frame-edits.mjs`
- 宿主主题：`.local/upstream/dsh/packages/client/ui-theme/src/client/index.ts`（`ctx.theme`、`getTheme`、`setTheme`）
- 宿主主题落盘：`.local/upstream/dsh/packages/client/ui-layout/src/client/theme-presenter.ts`（`body[data-ds-dark-theme]`）
- 原生菜单：`apps/desktop/src/preload-menu.ts`（仅 application/edit）
- 会话 TTL：`apps/collaboration-api/src/auth/session.ts`（`config.sessionTtlDays`，默认 90 天）
- 客户端会话存储：`packages/studio-plugin/src/host/adapters/collaboration/session.ts`
- 首启验证：`tests/windows-desktop/verify-studio-first-launch.mjs`
