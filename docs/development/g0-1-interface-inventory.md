# G0-1 真实接口清单（固定上游 d743267）

上游基线：`deepseek-harness` 源码提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`（发布 `dsh-v0.2.1-alpha.2`）。
工作副本：`.local/upstream/dsh`（Linux 完整解包，见 `apps/desktop-distribution/release.lock.json`）。
采集方式：只读上述固定源码，逐项记录文件路径、symbol、签名与生命周期限制；行号为该提交内行号。
规则：只登记已核对的真实符号；未核对的项写入文末「未验证与待补」，不填推断接口。本清单是接口依据，不是切片或 G0 通过证据。

## 1. 插件装载

| 用途 | symbol / 契约 | 位置 | 限制 |
| --- | --- | --- | --- |
| Host 半边插件 | cordis 插件：导出 `name`、`apply(ctx)`、可选 `inject` | `docs/cookbook/extension-cookbook.md`；实例：`packages/extensions/ui-cordis/src/index.ts` | 通过 profile 行装载，不改 Agent loop |
| profile 装载行 | `- id: <row>` / `name: <npm 包>` / `disabled` / `config` | `packages/bundle/base/cordis.patch.yml` | patch 替换整行 `config`；后写覆盖先前层 |
| client 半边声明 | `package.json` 的 `dsh.client = { platform: 'web', inject?, immediately? }` | 实例：`packages/extensions/ui-cordis/package.json` | 只在声明后由 `ctx.clientModules` 扫描；缺 bundle 时启动期 `AggregateError` |
| client bundle 导出 | `exports["./client"]` → `lib/client.js` | 同上 | 必须与 `dsh.client` 同时存在 |
| client 模块服务 | `ctx.clientModules` — `ClientModuleRegistry` | `packages/client/modules/src/index.ts`（declare 行 47） | 可选能力，不是 Agent loop 的一部分 |

## 2. 桌面发行装配

| 用途 | symbol / 契约 | 位置 | 限制 |
| --- | --- | --- | --- |
| 核心包集描述符 | `DesktopCorePackageSet`、`DesktopCorePackageRecord`、`DESKTOP_PACKAGE_SET_FILE = 'desktop-packages.json'`、`DESKTOP_PACKAGES_DIR` | `apps/desktop/src/core-package-set.ts` | 每条记录 `name/version/file/bytes/integrity(sha512)`；重复 name 或 file 直接报错 |
| 私有 Host 包 | `DESKTOP_HOST_PACKAGE = '@deepseek-ai/dsh-desktop-host'`、`DESKTOP_HOST_RUNTIME_FILES = ['lib/index.js','lib/cli.js']` | 同上 | profile 启动前必须存在 |
| 发行目标 | `DesktopPackageTargetName = 'mac-arm64' \| 'mac-x64' \| 'win-x64'` | `apps/desktop/scripts/package-target.ts:50` | `win-x64` 要求 Windows x64 构建主机（:180），Linux 不能产出 Windows 安装包 |
| 整单元更新 | `electron-updater`、`update-coordinator` / `update-journal` / `mandatory-update-*` | `apps/desktop/src/`、`apps/desktop/package.json` | 复用官方整单元更新，不自建更新器 |

## 3. 会话输入

| 用途 | symbol | 位置 | 限制 |
| --- | --- | --- | --- |
| 追加输入 | `Agent.followup(message: UserMessage): void` | `packages/core/agent/src/runtime-types.ts:222` | 空闲时开启一轮；空闲后提交进入下一轮 |
| 转向输入 | `Agent.steer(message: UserMessage): void` | 同文件 :231 | 面向最近 step；空闲启动一轮，取消/释放可丢弃待处理转向 |
| 取 Agent | `AgentRegistry.get(id: SessionId): Agent \| undefined` | `packages/core/agent/src/index.ts:566` | 注册名 `agents`（declare 行 29）；返回裸 `Agent`，句柄只属于创建者 |
| 构造用户消息 | `createUserMessage(...)`（`@deepseek-ai/dsh-llm`） | `docs/cookbook/extension-cookbook.md` | 文档依据，源码未逐行核对 |

## 4. 事件

| 用途 | symbol | 位置 | 限制 |
| --- | --- | --- | --- |
| 持久会话事件 | `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void` | `packages/core/session/src/index.ts:74` | 逐监听器隔离异常；seed 事件不发布 |
| 轮次结束 | `'turn/end': { turn: number; reason: TurnEndReason }` | `packages/core/session/src/types.ts:297` | 持久事件，进会话日志 |
| Assistant 定稿 | `'assistant/message'` | 同文件 :341 | 持久事件；文本增量需另行展开 |
| 流式增量 | `'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void` | `packages/core/agent/src/runtime-types.ts:363` | 瞬态帧，不落日志 |

## 5. 审批

| 用途 | symbol | 位置 | 限制 |
| --- | --- | --- | --- |
| 服务 | `ctx.approval` — `ApprovalService` | `packages/interaction/user-approval/src/index.ts:26`、类 :150 | 只在打开的 turn 内可用（:219 显式报错） |
| 发起审批 | `request(req: ApprovalRequest): Promise<ApprovalOutcome>` | 同文件 :215 | 先写 `approval/asked`，后写 `approval/decided` |
| 请求结构 | `interface ApprovalRequest extends ApprovalRequestEvent` | 同文件 :111 | 只带 `agent/toolName/callId?/reason?/signal?`，不重复参数 |
| 结果 | `ApprovalOutcome = 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` | `docs/subsystems/approval.md` | 封闭且失败关闭；仅 `allowed-once` 放行 |
| 每会话策略 | `setApprovalPolicy(session, policy)`（:100）、`effectivePolicy(session)`（私有 :243） | 同文件 | `'ask'` / `'never'`；`never` 在 waterfall 之前直接 `rejected` |
| 应答者扩展点 | `approval/request` waterfall（`next()` 委托） | `docs/subsystems/approval.md` | 首个作出决定者占用唯一决策位 |

## 6. 取消

| 用途 | symbol | 位置 | 限制 |
| --- | --- | --- | --- |
| 取消 | `Agent.cancel(cause: AgentCancelCause, options?: CancelOptions): void` | `packages/core/agent/src/runtime-types.ts:183` | 首个 cause 生效；无活动时为空操作，不武装后续工作 |
| 保留待处理输入 | `CancelOptions.keepInbox` | 同文件 :37–54 | 缺省丢弃排队与转向输入并写取消拼接记录 |
| 释放句柄 | `AgentHandle.dispose(): Promise<void>` | `packages/core/agent/src/index.ts:160` | 停止循环、等待退出、注销、移除会话、展开作用域 |

## 7. 重启恢复

| 用途 | symbol | 位置 | 限制 |
| --- | --- | --- | --- |
| 恢复 Agent | `AgentRegistry.resume(ownerCtx, options: ResumeAgentOptions): Promise<AgentHandle>` | `packages/core/agent/src/index.ts:410`（工厂契约 :202） | 必须在 `ctx.sessionPersistence` 存在后调用；消费方需 `inject sessionPersistence` |
| 恢复参数 | `ResumeAgentOptions.resumeSessionId: SessionId` | 同文件 :~119 | 持久会话 id 即恢复后的身份；可选 `setup` 组合新作用域 |
| 持久化服务 | `sessionPersistence: SessionPersistence` | `packages/session/session-persistence/src/index.ts:113` | 注册名 `sessionPersistence` |

## 8. Client 面板

| 用途 | symbol | 位置 | 限制 |
| --- | --- | --- | --- |
| 槽位注册 | `register(options: ErasedOptions, component: unknown): () => void` | `packages/client/ui-slots/src/index.ts:1203` | 注册进未声明槽位、或声明已被他人占用的子槽，激活期失败 |
| 槽位注入 | `ctx.slots.inject(key, callback)` | `docs/subsystems/slots.md` | 回调按声明生命周期运行，随拥有者折叠移除 |
| 根槽位 | `'root'`（唯一内建）；`ui-renderer` 调 `renderSlot('root', {})` | 同上 | `ctx.slots` 由渲染器提供 |
| 主面板槽位 | `'main': { kind: 'keyed'; scope: 'root' }` | `packages/client/ui-layout/src/client/index.ts:73`；订阅 :203 | 组件经 `ctx.slots.entries('main')`、`subscribe('main', …)` 读取 |
| 选择主面板 | `ILayout.selectPanel(panelId: MainPanelId \| null): void` | `packages/client/ui-layout/src/client/service.ts:28–54` | 选中未注册 main key 直接抛错；`null` 回到会话视图 |
| 面板信息 | `panelInfo: HostObservable<PanelInfo>`、`usePanelInfo` | 同上 | 与 `usePanelInfo` 共用同一 root store |

## 未验证与待补

- `ctx.slots` 服务在 `ui-renderer` 中的注册名与类型未逐行核对（本清单只核对了 `register`/`inject`/`entries`/`subscribe` 的调用点）。
- `createUserMessage` 的签名与导出未在源码逐行核对。
- Studio 插件应进入核心包集还是 profile patch 层、以及如何默认启用并成为满窗主面板，尚未实现与验证。
- 会话恢复的真实过程（进程重启后 `sessionPersistence` → `resume` 的实际行为）尚未实测。
- 以上均须在最小切片中实测后回填，未实测项不得按已通过处理。

## 复现

```sh
cd .local/upstream/dsh
rg -n "followup|steer|cancel" packages/core/agent/src/runtime-types.ts
rg -n "session/event" packages/core/session/src/index.ts
rg -n "ApprovalService|request\(req" packages/interaction/user-approval/src/index.ts
rg -n "'main'" packages/client/ui-layout/src/client/index.ts
```
