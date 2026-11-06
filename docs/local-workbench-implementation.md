# 本地工作台实施记录

验证边界：只做仓库检查、TypeScript 静态检查和构建；未启动桌面、真实模型、原型进程或运行时验收。**静态验证通过 ≠ 桌面验收通过 ≠ 生产就绪。** 接口证据与未验证操作见 [静态核查](local-workbench-static-audit.md)，缺口见 [blocked-upstream](blocked-upstream.md)。

## 阶段 0

已提交 `4311ba5`：固定 rc.2 源码核查、缺口登记与桌面未验证操作清单。主 Agent 执行 `pnpm check` 通过。退出异步保存接口缺口不绕过；继续实现不依赖该接口的功能。

## 阶段 1

2026-11-06：新五包骨架、Workspace 首页与工作台、原生会话承载、角色策略及活动文档服务；三个业务 child slot 由 Shell 声明，各功能包独立注册。requirements 的空 flush 仅为本阶段计划明确的占位，阶段 2 替换。共享契约目录从 `packages/contracts` 移为 `packages/eadp-contracts`，保留单一 `@eadp/contracts` 包身份；旧领域导出在后续退役阶段删除，未增加兼容别名。

新装配入口 `pnpm build:plugins` 使用隔离的 `.local/build/local-workbench-dsh`，只装配新五包。旧发行入口尚待阶段 6 替换，不能声称最终发行已切换。上游修改仅来自维护的 fail-closed 编辑；官方 Typert 先生成 Host Remote，再编译 Client。

主 Agent 静态门禁：Host / Client 编译通过；五包各自 Host / Client `tsc --noEmit` 通过；共享契约和四个插件构建通过，声明入口存在、客户端无未打包的产品包 import。命令为 `node apps/desktop-distribution/build/prepare-workbench.mjs --stage-only` 后调用其 `buildWorkbench()`；完整可复用入口为 `pnpm build:plugins`。本机详细日志 `.local/build/workbench-stage1-build.log`，可重建，不作为运行时证据。根 `pnpm check` 结果随阶段提交记录。

仍未实现/验证：桌面退出前异步保存协调、禁止宿主自动创建默认 Workspace（均 blocked-upstream）；本阶段全部桌面行为；后续需求编辑/提案、原型、知识库与最终发行。阶段 5–7 尚未完成。


## 阶段 2

2026-11-06：需求/CONTEXT 的新 Host 文件服务与编辑器已写入。正文使用原生版本条件写入；按需创建需求根；新建/改名补 `.md`，名称、链接、敏感路径与 2 MiB 限额在 Host 校验；目录/改名/删除在 containment 检查后由 Node fs 执行，其外部进程竞态不是 OS 级条件操作。

Client 使用抽象后的正文 DraftBuffer，串行防抖保存、IME 状态、在途保存后重核、项目 epoch、脏输入外部冲突处理及显式删除恢复；外部变化采用设计允许的焦点/定时版本观察。文件切换与 Shell 导航通过实际 `flushActive` 协调。没有新增 beforeunload 异步保存保证；桌面退出接口仍 blocked-upstream。

主 Agent 执行 `pnpm build:plugins` 通过：Host→官方 Typert→Client、五包各 face `tsc --noEmit` 和全部插件构建；日志 `.local/build/workbench-stage2-build.log`。根检查与提交门禁也由主 Agent 执行。以上仅为静态结果。

旧链路调用方核查：RequirementSaves 同时被 ScenarioWorkspaces、Studio 调度、材料确认保存使用；metadata/source/candidate UI 跨旧场景与需求复用。新包没有引入这些调用链；旧包源码及其共用调用方仍保留，等待阶段 6 整体退役，不能说已物理删除。删除范围的这一项仍未关闭，最终验收须核对整包及调用方移除。


## 阶段 3

2026-11-06：新增需求 list/read/propose 三项 Agent-scoped 工具。工具从真实会话解析 Workspace，记忆该 Agent 读到的文件版本；读取按 Unicode 字符分页（默认 12000，最大 24000）。提案只存 Host 内存，包含单文件候选与有界行级差异，取消不创建提案。所有工具显式声明 output.schema/render、对象 additionalProperties 与属性 required:true。

用户在提案面板审阅并应用/丢弃。应用暂停自动保存、等待在途请求、重核 IME/草稿 revision/项目 epoch；Host 再核对用户期望、提案基准与当前磁盘版本后执行条件写入。失败保留提案与输入；应用期间新输入仍保留为草稿。CONTEXT 缺失时使用 createIfAbsent。需求角色的原生 write/edit 仍禁用，guard 仅放行受控提案工具。

主 Agent 执行 `pnpm build:plugins`、各包/face `tsc --noEmit`、全部插件构建、根 `pnpm check` 与提交检查；静态构建日志 `.local/build/workbench-stage3-build.log`。没有运行任何模型或桌面提案样本。旧聊天代码块、章节确认与 prompt-admission 源码仍在未装配的旧包中，阶段 6 统一删除并按引用复核。


## 阶段 4

2026-11-06：原型文件只读查看、模板空目录创建、固定工具链受管安装/运行/停止、独立安装结果、Host 端口与 Umi Local 输出/HTTP 就绪、有界日志、后台运行观察及系统浏览器请求的静态实现已落盘。运行与安装不向 Agent 注册工具；停止只操作本服务持有的官方 handle。Shell 移除/重新定位项目前调用原型窄服务停止自有进程，普通切换不停止。

模板唯一维护位置已移到 `packages/eadp-prototype/assets/`。移除 preview 脚本、synthetic-only 浏览器 guard/自动探针，保留 Umi/React/SUID、本地业务 Mock 和构建资源围栏。manifest 的 46 个源文件参与哈希/路径/跟踪检查；ignored 依赖和构建目录没有复制进装配资产。旧模板路径的发行调用方待阶段 6 整体退役。

主 Agent 执行：模板冻结离线依赖同步、`umi setup` 仅生成类型后 `tsc --noEmit` 通过（`.local/build/prototype-template-typecheck.log`）；`pnpm build:plugins` 包含全部受影响 face 的 `tsc --noEmit` 与四插件构建通过（`.local/build/workbench-stage4-build.log`）；根 `pnpm check` 和提交门禁通过。未启动 Umi 开发服务器、桌面或模型，也未执行原型安装/运行/停止样本。

PID/启动时间及孤儿恢复没有公开 subprocess 接口，仍 blocked-upstream；资源 dispose 不能替代尚缺的桌面退出协调。目录并发替换和端口归属限制见静态核查记录。固定 Node/pnpm 资源装配、模板归档/解包及最终发行校验在阶段 6 完成；当前不宣称已产出新的最终发行物。
