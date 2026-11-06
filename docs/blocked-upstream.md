# 固定宿主接口缺口与发行编辑

2026-11-06 阶段 0 静态核查。宿主固定为 `687f282e8625c6b8d11ff58211a90524be2e4317` / `0.2.1-rc.2`；只读缓存，不修改。详细证据见 [静态核查](local-workbench-static-audit.md)。本登记描述当前源码，不表示目标实现或桌面验收通过。

## 阻塞目标实现

### blocked-upstream：关闭与退出前的异步保存协调

目标要求正常关闭前等待 requirements `flushActive()`，保存失败、组字或冲突时阻止离场，同时停止自有原型进程。固定宿主没有已核实的插件级异步退出协调服务：`apps/desktop/src/main.ts:1077-1088` 将普通关闭变成隐藏窗口；`:1248-1290` 的退出路径自行确认后关闭 backend，没有调用插件 Client 的保存协调；`preload-app.ts` 与 `ipc.ts` 的公开产品接口没有注册此协调的方法。官方 uiWorkspace/layout 服务也没有该方法。

当前绕过：无。不得把 `beforeunload` 的同步提示冒充等待异步保存，不增加私有 IPC、不改缓存，也不新增未经明确决定的主窗口补丁。需要上游提供可等待、可拒绝的插件退出协调接口，覆盖窗口关闭、菜单/托盘退出及 Host 资源清理，并定义超时与失败行为。此缺口影响阶段 1/2 的 Shell 生命周期；按硬边界停在阶段 0，未进入后续阶段。

## 官方接口的已知限制（无需自建替代）

| 缺口 | 处理边界 / 当前绕过 |
| --- | --- |
| Workspace.path 不可修改、attachSession 要求 cwd 相等 | 目标采用新 Workspace 登记后删除旧登记；旧历史不迁移；尚未实施 |
| 会话存储根为全局，按 cwd 分目录 | 不宣称项目目录包含原生历史；不重写存储路由 |
| ctx.fs 没有 mkdir/rename/unlink | 目标由 Host 校验 containment 后使用 Node fs；尚未实施；不声称外部进程原子性 |
| subprocess 无 sandbox 参数 | 用户点击运行可信项目代码；不能声称 DSH 隔离；AI 禁用 shell 等通道 |
| 无插件系统浏览器打开服务 | 目标依赖固定 desktop 的 window.open 外开处理；尚未验证 |
| ToolGuard 同步，不能 await 路径解析 | 使用同步路径核验；不能把异步 guard 当作有效拒绝函数 |
| 原生搜索不保证所有敏感扩展排除 | 按设计禁用不能保证过滤的 glob/grep；不能仅校验起始目录 |

## 当前发行锚定编辑对账

所有维护文件位于 `apps/desktop-distribution/build/`，唯一装配入口 `prepare-studio-plugin.mjs` 的 `UPSTREAM_EDITS`。当前仍装配旧 Studio，尚未执行退役；这里不提前声称编辑已删除。精确锚点及失败行为保留在各文件和 [build README](../apps/desktop-distribution/build/README.md)，阶段 6 必须逐条复评。

| 维护编辑 | 缺口 / 当前用途 | 目标处置 |
| --- | --- | --- |
| desktop-plugin-edits + 入口内 project-manager / prepare-package-set 编辑 | 生产依赖、默认 bundle、附加 tarball | 改装新四插件及共享契约 |
| desktop-brand-edits | 产品身份、数据目录、标题、协议 | 保留品牌 |
| desktop-policy-edits | 更新策略 HTTP origin 与启动 IPC 顺序 | 删除失效协同策略，按引用复评 |
| desktop-startup-edits | 原生 welcome Host 认证 | 复评必要性 |
| studio-frame-edits / studio-titlebar-edits | Studio 全框布局与标题栏 | 官方 slot 组合优先，复评 |
| studio-settings-bridge-edits / studio-settings-sections-edits | 旧设置桥及分组 | 退役 |
| studio-platform-edits（secret store）及 studio-secret-store | 协同凭据 IPC | 退役，不影响 DSH 模型凭据 |
| studio-platform-edits（prepare-runtime）及 prepare-studio-tools | 随包 Node/pnpm/Git 资源 | 保留所需运行时，移除无用 Git |
| studio-platform-edits（subprocess-local） | Windows Job 进程树 fail-closed | 按新受管进程需求复评 |
| studio-browser-edits 及 browser-check/prototype-view/prototype-bridge | Chromium、内嵌画布与浏览器 IPC | 退役 |
| native-prompt-edits | 非官方 prompt/control admission 事件 | 退役，新方案不拦截原生 prompt |
| studio-packaging-edits | artifacts graph、commit receipt、Windows pack 并发、tar 路径 | 保留必要构建适配 |
| studio-typert-edits | 分批 WorkspaceAnalyzer 反射 | 保留必要构建适配 |
| model-selection-edits | 模型选择状态/交互修正 | 按官方会话复用复评 |
| primary-runtime-edits | 固定运行时校验复用 | 保留必要资源适配 |
| studio-template-edits / studio-template-transform | allowlist 模板归档与展开 | 移入 prototype，移除 preview 专用链路 |

## 环境门禁阻塞

当前为 Linux；`scripts/build-desktop.mjs:40-41` 强制原生 Windows x64。阶段 6/7 的 `pnpm build:desktop` 不能在本环境通过，不能删除或绕过平台检查，也不能用其它构建替代通过记录。此为环境阻塞，不是宿主 API 缺口；尚未执行阶段 6 构建。

## 阶段 1 新确认：默认 Workspace 初始化

`packages/client/ui-workspace/src/client/navigation.ts:463,473-475` 在 Workspace/会话为空时主动调用 `initializeDefaultWorkspace()`。Workspace Controller 配置只有 documentsDirectory / documentsLookupTimeoutMs，没有关闭初始化的公开开关。因此“首次启动首页为空且不自动创建默认项目”暂为 blocked-upstream；不得伪造 Workspace 登记或覆盖官方导航内部实现。需要上游公开禁用默认项目初始化的配置。Shell 只展示真实官方列表，不自行创建默认项目。

2026-11-06 继续执行：退出协调缺口只阻塞依赖该接口的关闭行为，不阻塞包骨架与内部导航等可独立实现。阶段 1 在隔离装配树推进，原有“停在阶段 0”记录是首次核查时点，不表示后续工作未开展；各阶段状态以静态实施记录为准。所有缺口仍不绕过，不能宣称完整目标已实现。

## 阶段 4 新确认：受管进程身份不公开

固定 rc.2 `packages/subprocess/subprocess/src/types.ts:169-196` 的普通 `SubprocessHandle` 只提供流、done、terminate 与 waitForExit，不公开 PID 或 OS 启动时间；`:257-260` 的 PID 属于 terminal handle，不能移用于普通后台原型进程。正常运行/停止可使用同一个官方 handle 管理范围；但持久化 pid+启动时间并在重启后安全辨认/停止孤儿的设计缺少公开身份/重新关联接口，标记 blocked-upstream。

当前绕过：无。不读取 provider 私有对象、不从端口猜 PID、不接管未知进程；不伪造运行记录。需要上游公开受管进程身份和可核验的恢复/终止协议。该缺口与桌面退出协调一并保留为未实现、未验证的能力，不以正常 handle 的静态类型通过冒充。
