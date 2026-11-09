# 固定宿主接口缺口与阶段门禁

2026-11-08 静态核查。宿主固定为 `apps/desktop-distribution/release.lock.json` 中的 DSH `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；只读缓存 `.local/upstream/`，不修改。本登记只描述当前源码事实与阶段门禁，不代表实现或桌面验收通过。

## 阻塞目标实现

### blocked-upstream：embedding 接口缺失（阶段三前置 S4 失败）

- 事实：`packages/llm/*` 的公开面只有对话调用 `ctx.llm.stream(...)` / `prepareCall(...)` 与对话模型选择 `ctx.agentDefaultModel.currentSelection()`；没有 embedding 方法、结果类型、维度元数据，也没有可注册的 embedding adapter seam（`LlmAdapter` 只描述 chat 协议，`ModelModalityMap` 只有 `text`/`image`）。全量搜索 `embedding|embed(|vector` 无相关 API。
- 影响：阶段三「向量混合」无法在公开接口上交付，因此不启动阶段三；阶段一与阶段二的词项、精确通道照常实施。
- 当前绕过：无。不得由插件自建 HTTP 客户端冒充官方接入，也不得修改 `.local/upstream/` 或新增未登记的锚定编辑。需要上游提供：embedding 调用方法、向量结果类型（Float32/维度/usage）、embedding 模型能力与维度元数据、embedding 专用模型选择与凭据解析。
- 若后续评审决定走 `apps/desktop-distribution/build/` 锚定编辑，须按该目录 README 的 fail-closed 锚点、登记与真实桌面验证要求执行，并重新核对源码事实。
- 复核（2026-11-08，阶段三开工前）：固定 `0.2.1-rc.2` 的交付装配树 `.local/build/local-workbench-dsh` 中 `packages/llm/llm/src/index.ts`、`types.ts`、`llm-pi-ai/src/adapter.ts`、`llm-deepseek/src/models.ts` 与只读缓存逐字节一致（sha256 相同）；`LlmAdapter` 仅 `abstract stream`（`llm/src/index.ts:302`），`LlmRuntime` 无 embedding 方法或结果类型；`ModelModalityMap` 只有 `text`/`image`（`llm/src/types.ts:231-233`）；官方工具目录无 embedding/向量工具；全仓 embedding 模型 API token 命中 0（上游 `packages`/`apps`/`python` 源码树；23 处 `embedding` 均为 iframe/框架嵌入等无关注释）。配置事实：隔离验证环境 `settings.yaml.imported` 与真实 `.dsh/settings.yaml` 字节一致，唯一供应商 `llm-pi-ai/magpie`（`openai-completions`）共 26 个模型且全部 `input: [text, image]`，无 embedding 模型、维度或专用模型选择。证据：`.local/verification/knowledge-phase3/logs/s4-embedding-evidence.txt`。
- 决定（2026-11-08，Lead）：按 S4 失败处理，**阶段三不启动**；不采用插件自建 HTTP/直连供应商，也未授权锚定编辑新增 embedding 接入。重新进入条件见 `.local/verification/knowledge-phase3/REPORT.md` §9。

### 已知交付缺口（非上游，按决定后置）

- 阶段二：`docs/design/local-knowledge/README.md:193` 的“从资料页或本次参考选择‘作为需求依据’”未实现（“本次参考”没有条目清单，也没有采用入口）。2026-11-08 Lead 决定登记后置，不纳入阶段三；入口仍为 `.local/verification/knowledge-phase2/REPORT.md` §7.1-1。

### 阶段二开工前必须由本仓补齐的插件间接口（非上游缺口）

- `agent/pre-step` 本身是公开 waterfall（`packages/core/agent/src/runtime-types.ts` 的 `PreStepDecision` 与 `agent.ts` 调用点），机制可行；但「当前需求」目前只在 `packages/eadp-shell/src/host/active-document.ts` 与 session-policy 的私有闭包里，没有公开读法。
- 处理：阶段二开工时在 `packages/eadp-shell` 增加公开只读方法或 cordis 事件，并在 `packages/eadp-knowledge/cordis.patch.yml` 显式声明对应 service；不得直接读取 `ActiveDocuments` 内部实现。此项未完成前不宣称自动参考可交付。

## 官方接口的已知限制（无需上游修改，按现有公开面处理）

| 缺口 | 处理边界 / 当前绕过 |
| --- | --- |
| Client 侧没有公开的“选择文件”服务，只有目录选择 | 插件自己的渲染层放 `<input type="file" multiple>` 与面板内拖放读取字节；不请求上游补 |
| 拖放没有公开 API | 插件在自身面板范围内监听 drop，并 `preventDefault`/`stopPropagation`，不全局吞掉会话附件拖放 |
| `ctx.fileUpload.upload` 必须绑定 Session，且按会话暂存 | 知识导入不绑定会话，使用插件自己的 Host Remote 与 `<应用数据>/knowledge/` 存储，不复用 file-upload |
| Typert Remote 参数只能是 JSON，`Uint8Array` 只允许作为单值返回 | 导入文件以 base64 字符串传给 Host；读取图片资源用 `Promise<Uint8Array>` 返回 |
| 内置知识的原始整理卡没有随包原件 | 只保存整理正文与真实外部出处，不虚构原件、页码或“原文”身份（阶段一已按此实现契约） |
