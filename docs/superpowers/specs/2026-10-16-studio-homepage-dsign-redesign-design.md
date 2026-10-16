# Studio 首页 dsign 视觉重做 · 设计

> 日期：2026-10-16。来源：桌面端运行截图暴露「双侧边栏」问题（docs/img/ScreenShot.png），用户确认产品首页视觉以 `docs/dsign/dsign.html` 为参考，代码逻辑与页面结构保持现状，样式按 Tailwind v4 实现。

## 1. 问题诊断（证据）

截图中左侧深色侧栏是 DSH 宿主的工作区侧栏，右侧是 `StudioPanel` 自带外壳，形成双侧边栏。根因不是插件注册错误：

- 插件注册方式（`packages/studio-plugin/src/client/index.ts:34-38`，`slots.register({ name: 'main', key: 'studio' })` + `layout.selectPanel('studio')`）符合上游全局 main 面板范式。
- 上游三栏壳 `AppFrame`（`.local/upstream/dsh/packages/client/ui-layout/src/client/AppFrame.tsx:280-282`）无条件渲染左侧栏列，列宽解算与 `activePanelId` 无关；上游不存在 main 面板满窗 API。`toggleSidebar()` 在 Linux 下仍保留 56px 图标轨，不满足满窗。
- 产品设计要求满窗（`dsh_eadp_studio_plan/05-产品形态与主界面.md:7`），`release.lock.json` 中 `targetReleasePocVerified: false`，该形态从未验收。

## 2. 范围与原则（已与用户确认）

- **只参考 dsign.html 的视觉样式**：配色令牌、字体定义、留白与密度、边框/圆角/阴影语言。
- **代码逻辑与页面结构不变**：`StudioPanel` 现有状态管理、`call`/`retainSession`、登录与项目弹窗、五阶段内部功能区（目录/任务区/inspector）全部保留；不照搬 dsign.html 的 mock 结构与交互脚本。
- **样式实现走 Tailwind v4**（CSS-first）。
- **保留 DSH 原生标题栏**，不做 frameless 自绘窗口 chrome。

## 3. 改动一：满窗发行补丁

新增 `apps/desktop-distribution/build/studio-frame-edits.mjs`，仿照 `desktop-startup-edits.mjs` 的锚点替换模式，修改构建树中的 `packages/client/ui-layout/src/client/AppFrame.tsx`：

- 在 AppFrame 组件中读取 `usePanelInfo(info => info.activePanelId)`；
- 当 `activePanelId === 'studio'` 时：侧栏列宽解算强制为 0，且不渲染 `<div className={css.sidebarCol}>`；
- 锚点缺失或重复即抛错（沿用现有 edit 契约），接入 `prepare-studio-plugin.mjs` 的 `UPSTREAM_EDITS`。

约束：不修改 `.local/upstream/dsh/` 缓存源码，补丁只作用于 `.local/build/dsh` 构建树。

## 4. 改动二：Tailwind v4 管线（插件侧）

宿主 client bundle 预设（`.local/upstream/dsh/packages/client/tsdown.client.ts`）不含 PostCSS；CSS 由 lightningcss 处理：`.module.css` 产出类名映射并注入 style 标签，普通 `.css` 经 `dsh-css-global-inline` 编译注入。Tailwind 因此走「CLI 预编译 → 全局 CSS 注入」路线，不动上游管线：

1. `packages/studio-plugin` 增加 devDependency `@tailwindcss/cli`（Tailwind v4）。
2. 新增 `src/client/studio.tw.css` 入口：
   - 只引入 `tailwindcss/theme.css` 与 `tailwindcss/utilities.css`，**不引入 preflight**（避免重置宿主全局样式）；
   - `@theme` 块写入字体令牌（Inter、JetBrains Mono）；配色直接使用默认 slate/indigo/emerald 调色板加少量任意值（如 `bg-[#1e40af]`），与 dsign.html 本体做法一致；
   - 工具类**不加前缀**（spike 实测：v4 的 `prefix()` 在拆分 import 上被静默忽略，全量 import 则无法排除 preflight，二者不可兼得）。隔离依据：宿主 DSH 全部界面使用 CSS Modules 哈希类名，裸工具类（`.flex`、`.w-52` 等）不会作用于宿主 DOM；面板根节点保留 `studio-root` 类作标识。
3. 预编译产物 `src/client/studio.tw.generated.css`：`tailwindcss -i studio.tw.css -o studio.tw.generated.css --minify`。生成时机在 `prepare-studio-plugin.mjs` 的 placePlugin 阶段执行，产物不进 Git（构建产物）。
4. `StudioPanel.tsx` 顶部 `import '../studio.tw.generated.css'`，由 `dsh-css-global-inline` 编译注入。
5. **Spike 结论（2026-10-17 实测）**：`prefix(tw)` 在拆分 import 上静默失效（Tailwind v4 已知限制），故采用无前缀拆分导入方案；spec 原记录的 v3 备选不再适用。

## 5. 改动三：StudioPanel 外壳换肤

- 外壳 JSX（顶栏、侧栏、账号区、状态条）按 dsign.html 视觉语言重写：浅色底（`#f4f6fa`/`#f8fafc`）、白侧栏配 `slate-200` 边线、indigo 主色激活项、11px 级高密度字号、等宽字体用于 ID/分支/哈希。
- 信息架构不变：侧栏仍为项目选择器 + 五阶段导航 + 底部账号；主区仍为现有阶段功能区。
- 图标不用 Material Symbols 字体，改用内联 SVG 组件（宿主管线原生支持 SVG import）。
- 字体暂用系统字体栈，`@theme` 保留 Inter/JetBrains Mono 令牌；woff2 离线打包另行评估，不阻塞本次。
- 外壳相关的 `studio.module.css` 类删除；内部功能区样式本次保留，后续迭代替换（不加兼容层，删除即删除）。

## 6. 验证

- 本机边界（用户明确）：不打包桌面客户端验证；改动完成后提交代码，由 Windows 工作站做宿主验收。
- 本机必做：edit 单元测试通过、Tailwind 产物生成成功、`prepare-studio-plugin.mjs --stage-only` 装配无锚点错误。
- Windows 工作站验收：完整 `prepare-studio-plugin.mjs` 构建（验证 lightningcss 对 Tailwind v4 产物的编译与插件打包），安装运行后执行 `tests/windows-desktop/verify-studio-first-launch.mjs --screenshot` 并目视核对截图：无 DSH 侧栏、Studio 满窗、外壳样式符合 dsign.html、五阶段切换与登录/项目弹窗功能不回归。
- 满窗补丁锚点缺失即报错，防止上游漂移静默失效。
