# 00 桌面外壳统一（前置工作）

> 2026-10-20 修订：顶栏动作合并进 caption 带（取消 46px 工具栏行）、设置统一改由 DSH 原生设置壳承载（Studio 节注册进 `settings.section` 槽，删除自绘设置弹窗）、新增「新建会话回原生界面」与原生侧栏返回入口。修订依据：槽框架所有权规则（`SlotOwnershipError`、重复声明拒绝）决定了原生节无法嵌入自绘弹窗，唯一干净路径是反向注册；`ctx.uiWorkspace.startSession()` 已是原生新建会话的完整公开实现。其余决策不变。
>
> 2026-10-20 二次修订（样式对齐）：Studio 的颜色、字体与间距改为消费宿主主题 token——`--dsw-alias-*`（背景/边框/标签/交互/状态/按钮）、`--dsw-specific-sidebar-*`（侧栏填充与导航激活态）、`--dsw-font-family`/`--ds-font-family-code`（字体栈），明暗随 `body[data-ds-dark-theme]` 自动切换，自绘明暗两套字面色与 Inter 字体栈删除；侧栏（rail）改用原生侧栏语言：280px 宽、`6px 12px` 内边距、36px 行高、`--dsw-radius-md` 圆角、hover/激活用宿主 nav token；设置节字体同栈。字号与行高对齐原生（正文 14px/1.6，行标题 14px/20px，次要 12px/17px），去除负字距。

阶段一（项目场景）开工前的前置工作：把桌面端 chrome——顶部菜单、侧边栏、登录、设置——统一到 `docs/dseign/` 设计稿的形态，保留 DSH 原生模型配置，补齐协同登录缓存。本阶段不引入任何业务功能。

## 用户目标

- 打开桌面端即见统一外壳：caption 带单行承载「应用/编辑、EADP Studio / 仓库 / 分支（已同步）、新建会话、视图、设置、窗口控制」；左侧栏为仓库选择器、五阶段导航、底部用户区。
- 工作台「新建会话」一键回到 DSH 原生界面并打开新会话；原生侧栏可一键返回工作台。
- 全部设置在唯一弹窗完成：Studio 的协同账号/外观/协同连接/关于与 DSH 原生账号/通用/模型/插件/Agent 预设/子代理并列于原生设置壳；不再出现第二套设置弹窗。
- 登录一次协同工作台后，重启桌面端仍保持登录；本机登录缓存损坏时自动清除并回到登录页，而不是持续报错。

## 桌面端职责

### 顶部菜单（Windows caption 带，高 40px）

- 应用/编辑菜单与最小化/最大化/关闭保持 DSH 原生（`preload-menu.ts` + `titleBarOverlay`），不做产品复制。
- Studio 把身份条与动作区全部放进 caption 带（2026-10-20 修订：原 46px 工具栏行取消，主工作区增加 46px 垂直空间）：
  - 折叠钮：固定 `left:12px`（与壳侧栏 `.toggle` 同位同规格，`no-drag`），切换 Studio 侧栏；壳侧栏在 Studio 激活时整体卸载，该位置空出，由 Studio 补位。
  - 身份条：`EADP Studio / 仓库名 / 分支（已同步）`，起点 = `--dsh-windows-menu-start` + `--dsh-windows-menu-width`（产品补丁已测量菜单宽度），`drag` 区域，背景透明（caption 带由 AppFrame `::before` 绘制）。
  - 动作簇（`no-drag`，位于身份条与窗口控制保留区之间，右侧保留 150px）：新建会话（主操作）、本地原型链接（预览存在时）、视图菜单（五阶段 + 主题）、设置、刷新。动作由声明式条目模型（`client/topbar/items`）驱动，后续功能加条目只改声明不改组件。
- Web（无 `data-windows-titlebar`）回退：单行 in-flow 工具栏承载身份条 + 动作簇，同一套条目模型渲染。

### 会话往返（2026-10-20 新增）

- 工作台「新建会话」：调 `ctx.uiWorkspace.startSession()`——复用或新建空白会话，并把主面板切回原生对话界面（`selectPanel(null)`）。这是 DSH 公开跨插件服务的既有行为，无需上游编辑。
- 原生侧栏面板行：Studio 向 `sidebar.panellist` 槽注册 `EADP Studio` 行（id `studio`，图标 + 标签）。原生界面下该行可见，点击 `selectPanel('studio')` 返回工作台；此前用户进入 Studio 后没有任何返回原生的路径，该行是往返的另一半。
- 任务级「与 AI 整理 / 恢复对话」不变：purpose 绑定的任务会话命令与全局新建会话是两回事。

### 侧边栏（Studio rail）

- 仓库选择器：`</>` 图标 + 项目名 + `分支 • 同步状态` + 展开箭头；整块可点击，打开现有项目对话框（选择/新建/获取项目）。
- 五阶段导航：图标替代 01–05 序号（按设计稿：网格/人群/眼睛/盾牌勾/剪贴板勾）；激活项高亮保持；场景与需求阶段选中资产时，激活项下挂资产子芯片（资产 ID + 返回按钮），点击返回列表。
- 底部用户区：头像（登录后取账号名首字）+ 账号名 + `@gitlabUsername @ GitLab`；右侧设置齿轮打开统一设置的协同账号节。未登录显示「登录协同工作台」，点击账号区或齿轮进入登录。移除独立「设置」行与「登录」按钮（`Ctrl+,` 快捷键保留）。

### 设置（2026-10-20 修订：唯一弹窗 = DSH 原生设置壳）

- 删除自绘 StudioSettings 弹窗。唯一设置入口是 DSH 原生设置对话框（桥接补丁已使其在 Studio 激活时可用：壳侧栏保持挂载，设置壳 store 提升到插件激活层）。
- Studio 节注册进 `settings.section` 槽（与 `ui-settings-models` 等原生节同一机制）：协同账号（id `studio-collab`）、外观（`studio-appearance`）、协同连接（`studio-connection`）、关于（`studio-about`），与原生节（账号/通用/模型/插件/Agent 预设/子代理）并列。模型配置直接在弹窗内完成，不再有「打开宿主模型设置」跳转；原生模型配置保持唯一权威。
- 打开途径：侧栏底部齿轮（定位协同账号节）、欢迎页登录按钮、`Ctrl+,`，均经 `eadp:open-settings` 桥接事件。
- 节组件经自己的 inject 拿 studio 命令通道与主题 face，自行拉取状态；登录/登出成功即派发 `eadp:studio-state-changed`，工作台立即刷新（不等 10s 轮询）。
- 上游锚点补丁 `studio-settings-sections-edits.mjs`：`SettingsRoot.tsx` 的 `navIcon()` 增加 Studio 节 id → 原生 primitives 图标映射，未命中回退齿轮；注册进 `UPSTREAM_EDITS`，锚点缺失即构建失败。

### 登录缓存

- 链路现状（已核实完整）：登录后 `CollaborationSession` 把会话令牌写入 `DesktopSecretStore`（Host 子进程 → Electron 主进程 IPC → `safeStorage` 加密落盘 `studio-vault/`）；重启后 `state` 轮询经 `/v1/me` 核验自动恢复；后端 `studio_sessions` 持久化，TTL 90 天。
- 本阶段修正两点：
  1. 本机缓存畸形（字段/来源不匹配）时，`saved()` 清除缓存并按未登录处理，不再抛错阻塞 `state` 轮询。
  2. 补齐测试盲区：`DesktopSecretStore` IPC 协议（requestId 匹配、key 校验、超时）用真实 Node IPC 双进程测试；`studio-platform-edits.mjs` 对 `host-process.ts` 的补丁锚点增加回归断言（补丁缺失时 Host 会被 `invalid IPC event` 杀掉，必须防漂移）。

## 协同后台职责

无。登录缓存所需端点（`/v1/auth/login`、`/v1/me`、`/v1/auth/logout`）与会话持久化均已存在。

## 数据与文档格式

无新载体。桥接事件约定：`window.dispatchEvent(new CustomEvent('eadp:open-settings', { detail: { section?: string } }))`，`section` 为设置分区 id（如 `studio-collab`、`models`）；无监听时事件静默丢弃（纯 web 场景回退提示 `Ctrl+,`）。新增工作台刷新通知：`window.dispatchEvent(new CustomEvent('eadp:studio-state-changed'))`，无 detail。

## 验收标准

1. Windows 桌面 caption 带单行呈现：折叠钮、应用/编辑、`EADP Studio / 仓库 / 分支（已同步）`、新建会话、视图、设置、窗口控制，互不遮挡；浅色/深色主题下均可读；拖拽、双击最大化行为正常；主工作区上方没有第二行工具栏。web 回退为单行 in-flow 工具栏。
2. 侧栏三段与设计稿一致：仓库选择器可打开项目对话框完成切换/新建/获取；五阶段图标导航可用；选中资产时激活项下挂子芯片且可返回列表；底部用户区显示账号与 `@GitLab`，齿轮打开设置协同账号节。
3. 点击「新建会话」切到原生 DSH 界面并打开新会话；原生侧栏可见 `EADP Studio` 面板行，点击返回工作台。
4. 齿轮 / `Ctrl+,` / 欢迎页登录打开唯一设置弹窗；弹窗左导航同时可见 Studio 四节与原生节，节图标正确（非齿轮回退）；协同登录/登出即时生效；模型配置在弹窗内直接完成，无二次跳转；原生模型配置功能不受影响。
5. 登录 → 退出桌面端 → 重新启动：自动恢复登录（用户区显示账号）；手工构造畸形缓存文件后启动：自动清除并回到登录页，`state` 轮询不再持续报错。
6. 新增与既有测试全部通过；`studio-settings-bridge`、`studio-settings-sections` 编辑与 `host-process.ts` 补丁锚点有回归断言。
