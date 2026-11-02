# 已确认需求的开发与预览阻断排查

日期：2026-11-02。源码基于 `f4f747f3ccf937361dbfb40355445fe6677008b9` 加当前工作区。固定 DSH `687f282e8625c6b8d11ff58211a90524be2e4317`，运行 Electron 44.7.0。本文记录排查结果，不表示验收通过。

## 当前现场

- 项目“测试002” `fb7e7360-7907-425a-bfe8-2f3b155dc36b`，需求“资产管理入库登记” `411d0869-f69a-42d1-924b-9602eb858909`。
- 桌面停留在交互原型，提示开发会话需要恢复，运行按钮禁用。点击恢复入口后，Host 查询原事项返回 HTTP 200，但本轮未观察到原生模型开发或可交互预览。
- 原事项 `90195abc-75f4-4bc9-87be-f82b07509517` 已创建，项目队列位于 `D:/tmp/.eadp/users/1/prototype-queue.json`，原请求停留在 workspace 阶段。工作树仍在。队列记录的失败是替换 `%APPDATA%/eadp-studio/studio/users/1/prototype-queue.json` 时发生 `EBADF`。
- 另一条创建请求 `13a68a77-f8fb-4b44-a9a5-7979ccc1d1e2` 仍在尝试创建相同需求的事项，返回 HTTP 409，消息为需求已在本机另一会话开发。没有释放原占用或删除原请求。
- 桌面实际协同地址为 `http://100.119.183.44:6972`。项目、原事项、基线等读取成功；不是普遍连接失败。服务构建版本未知。

## 独立文件系统诊断

诊断仅使用唯一新建目录中的普通文件，不使用业务状态文件：

1. Node 22.22.0 在 Roaming 新建文件后，同目录 rename 返回 `EBADF`；扩展路径前缀也失败。
2. 同样操作在 Local/Temp 和仓库 `.local/cache` 成功。
3. 通过 Shell.Application 启动的独立 Node 诊断同样失败；这一启动方式不能证明脱离了原进程环境。
4. 命令进程确认新建 Roaming 诊断目录存在、属性为普通 Directory；资源管理器导航到完全相同路径时提示 Windows 找不到该路径。这是进程间文件视图差异的线索，尚不能确定由哪个隔离组件造成。

C 盘为 NTFS，状态 Healthy，Roaming 无重解析点。只读检查发现深信服 UEM 文件隔离驱动已加载，系统 FilterManager 当日 09:33:40–41 有涉及 `SfUemFesfDs`、`SfUemFesfDt`、`SfUemFesfIsolate` 的事件 11。该事件不支持将 rename 失败直接归因于某个产品。未修改 ACL、安全策略、驱动或服务。

## 结论与继续入口

AppData 的原子替换失败仍未解决；程序外的最小复现说明不能仅通过修改原型业务流程解决。没有添加 EBADF 重试、非原子覆盖、状态迁移或新的保存位置。

后续先在正常交互用户环境核对同一诊断文件的可见性及 rename；由终端环境维护人员检查文件视图隔离及文件过滤行为，必要时捕获 rename 的返回结果和调用栈。环境恢复后，通过桌面需求菜单进入原事项继续；核对原请求是否已投递，再继续开发和运行，不能重新创建事项代替恢复。

本轮 `pnpm check` 通过。未修改产品源码，未执行新构建；真实模型、Git 成果同步、可交互预览及失败恢复闭环仍未验收。既有未提交日志改动保留。

## 后续源码核对：项目自身的恢复缺陷

随后再次读取现场，两处队列 revision 已同为 1619；原事项已 `sessionOpened=true`、`state=running`，原请求已 `phase=sent`。`operation.message` 仍保留早先的 EBADF，因此不能用该历史文本判断当前仍保存失败。尚未据此确认真实模型开发完成或预览成功。前文的环境诊断不能替代对项目恢复代码的检查。

已证实的项目问题：

- `ProjectRecord.write` 先写项目 payload，再写账户 metadata。第二步失败后没有跨文件原子性，项目事项与账户调度身份可能不一致。
- 当前 metadata 的 queueOrder 仍为 `queued:90195abc-75f4-4bc9-87be-f82b07509517`、`queued:13a68a77-f8fb-4b44-a9a5-7979ccc1d1e2`，而项目 payload 中第一项已有真实 taskId。`PrototypeCollaboration.data` 合并时直接信任旧顺序；queued→真实任务的替换只发生在首次创建分支，已有任务恢复时不再执行。真实任务的排序位置因此变成 MAX。
- workspace 阶段自动恢复调用 advanceQueue，按上述顺序先选中第二条创建请求。该请求领取已被原事项持有的需求，后端返回 409；advanceQueue 随即返回，不再派发后面的原事项。这解释了部分保存后的重复冲突与恢复停滞机制。当前 sent/running 阶段不会走该调度分支，不能将其描述为当前仍被第二条请求阻断。
- 成功进入 sent 阶段没有统一清除原创建操作的历史错误文本，诊断可能仍显示已失效的失败原因。

没有发现临时文件同名证据：AtomicState 使用 UUID 与 wx，关闭文件后才 rename。同一 Host 的命令与恢复通过 StudioApplication.queue 串行执行；仅凭 AtomicState 实例锁不足不能认定此次是并发写冲突。跨 Host 共享状态目录缺少文件级锁，是另一个风险，尚无本次事故的并发写证据。

后续修复应首先在读取及恢复时按已持久化的 operation→task 对应关系归并队列身份，确保原事项顺序不被失败的新建请求抢占，并清除成功阶段已失效的错误。AppData 独立 rename 失败仍是需分开验证的环境现象。此次源码核对未修改产品实现。

## SQLite 实施与现有现场导入

用户随后要求减少过程文件、采用 SQLite，并明确允许一次性导入现有状态且保留原文件。实施依据见 [ADR-0010](../../adr/0010-local-sqlite-state.md)。删除 AtomicState 和旧状态 JSON 写链路，设置、索引、项目过程记录、原型队列、检查与操作日志改用 SQLite；不改业务文档、源码、Git 工作树及 DSH 原生日志。

已实施队列身份归并、成功阶段错误清理、相同内容不写入、全局 revision 不再重写无关项目，以及本机原事项覆盖同需求时跳过重复创建请求。重复请求原输入与身份保留，未自动投递或伪记完成。

### 已执行的验证

- 当前固定 Electron 44.7.0 自带 Node 24.21.0 / SQLite 3.53.4，实际加载 `node:sqlite` 并执行查询成功；没有增加 npm 原生依赖或升级 DSH。
- 用真实存储 API 在临时目录执行跨数据库事务，第二库的触发器主动拒绝更新时，两库均保留旧值；未变化写入不改变数据库 mtime。StudioStore 重开后项目任务与 clientId/sessionId 保持一致。
- 实际 WorkspaceLocation、PrototypeCheckJournal API 的设置往返、步骤与结果、重复 operation 拒绝验证通过；日志表追加与容量淘汰、12 项目离线导入及中断重跑验证通过。未保留验证用测试代码或新增测试命令。
- 原桌面中的真实模型在暂停前已修改原工作树的 routes、fixtures、handlers 和 AssetRegistry 页面；此次切换不删除、提交或推送这些修改。通过原生停止与 Host 暂停入口收敛后，从应用菜单退出，核对旧 Electron/Host 进程已退出。
- 执行 `node scripts/import-local-state.mjs --state-directory <实际 AppData Studio 目录>`，账号 1 及“测试002”导入成功。SQLite 中原任务仍为 `90195abc-75f4-4bc9-87be-f82b07509517`，原会话仍为 `studio-1d231763-895c-4d73-a463-802f08bcc76c`，状态 paused。全部导入源 JSON 的 SHA-256 与导入 receipt 一致，原文件未变；项目数据库 `PRAGMA quick_check` 为 ok。
- `pnpm check` 与 `git diff --check` 通过。首次完整准备暴露严格可选属性的类型错误，已在源码修正，随后 Host 类型检查通过；完整构建和新版桌面结果继续记录。

这些结果证明当前导入与局部存储行为，不代表真实模型修复、运行工具、Git 同步与可交互预览的完整业务验收通过。

## 2026-11-02 桌面启动认证修复复验

- 样本：`crash-2026-11-02T05-48-56-295Z-host.log`，原错误 `desktop welcome: Web authentication failed`。
- 版本：当前工作区装配，DSH `0.2.1-rc.2`，Electron `44.7.0`；未提交工作区不能用 HEAD 代表交付源码。后端版本未知。
- 变更：原生欢迎页及账号请求复用主窗口已取得的 Host Cookie，通过同源 Node HTTP transport 请求，不再依赖 Electron Cookie jar。
- 验证：`pnpm check`、桌面 TypeScript 与 bundle 构建、锚点幂等及缺失报错检查通过。使用现有 development profile 启动真实 Electron，经 UI 读取确认进入“测试002”场景矩阵，3 个场景、2 个已确认、1 个草稿，原有账号显示正常；未生成新的启动崩溃报告。
- 范围：仅验证此次启动故障恢复；未验证账号重新登录、Host 重启、中断恢复、AI 操作或业务完整链路，不据此宣称生产就绪。
