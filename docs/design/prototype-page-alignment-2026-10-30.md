# 原型页面还原与交互复核（2026-10-30）

## 参考与实现范围

| 页面 | 设计参考 | 实现入口 |
| --- | --- | --- |
| 场景与需求目录 | `docs/dseign/项目场景列表.html` | `MaterialCatalog.tsx`、`MaterialCatalogCard.tsx` |
| 场景编辑 | `docs/dseign/项目场景编辑-AI交互优化.html` | `ScenarioWorkspace.tsx`、共享材料工作台组件 |
| 需求编辑 | `docs/dseign/需求管理-AI交互优化.html` | `RequirementWorkspace.tsx`、共享材料工作台组件 |
| 原型工作台 | `docs/dseign/原型交互工作台.html`、配套 CSS／JS | `PrototypeWorkbench.tsx`、`PrototypePreview.tsx` |

按 UI UX Pro Max 检索结果检查焦点、键盘操作、异步反馈、主题对比和减少动态效果；布局以现有设计稿为准。操作菜单复用固定 DSH 的官方 `Menu`，没有新增 slot、service 或 Client 文件系统能力。

目录还原矩阵标题、两列卡片、编号徽章、确认状态、编辑人头像和版本页脚；材料页还原双栏留白、面板圆角、章节摘要、编号流程行和状态栏；原型页还原紧凑顶栏、AI 栏、模式标签、预览边框和输出栏。删除目录迁移后及旧菜单的失效样式。

## 保留的产品决定与可见差异

- 颜色继续使用宿主主题，与 `material-workspace-verification.md` 中的既定决定一致；未将 HTML 的固定深色调色板强制覆盖到桌面。明暗模式分别观察。
- 真实版本、创建人、编辑人及占用信息保留，因此目录卡片约 162px，设计样本约 146px；不复制样本中的覆盖率、基线或贯通结论。
- AI 会话继续通过官方原生会话运行。截图 fixture 的模拟消息和数据没有写入产品逻辑。
- 保存、确认、修订与失败恢复规则沿用现有契约；资料提醒和一致性能力未变为新增门禁。
- 侧栏折叠后不接收键盘焦点；Web 顶栏只渲染一份身份与侧栏开关。原生预览在官方弹出菜单出现时让出显示，关闭后恢复。

## 本轮可核实的验证

研发 HEAD：`632befd95261e1a6926b7400c050f22b9c0aa4a4` 加当前未提交修改。固定 DSH 为 `0.2.1-rc.2`，上游 commit `687f282e8625c6b8d11ff58211a90524be2e4317`；没有升级宿主。

- `pnpm check` 通过；模板仍为 `releaseReady=false`。
- `pnpm test`：216 项，213 通过，3 跳过，0 失败。跳过项为 Windows 子进程输出、Windows GNU tar，以及损坏固定源码缓存检查；没有把跳过计为通过。
- 官方装配入口 `prepare-studio-plugin.mjs --dev-stage` 完成；Host／Client TypeScript build 通过，官方 `tsdown.config.ts` 的两面 bundle 构建通过。
- 装配插件 `recordStudioBuild`、`verifyStudioPlugin` 通过。当前 `sourceDigest=21d12420c1c559b035c194521490d363661094d77fcb7bd9214c9346a0f60b5a`。本次仅核验开发装配插件，不是 Windows 安装包或已安装桌面的版本证据。
- `git diff --check` 通过。工作区既有 `fixed-candidates` Host／测试修改不是本轮页面修改范围。

Headless Chrome 局部检查使用实际 TSX、CSS 与官方主题，传入显式样本数据：目录检查浅／深色与 600px 单列；材料检查浅／深色、1024px 上下布局、菜单 Escape 回焦和弹窗关闭；原型检查 1536／1280／960px、菜单视口范围及 Escape 关闭。所测宽度没有页面横向溢出。

本机截图保留在忽略的 `artifacts/ui-review/catalog/`、`artifacts/ui-review/materials/`、`artifacts/ui-review/prototype/`。这些截图便于局部视觉复查，不是原生桌面完整操作证据。

## 未关闭的桌面验收

当前为 Linux 环境且没有图形显示服务，Chrome DevTools 图形入口报告 `Missing X server`。尚未在本轮交付版本运行 Windows 原生窗口、真实模型、Host、指定协同服务、Git／持久化及失败恢复完整链路；不能宣称 1:1 桌面验收通过或达到生产就绪。

协同联调仍固定使用现有配置的 `http://100.119.183.44:6972`，本轮没有联调，服务版本未知。下一步沿用 `pnpm dev:desktop` 和 `tests/windows-desktop/README.md` 的现有入口，在当前源码构建的 Windows 桌面逐页复验，并补齐 AI 写入、确认、预览、基线和交接及中断恢复的操作证据；不能沿用旧桌面结果替代。

## 追加还原与交互复核

本次源码基线为 `6d8ec3820bf5fc3dddcd9dfebec621cca58d8d00` 加当前页面修改，仍使用上列固定 DSH。以下记录对应本次修改，前文构建摘要及桌面证据不代表本次交付。

- 目录补齐筛选数量、搜索图标与原生清空、Escape 清除搜索、全宽空态；更多筛选改为浮层，保留生效条件及 Escape 回焦。卡片按内容高度排版，修复需求字段较多时编辑人区域越出卡片的问题。
- 材料页响应式阈值由 1280px 改为 900px，使常用 1280px 笔记本窗口保持原型中的左右双栏；901–1400px 工具栏分行容纳操作与完整保存状态，窄窗继续上下排列。该调整用于落实本次按原型还原的要求；主题继续跟随 Host。
- 文档导出改为直接图标入口；章节层级、编号流程、状态分隔与审阅选择栏贴合优化稿，保留原确认和写入授权流程。
- 原型工作台调整标题、计数、工具栏、文件树及文件标签密度，分组输入区、空态与下一步提示；收起及恢复 AI 面板后恢复对应控件的键盘焦点。

自动化：`pnpm check` 通过；`pnpm test` 为 216 项，213 通过、3 跳过、0 失败；`git diff --check` 通过。官方装配脚本 `prepare-studio-plugin.mjs --dev-stage`、Client TypeScript build 与官方 tsdown 两面 bundle 构建通过。

本地 Chrome 使用当前 TSX/CSS 和官方主题，样本与会话为显式 fixture：目录场景／需求 × 深浅色 × 1440／1280／600 共 12 组基本布局及 12 组筛选浮层，检查横向溢出和卡片纵向溢出；搜索、确认状态筛选、空态恢复及 Escape 回焦通过。编辑区检查场景／需求、1440／1280px 深浅主题、审阅／确认／一致性弹层、折叠／恢复共 24 项，未发现横向溢出或浏览器异常。原型工作台 1440／1280／800px 深浅主题共 6 组，无横向溢出，折叠回焦通过。

当前截图与结果保留于忽略目录 `.local/acceptance/ai-interaction-preview/`：`catalog-results.json`、`results.json`、`catalog-*.png`、`scenario-*.png`、`requirement-*.png`、`prototype-*.png`。局部浏览器检查不包含原生会话、真实模型、Host 到协同服务及 Git／持久化完整闭环；本次未连接协同服务，服务版本未知，仍须沿用前文桌面验收入口补齐当前交付版本证据。
