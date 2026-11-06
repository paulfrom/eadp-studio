# eadp-prototype：原型文件、运行与系统浏览器

状态：目标设计，尚未实施。入口见 [方案总览](../README.md)；总体边界见 [architecture.md](../architecture.md)；权限见 [permissions-runtime.md](../permissions-runtime.md)。

## 1. 职责与边界

原型是项目根 `原型/` 下的普通代码工程。首版只支持随包模板约定的工程（Umi/React/SUID 模板，`package.json` 有 `start` 脚本和 pnpm 锁）；不引入任意命令 runner、静态 HTML/Vite 多模式或通用执行配置。

本包负责：

- `原型/` 文件树与只读文本查看（过滤依赖/构建/敏感文件、大小上限）。
- 从随包模板创建 `原型/`，不覆盖非空目录；不自动安装依赖。
- 用户点击后的依赖安装、运行、停止、日志、运行状态、loopback URL。
- 系统浏览器打开 Host 产出的 URL。
- 与 Shell/requirements/knowledge 的窄合同；不实现需求存储、代码提案、自动验收、发布、Git、基线。

不负责：需求/CONTEXT 写入、模型/会话、知识、Git 提交、任务/占用/候选/复用、内嵌画布、自动浏览器检查、截图/证据流水线。

## 2. 目录与文件

```text
<Workspace.path>/原型/
  package.json
  pnpm-lock.yaml
  src/
  public/
```

- 创建：用户点击“创建原型工程”；Host 从随包模板复制到 `原型/`。目标必须不存在或为空；非空不覆盖，显示实际文件。
- 文件查看：`ctx.fs.listDir/readText/stat`；只读；只显示普通文件/目录；过滤 `node_modules/`、`.git/`、`.umi*/`、`dist/`、`.env*`、`*.pem/key/pfx/p12`、日志/缓存；显示“已隐藏”说明。
- 文本上限 1 MiB；超过截断/拒绝并提示；二进制/非 UTF-8 显示元数据，不伪造文本。
- 路径：相对 `原型/`；Host 用 Workspace root + `contains` 校验；拒绝 `..`、绝对路径、链接逃逸；不信任客户端根路径。
- 刷新：切回原型页/手动刷新/运行前；不做隐式写入。

## 3. 接口

```ts
type PrototypeEntry = { path: string; name: string; type: 'file' | 'directory'; size?: number }
type PrototypeContent = { path: string; text: string; truncated: boolean; size: number }
type RunState = {
  workspaceId: string; status: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  url?: string; port?: number; pid?: number; startedAt?: string; error?: string;
}
type RunLog = { items: Array<{ stream: 'stdout' | 'stderr' | 'host'; text: string }>; truncated: boolean }
```

| 方法 | 输入 | 输出/行为 |
| --- | --- | --- |
| `listFiles(workspaceId,directory)` | 相对目录 | 一层或递归有界 entries；过滤规则 |
| `readFile(workspaceId,path)` | 相对文件 | 文本/截断/大小；非文本错误 |
| `createProject(workspaceId)` | — | 模板复制到 `原型/`；非空/失败保留现场 |
| `install(workspaceId)` | — | 用户动作；固定 pnpm；`--frozen-lockfile`；返回状态/日志 |
| `start(workspaceId)` | — | 用户动作；启动受管进程；返回 `starting`，就绪后 `running` |
| `stop(workspaceId)` | — | 停止自有进程树；返回 `stopping/stopped/failed` |
| `status(workspaceId)` | — | 当前状态；不持久化 running |
| `openBrowser(workspaceId)` | — | 只返回当前 running 的 loopback URL；客户端打开 |
| `logs(workspaceId)` | — | 有界 stdout/stderr/host 诊断 |

- 同一 Workspace 串行 start/stop；并发 start 合并；同一 Workspace 最多一个运行。
- 状态以 Host 进程表为准；重启后为 `stopped`，不读上次 `running` 字段。
- 日志不进入需求正文、不发送给模型；默认保留尾部 200 KB。

## 4. 创建与依赖

### 4.1 模板

- 模板资产移到 `packages/eadp-prototype/assets/prototype-template/`（连同 manifest、独立锁文件）；发行沿用已验证的归档/解包/manifest 校验，避免 npm 过滤 `.env.example`/`.npmrc` 等文件。
- 模板保留 `start: umi dev --host 127.0.0.1` 与业务 Mock 资源；删除 `scripts/preview.mjs`、`__eadp_preview_ready`、synthetic-only 检查/自动验收脚本。
- 不更换 Umi/React/SUID 技术栈；模板仍需独立验证自身工程。
- 创建时校验目标空目录、模板文件完整；不复制 `node_modules`/dist/缓存。

### 4.2 安装

- 用户点击“安装依赖”；Host 用固定 Node/pnpm（发行运行时 `eadp-tools`）在 `原型/` 执行 `pnpm install --frozen-lockfile`。
- 失败保留工程、锁文件、日志；不自动改锁、不自动升级、不静默重装。
- 安装可能执行依赖脚本；用户点击即授权。该执行不受 DSH 沙箱限制，如实说明。
- 安装与运行分别报告结果；不构造任务状态机。

## 5. 运行

### 5.1 启动

- 用户点击“运行”；Host 检查工程约定（`package.json` + `start` + pnpm 锁）；不执行任意命令。
- Host 选空闲端口（bind 后释放），注入 `PORT`/host；cwd 固定 `原型/`；环境最小化（不继承无关全局变量）；固定 Node/pnpm。
- 执行 `pnpm run start`；有界输出；捕获子进程退出。
- 若模板/版本忽略 `PORT`，解析 stdout 中首个 `http://127.0.0.1:<port>`/`localhost` URL；只接受 loopback 与有效端口。
- 就绪：子进程未退出 + HTTP 可访问 + URL 属于本次启动；超时建议 120 s。失败 → `failed` + 日志 + 可执行重试；不打开其他程序的页面。
- 运行成功只表示可访问，不表示业务验收。

### 5.2 停止与归属

- 进程身份：workspaceId、pid、进程启动时间、端口、命令摘要；Host 只停止自己启动的进程树。
- 停止：先正常终止（Windows 用 Job Object/`taskkill /T` 等等价受管机制），超时后强制；等待退出；不按端口杀未知进程。
- 停止失败：保留 `stopping/failed`、pid/日志与重试；不谎报 stopped。
- 应用退出：停止所有本应用进程；运行状态不持久化为 running。
- 强杀/断电：可能留下孤儿；在应用数据目录写最小运行记录（pid/启动时间/端口/workspaceId）。下次启动只对“pid + 启动时间匹配”的旧进程提供“停止上次运行”；不接管不匹配进程。
- 一个 Workspace 最多一个运行；切换项目不静默停止旧项目，UI 显示运行归属/端口；用户可以停止。

### 5.3 系统浏览器

- Host 只返回本次运行、已核验的 loopback URL；客户端 `window.open(url,'_blank','noopener,noreferrer')`。
- 不在应用内嵌 WebContentsView/画布；不打开模型/用户提供的任意 URL。
- 打开失败保留运行状态与 URL，允许重试；不因此停止进程。
- `window.open` 依赖固定 desktop 主窗口的外开行为，登记在仓库缺口清单（当前 `docs/blocked-upstream.md` 缺失，见 README 第 6 节）；上游变更时改用官方接口或明确失败。

## 6. AI 修改原型

- 原型会话 preset `eadp-prototype` 注册 `tool-fs` 的 read/write/edit 与 read_image/glob/grep；不注册 shell/subprocess/run_code/MCP/插件工具。
- guard 用真实 session cwd 绑定 Workspace，write/edit 只允许 `原型/` 下相对路径；拒绝 `原型/node_modules/**`、`原型/.git/**`、`原型/.umi*/**`、`原型/dist/**` 等保护路径；拒绝需求/CONTEXT/其他项目/绝对路径/链接逃逸。
- fs-sandbox 再把写限制在项目根；两层叠加，不靠 cwd/提示词。
- 原型 AI 可通过 requirements 工具读取需求、通过 knowledge 工具读取知识；它不能写这些文件。
- 原型 AI 不提供代码提案/审阅/基线；修改直接落盘，用户在文件页/运行页查看。不承诺自动回滚；用户可让 AI 或外部编辑器修正。
- 运行与安装不是 Agent 工具；AI 不获得执行权限。

## 7. 失败与恢复

| 情况 | 行为 |
| --- | --- |
| `原型/` 非空 | 不覆盖；显示实际文件；创建按钮禁用/隐藏并说明 |
| 依赖缺失 | 运行前提示安装；安装失败保留工程与日志；不自动重装 |
| 端口占用 | 重新选端口或失败；“重新运行”先停旧进程；不打开他人页面 |
| 启动超时/进程退出 | `failed` + 日志 + 重试；不显示 running |
| 浏览器打开失败 | 保留 running + URL；重试；不停止进程 |
| 停止失败 | 保留进程身份/日志；可重试；不杀未知进程 |
| 退出/强杀 | 正常退出停止自有进程；重启 stopped；孤儿按记录识别，可停止 |
| 文件读取失败 | 保留上次内容并标记可能过期；不伪造内容 |
| AI 越界写 | guard 拒绝；目标不变；显示原因 |
| 运行失败后重试 | 保留上次日志；新一次运行单独记录；不覆盖工程 |

## 8. 当前代码去留

**复用/抽取**

- `host/adapters/platform/runtime.ts` 的受管进程原语：manifest/环境/PATH 隔离/超时/输出上限/停止；抽取为 prototype 的小型 supervisor，去掉 studio 任务身份。
- `host/prototype/files.ts` 的路径约束、敏感文件过滤、扫描/大小限额、分页思路；改用 `ctx.fs`。
- `host/prototype/template.ts` 的 manifest 校验/复制；移动资源路径。
- `host/prototype/output.ts` 的有界输出/诊断思路。
- `PrototypeFiles`/`PrototypeDirectoryTree` 的只读展示结构；剥离任务/基线/写入/画布依赖。
- `PrototypeWorkbench` 的安装/运行/停止/日志布局可参考；删除队列/候选/复用/检查。

**删除**

- `prototype/preview.ts` 的 synthetic preview/实例就绪/`dist` 绑定；`checks.ts`、`generation.ts`、`check-journal.ts`、`build-workspace.ts`、`publication.ts`、`snapshot.ts`。
- `browser-provider/scope/runtime/attachments`、`browser-check`、`desktopPreviewCanvas`、`studio-prototype-bridge/view`、`prepare-studio-browser`、`studio-browser.lock`、Chromium 资源与 `playwright-core`。
- `PrototypeCanvas`/`PrototypePreview`/`PrototypeEditor` 的嵌入预览与编辑；`PrototypeQueue`/候选/集成/基线/复用/发布。
- Git worktree/任务占用/自动检查/自动浏览器验收/SSH 发布。
- 模板 `scripts/preview.mjs`、`__eadp_preview_ready`、synthetic-only 资源围栏（若仅服务旧预览）。

## 9. 实施顺序

1. 与 Shell 约定 `原型/` 与 Workspace 上下文；确认模板资源迁移路径。
2. 抽取受管进程原语与运行记录；实现文件 list/read（只读）。
3. 模板创建、安装、运行、就绪、停止、日志、系统浏览器。
4. 接入原型页；删除旧画布/浏览器/检查/队列/候选/发布调用链。
5. 接入原型 AI guard（与 Shell/requirements 协作）；完成反向验收。
6. 更新模板 manifest、`pnpm check` 路径、发行装配。

## 10. 验收

真实桌面：

1. 创建原型（空/非空）；查看文件（大文件/二进制/隐藏敏感/越界/链接）。
2. 安装依赖（成功/失败/缺锁）；运行（成功/端口冲突/依赖缺失/超时/崩溃）；浏览器可操作；停止（正常/失败/重复）；切换项目/关闭应用；重启；孤儿识别。
3. 原型 AI：修改 `原型/` 成功；需求/CONTEXT/其他项目/保护目录/链接/shell/run_code/MCP/子 Agent 被拒；目标不变；页面反映修改。
4. `pnpm check` + 受影响构建；不新增测试代码。

以上尚未执行；启动脚本通过不等于桌面验收。
