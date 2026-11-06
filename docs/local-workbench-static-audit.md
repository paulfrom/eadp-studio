# 本地工作台静态前置核查

2026-11-06，阶段 0。仅源码阅读；未启动桌面、模型、原型进程或运行时验收。基线为 `apps/desktop-distribution/release.lock.json` 的 DSH `687f282e8625c6b8d11ff58211a90524be2e4317` / `0.2.1-rc.2`，缓存 package.json 版本一致。缓存不含 Git，不能据此证明每个缓存字节未被改动。

下列 DSH 路径均相对 `.local/upstream/dsh/`。该目录不在知识图索引内（coverage 标为 excluded subtree），结论来自直接源码阅读和精确搜索。此记录不是桌面验收证据。

## 接口核查

| 项目 | 源码证据 | 静态结论 |
| --- | --- | --- |
| desktop 装载链 | `apps/desktop-host/src/index.ts:27`；`apps/desktop/src/project-manager.ts:32,142,175`；`packages/boot/app-boot/src/profile.ts:183` | Host 使用 desktop profile；桌面项目以 web 模板 bundles 初始化，包含 base + web-app。实际已安装 profile 是否加载仍待运行时核实 |
| Workspace/UI | `packages/bundle/web-app/cordis.patch.yml:91,154,361` | workspace、workspace-controller、ui-workspace 有明确装载行 |
| 文件沙箱 | `packages/bundle/base/cordis.patch.yml:243,518` | sandbox-policy 与 fs-sandbox 有明确装载行；不是只在依赖清单里存在 |
| Workspace 身份 | `packages/workspace/workspace/src/index.ts:238,502`；`src/entity.ts:110-145` | create/resolveByPath canonicalize；attachSession 要求 session header cwd realpath 与 Workspace.path 相等；无搬移接口，不得改写记录绕过 |
| 会话创建 | `packages/api/session-controller/src/commands.ts:111-150` | workspaceId 与 cwd 互斥；cwd 来自 Workspace.path；传 agentPreset；成功后 attachSession，失败如实返回 attach-failed |
| 会话恢复 | `packages/core/agent/src/index.ts:102-118,132-143,393-418` | create/resume 均支持 unpublished setup；setup 在发布前执行。角色策略必须同时覆盖原生创建和恢复入口，不能仅在自建按钮里注册 |
| 文件接口 | `packages/fs/fs/src/index.ts:100,132,173,181,205,252,266` | watch/resolve/contains/stat/readText/listDir/writeText 可用；contains 同步；writeText 第五参数是显式 sandboxPolicy |
| 版本写 | `packages/fs/fs/src/types.ts:118-125,184-185`；`packages/fs/fs-local/src/index.ts:205-242` | createIfAbsent 已存在报 FS_NOT_OBSERVED；replaceIfVersion 缺失/变化报 FS_STALE_VERSION；不能以无 intent 写入替代版本核查 |
| Host 写策略 | `packages/fs/fs-sandbox/src/index.ts:78-91` | 显式 policy 传入 checkedTarget 后执行写入；读不设栅栏。Windows 实际行为未验证；不得引入裸 backend/Node 正文写入 fallback |
| ToolGuard | `packages/core/tools/src/index.ts:725-732,1105-1158,1514-1527` | guard 为同步单调拒绝函数，普通 ctx 全局，agent.ctx 局部；restrict 要求 scoped ctx。不能 await 异步路径检查，也不能修改参数后放行 |
| schema | `packages/core/tools/src/schema.ts:65-71,97,292-295,490-495,565-586` | 作者 DSL 的 required 只能 true；对象显式 additionalProperties；output.schema/render 必需。编译后标准 JSON Schema 出现 required 数组不是作者 DSL 用法 |
| 文件工具/搜索 | `packages/fs/tool-fs/src/index.ts`；`packages/fs/tool-fs-search/src/grep.ts:111-115` | write/edit 仍须 preset + guard。grep 只构造 pattern/include/path 参数，无强制敏感扩展排除；不能只校验起始目录就宣称安全，按设计禁用 glob/grep，直至有可证明的逐文件过滤 |
| UI 官方接口 | `packages/client/ui-workspace/src/client/navigation.ts:55-131`；`ui-sidebar/src/client/contract/slots.ts:35`；`ui-settings/src/client/contract/slots.ts:57`；`ui-conversation/src/client/contract/slots.ts:270-276` | openWorkspace/connectWorkspace/startSession、目录选择/列表/创建可用；sidebar.panellist/settings.section/conversation.input.dock/left 的 owner/scope 以类型为准 |
| dual-face | `packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md` | Client 必须有 dsh.client/export、包名匹配的 lazy factory，资源在 apply 生命周期注册；不得替换 root、读其他插件 DOM 或在 Renderer 使用 Node fs |
| Typert | `packages/typert/generator/README.zh.md:29-80` | 声明 host/client typert 和 remote exports；构建生成客户端契约；不能手写猜测 RPC 签名，Host 后 Client |
| 系统浏览器 | `apps/desktop/src/main.ts:241-244` | window.open 的 http/https 路径调用 shell.openExternal 后 deny 内嵌窗口；未实测系统浏览器是否成功 |
| 品牌 | 维护源码 `apps/desktop-distribution/build/desktop-brand-edits.mjs:29`；上游 `apps/desktop/src/main.ts:83,944` | 品牌编辑设置 packaged DSH_HOME 与 app name；userData 由 Electron 名称派生，不改上游缓存 |

## 环境阻塞

当前执行环境是 Linux。维护入口 `scripts/build-desktop.mjs:40-41` 强制 native Windows x64 Node，`checkPrerequisites` 首先调用它。阶段 6/7 的 `pnpm build:desktop` 因此无法在此环境通过，不能改平台判断、伪造 process.platform 或把其它构建冒充该门禁。应在现有固定 Windows 构建环境执行同一版本；这不授权启动桌面。此阻塞不影响前面阶段可执行的静态源码核对。

## 留给桌面的未验证操作

静态验证通过 ≠ 桌面验收通过 ≠ 生产就绪。以下均未执行：

- 安装后 profile 真正加载 Workspace/fs/sandbox 服务，首次打开/别名/目录丢失/搬移/移除不串项目、不删除文件。
- 原生新建、恢复、重启后的会话 cwd、preset、guard/context；全部真实工具通道及子 Agent 的拒绝覆盖。
- Windows ctx.fs 的 watch/stat/版本写、外部进程竞态、路径大小写/junction/符号链接、显式 policy。
- IME、自动保存/在途保存、切项目/关闭 flush、外部改动、迟到回包、提案过时/应用竞态与失败保留。
- Umi 端口注入/HTTP 就绪、端口冲突、依赖安装失败、进程树停止、退出与强杀孤儿辨认；仅停止自有进程。
- window.open 真正外开系统浏览器并可操作本次运行的页面。
- 内置知识内容来源/版本确认；用户知识库 CRUD/hash/manifest/外部变化/损坏/重启；知识提案确认写入、过时、丢弃；中文检索与引用可追溯。
- 真实模型需求读取→提案→用户应用→原型修改→运行→停止→重启恢复；失败、中断与恢复。
- 最终安装包不含旧协同/旧插件/Chromium，保留旧用户成果、DSH 历史与模型凭据；未验证安装及生产就绪。

## blocked-upstream：正常退出前异步保存

`apps/desktop/src/main.ts:1077-1088` 的窗口 close 只隐藏窗口，页面继续存活；`main.ts:1266-1285` 的真正退出经过 quitConfirmation 后调用 finishQuit。`apps/desktop-host/src/quit-inspection.ts:24-43` 仅统计活动 agent/job 和已设定的 schedule，未向 Client 请求保存，也没有接受草稿失败来否决退出的合同。对 `packages/client/`、`packages/api/`、`apps/desktop-host/src/`、`apps/desktop/src/` 搜索 `beforeunload`/`flushActive`/退出生命周期后，未找到公开的 Renderer 异步 flush + 可否决退出 seam。

因此“正常关闭前等待 flush，保存失败阻止退出”不能据现有官方接口实现或宣称成立。`beforeunload` 的 fire-and-forget 保存、假造活动任务、接管桌面内部 IPC 均不能替代此接口。需要上游公开生命周期协议（开始退出→Client await flush→失败否决→成功后停止自有进程并退出）；本次不能自行新增未授权 hack。Shell 内部项目/文档切换的 flush 可以自行协调，但不等于桌面退出保证。该项应登记 `docs/blocked-upstream.md` 并阻塞依赖它的产品行为。
