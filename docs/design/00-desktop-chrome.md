# 00 桌面外壳统一（前置工作）

阶段一（项目场景）开工前的前置工作：把桌面端 chrome——顶部菜单、侧边栏、登录、设置——统一到 `docs/dseign/` 设计稿的形态，保留 DSH 原生模型配置，补齐协同登录缓存。本阶段不引入任何业务功能。

## 用户目标

- 打开桌面端即见与设计稿一致的外壳：原生标题栏承载「应用/编辑、EADP Studio / 仓库 / main (已同步)、窗口控制」；左侧栏为仓库选择器、五阶段导航、底部用户区。
- 登录一次协同工作台后，重启桌面端仍保持登录；本机登录缓存损坏时自动清除并回到登录页，而不是持续报错。
- 从统一设置能直接打开 DSH 原生模型设置；工作台不出现第二套模型接入层。

## 桌面端职责

### 顶部菜单（Windows caption 带，高 40px）

- 应用/编辑菜单与最小化/最大化/关闭保持 DSH 原生（`preload-menu.ts` + `titleBarOverlay`），不做产品复制。
- Studio 在 caption 带内补两块内容（复用壳侧栏既有定位模式）：
  - 折叠钮：固定 `left:12px`（与壳侧栏 `.toggle` 同位同规格，`no-drag`），切换 Studio 侧栏；壳侧栏在 Studio 激活时整体卸载，该位置空出，由 Studio 补位。
  - 身份条：`EADP Studio / 仓库名 / 分支（已同步）`，起点 = `--dsh-windows-menu-start` + `--dsh-windows-menu-width`（产品补丁已测量菜单宽度），右侧为窗口控制保留空间；文字色 `var(--dsw-alias-label-primary)`，`drag` 区域，背景透明（caption 带由 AppFrame `::before` 绘制）。
- Web（无 `data-windows-titlebar`）回退：身份条留在现行 in-flow 工具栏行。

### 侧边栏（Studio rail）

- 仓库选择器：`</>` 图标 + 项目名 + `分支 • 同步状态` + 展开箭头；整块可点击，打开现有项目对话框（选择/新建/获取项目）。
- 五阶段导航：图标替代 01–05 序号（按设计稿：网格/人群/眼睛/盾牌勾/剪贴板勾）；激活项高亮保持；场景与需求阶段选中资产时，激活项下挂资产子芯片（资产 ID + 返回按钮），点击返回列表。
- 底部用户区：头像（登录后取账号名首字）+ 账号名 + `@gitlabUsername @ GitLab`；右侧设置齿轮打开统一设置「账号与登录」节。未登录显示「登录协同工作台」，点击账号区或齿轮进入登录。移除独立「设置」行与「登录」按钮（`Ctrl+,` 打开 Studio 设置的快捷键保留）。

### 设置

- StudioSettings 弹窗保留五节（账号/外观/协同连接/模型/关于），是统一设置入口。
- 「模型与 Agent」节：说明模型由桌面宿主统一配置，新增「打开宿主模型设置」按钮——关闭 Studio 设置弹窗后，经产品桥接事件打开 DSH 原生设置对话框并定位 `models` 分区。原生模型配置（凭据、模型清单、发现模型）保持唯一权威，Studio 不复制、不缓存。
- 产品桥接（发行编辑，按锚点补丁惯例放 `apps/desktop-distribution/build/`）：`studio-settings-bridge-edits.mjs` 编辑 `packages/client/ui-settings-general/src/client/index.ts`，在设置壳 store 创建处监听 `window` 的 `eadp:open-settings` CustomEvent（`detail.section` 可选），转调 `shellInstance.actions.open()/openSection(id)`，随槽卸载移除监听。该编辑幂等重放、锚点缺失即构建失败。

### 登录缓存

- 链路现状（已核实完整）：登录后 `CollaborationSession` 把会话令牌写入 `DesktopSecretStore`（Host 子进程 → Electron 主进程 IPC → `safeStorage` 加密落盘 `studio-vault/`）；重启后 `state` 轮询经 `/v1/me` 核验自动恢复；后端 `studio_sessions` 持久化，TTL 90 天。
- 本阶段修正两点：
  1. 本机缓存畸形（字段/来源不匹配）时，`saved()` 清除缓存并按未登录处理，不再抛错阻塞 `state` 轮询。
  2. 补齐测试盲区：`DesktopSecretStore` IPC 协议（requestId 匹配、key 校验、超时）用真实 Node IPC 双进程测试；`studio-platform-edits.mjs` 对 `host-process.ts` 的补丁锚点增加回归断言（补丁缺失时 Host 会被 `invalid IPC event` 杀掉，必须防漂移）。

## 协同后台职责

无。登录缓存所需端点（`/v1/auth/login`、`/v1/me`、`/v1/auth/logout`）与会话持久化均已存在。

## 数据与文档格式

无新载体。桥接事件约定：`window.dispatchEvent(new CustomEvent('eadp:open-settings', { detail: { section?: string } }))`，`section` 为原生设置分区 id（如 `models`）；无监听时事件静默丢弃（纯 web 场景回退提示 `Ctrl+,`）。

## 验收标准

1. Windows 桌面 caption 带同时呈现：折叠钮、应用/编辑、`EADP Studio / 仓库 / 分支（已同步）`、窗口控制，互不遮挡；浅色/深色主题下均可读；拖拽、双击最大化行为正常。
2. 侧栏三段与设计稿一致：仓库选择器可打开项目对话框完成切换/新建/获取；五阶段图标导航可用；选中资产时激活项下挂子芯片且可返回列表；底部用户区显示账号与 `@GitLab`，齿轮打开设置。
3. 设置齿轮打开统一设置；「模型与 Agent → 打开宿主模型设置」打开原生设置 `models` 分区；原生模型配置功能不受影响。
4. 登录 → 退出桌面端 → 重新启动：自动恢复登录（用户区显示账号）；手工构造畸形缓存文件后启动：自动清除并回到登录页，`state` 轮询不再持续报错。
5. 新增与既有测试全部通过；`studio-settings-bridge` 编辑与 `host-process.ts` 补丁锚点有回归断言。
