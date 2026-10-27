# 原型技术选型与本地浏览器验证

状态：2026-10-26 技术设计草案，整体设计待用户最终确认；本文不表示依赖已安装、产品已实现或桌面已验收。
范围：成熟组件复用、代码编辑、受管浏览器、业务验证与证据；不升级固定 DSH，不启动或安装产品。
业务边界沿用[原型技术设计](technical-design.md)、[桌面运行时](desktop-runtime.md)及[协同契约](collaboration-contract.md)。

## 1. 当前基础与明确选择

优先复用既有框架、宿主会话和成熟编辑／自动化能力，不自行实现编辑器内核、DOM 定位、等待或浏览器自动化引擎。
下表区分当前依赖事实与本设计新增选择；锁定版本不等于本机、安装包或真实模型验证通过。

| 关注点 | 当前基础 | 本设计选择与新增成本 |
| --- | --- | --- |
| 原型页面 | React 18.3.1、Umi 4.6.53、SUID 2.1.62、antd-style 4.1.1、TypeScript 5.6.3。 | 沿用随包模板和组件，保持独立原型工程；不更换前端框架。 |
| 演示数据 | `requestMock` 浏览器内存 handler，精确 method/path 分派，未知请求拒绝。 | 保留现有机制；不是 MSW，不新增 Service Worker。 |
| 工具链 | 受管 Node 22.22.3、pnpm 11.28.5、Git 2.56.0.windows.2。 | 继续校验随包路径、版本和哈希，Host 使用参数数组与受控环境。 |
| 静态预览 | Node HTTP server 只服务 `dist`，绑定 `127.0.0.1`，检查 Host、路径与实例。 | 复用，不新增通用 serve、开发代理或远程业务 API。 |
| 协同后端 | Fastify、TypeBox、pg／PostgreSQL 已有。 | 沿用事务、唯一索引、幂等操作；不猜测指定远端 PostgreSQL 版本。 |
| 并行现场 | Git worktree 已有；协同设计采用 Git merge-tree。 | worktree 隔离文件，merge-tree 计算三方合并；不自研合并算法。 |
| 需求开发占用 | 协同契约定义持久 claim 与代次。 | PostgreSQL 唯一索引与事务原子领取；不引入 Redis TTL 锁替代业务占用。 |
| 代码编辑 | 当前 Studio／固定 DSH 未发现公开 Monaco 组件或依赖。 | 新增 CodeMirror 6，薄 React 组件承接状态、保存与差异。 |
| 自动浏览器 | Electron 已有私有保护检查；固定 DSH 有实验 browser-use runtime。 | 新增受限浏览器服务，内部用稳定 Playwright 1.61.1 与配套 Chromium。 |

模板版本来源为 [package.json](../../../packages/studio-plugin/assets/prototype-template/package.json)，工具链来源为 [runtime lock](../../../apps/desktop-distribution/build/studio-runtime.lock.json)。
后端依赖见 [collaboration-api/package.json](../../../apps/collaboration-api/package.json) 与 [contracts/package.json](../../../packages/contracts/package.json)。
根工程和模板 lock 当前没有 Playwright、Puppeteer 或 Monaco；固定 DSH 上游包含的测试／实验依赖不等于 Studio 已安装和启用这些能力。

## 2. 编辑器选型与保存边界

采用 CodeMirror 6 的 `state`、`view`、`commands`、`search`、`lang-javascript`、`lang-css`、`lang-json` 和 `merge` 模块。
JavaScript 语言模块开启 JSX／TypeScript 支持；CSS／Less、JSON 的实际语法覆盖在 POC 检查，不把语法着色称为完整语言服务。
React 层只管理 EditorView 生命周期、文件选择、文档版本、脏状态、保存及差异数据，不重新实现编辑、搜索或合并视图。
当前官方核实的 `@codemirror/view` 为 6.43.15、`@codemirror/merge` 为 6.12.3，许可证为 MIT；其余模块在实施时统一解析并提交精确 lock。
依赖不得在产品运行时解析 `latest`；完成模块兼容验证后，把实际完整版本和许可写入发行清单。
维护源码已迁至 [view](https://code.haverbeke.berlin/codemirror/view) 与 [merge](https://code.haverbeke.berlin/codemirror/merge)，不能将旧 GitHub 仓库归档解释为停止维护。

首期编辑能力包括语法着色、行号、搜索、撤销、选区、只读查看和真实文件差异；不承诺完整 LSP、跨工程重构或语言服务器诊断。
编辑器只能提交当前授权文件的内容和预期版本；Host 重新检查身份、事项、代次、真实路径、保护文件及写入范围，再执行保存。
前端可写状态、文件名或模型工具参数不授予文件权限；文件变化导致保存版本冲突时保留草稿并展示真实差异。
CodeMirror merge 用于人工阅读与编辑差异；Git merge-tree 仍负责项目成果三方合并，两者不互相代替。
新增成本包括模块包体、主题与键盘可访问性、React 生命周期、只读／脏状态和版本冲突验证，以及 MIT 许可清单。

## 3. Playwright 与专属 Chromium

选择 `playwright`、`playwright-core` 与 `@playwright/test` 1.61.1 同版本组合，复用 locator、expect、自动等待与 trace 等成熟 API。
产品浏览器服务只分发实际需要的运行部分；`@playwright/test` 用于维护验证和受控断言复用，不向 Agent 暴露任意测试代码运行入口。
Playwright 1.61.1 为 Apache-2.0，要求 Node >=18，配套 core 也是 1.61.1；现有 Node 22.22.3 满足声明范围，实际运行仍须验证。
配套 Chromium 与 headless-shell 固定 revision 1228、浏览器版本 149.0.7827.55，依据官方 [v1.61.1 browsers.json](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/browsers.json)。
有头 Chromium 供人工查看同一原型，headless 模式用于自动检查；两者均使用受管专属浏览器和同一隔离规则。
不依赖用户安装 Chrome，不在首次运行下载浏览器，不接用户浏览器配置或公共 `9222` CDP。

不原样挂载 `@playwright/mcp` 0.0.80：固定 DSH 该包装依赖 Playwright/core `1.63.0-alpha-2026-08-31`，与本设计稳定组合不同。
不为取得浏览器能力升级 DSH，也不把已有 Electron 可执行文件作为普通 Chromium `executablePath` 传给 Playwright。
Playwright 自带匹配 Chromium 可减少跨版本故障；不得据此声称任何 Electron／Chromium 版本都完全兼容。
[Electron 自动化](https://playwright.dev/docs/api/class-electron)仍为实验能力；[CDP attach](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)保真度低于 Playwright 自有协议，不能把临时连通当发行保证。

发行需新增浏览器 archive 来源、revision、平台架构、SHA-256、解包路径及文件校验，纳入受管 runtime lock 与 installer 产物清单。
安装包必须包含所需浏览器文件；校验失败明确阻止浏览器功能，不自动换版本、使用系统 Chrome 或偷偷下载。
必须验证 Windows 签名、杀毒扫描、安装／卸载、离线启动和包体增量；尚未实测，不虚报体积或安装结果。
Chromium 及其第三方许可、Playwright Apache-2.0 与 notices 随包分发，并记录升级和漏洞维护责任。
此次新增 runtime 属于明确的发行依赖变化，需独立完成固定版本 POC，再进入实现和安装包验收。

发布前依赖核对入口：

- [Playwright 1.61.1 官方包元数据](https://registry.npmjs.org/playwright/1.61.1)确认 engine、许可证与 core 版本。
- [playwright-core 1.61.1 官方包元数据](https://registry.npmjs.org/playwright-core/1.61.1)确认实际运行依赖。
- [@playwright/test 1.61.1 官方包元数据](https://registry.npmjs.org/@playwright/test/1.61.1)确认维护验证组合。

发行脚本只消费经审核的锁定元数据和哈希，不在构建或运行时自动跟随上述入口的新版本。

## 4. 复用宿主生命周期，限定原型能力

复用固定 DSH `browser-use-runtime` 的 `mountSessionMcp`、`SessionResources`、stdio-MCP，以及 Session、工具和附件生命周期。
在受维护的 `apps/desktop-distribution/build/` 装配代码及 Studio 原型适配层接入一个专用受限浏览器服务；不修改 `.local/upstream` 冒充维护成果。
服务内部调用 Playwright 成熟 API；MCP 只承载受限命令、结果和附件，不另造 DOM 选择器协议、轮询等待或浏览器控制引擎。
现有上游 wrapper 仍是实验 API，固定版本的创建、恢复、取消、释放和附件 POC 通过前，不能称为可交付能力。

浏览器按需创建，原型会话可离线打开和继续讨论，不以浏览器初始化成功作为会话创建／恢复的强制条件。
未创建浏览器时，检查状态明确返回“未运行”；用户要求验证时再由 Host 启动，失败返回实际诊断并保留工程现场。
Host 发放的 scope 绑定 user、validationRunId、所属原生会话、previewGeneration、buildHash 和当前精确 loopback origin。目标使用互斥类型：任务现场绑定 prototypeTaskId／taskGeneration；已接受快照绑定 baselineId／commitSha，不包含写任务 token 或开发 claim。
无事项时也可检查已接受成果，使用独立只读源码快照和验证 run，页面合成数据仍可操作；不为自动浏览器创建可写事项或领取需求。纯只读运行证据按基线／run 归档，有任务时按事项／run 归档。
服务每次调用重新验证 scope 与当前预览归属；客户端、模型或历史消息不能指定这些值来获得权限。
任务切换、工程构建变化、预览重启、验证 run 取消、任务结束、退出或恢复均使旧能力失效；重新验证后才生成新能力。
不同任务或只读基线 run 拥有不同浏览器上下文、预览实例和证据目录；cookie、localStorage、下载、页签与工具引用不得串用。
重启后恢复事项和对话，不恢复旧 target 或活令牌；需要浏览器时按当前构建重新创建。
浏览器服务异常不得静默转到公共浏览器或新的 provider；如实记录本次验证失败，用户仍能继续原型讨论和已授权编辑。
服务进程、Chromium 子进程和预览进程分别由所属验证 run 管理，关联任务或只读基线来源；释放要等待进程树退出，不能只清理前端引用。
人工查看使用同一受管预览构建与围栏；是否由自动化继续接管须检查当前 generation，避免人机操作混用旧引用。
自动化执行期间的人工修改应产生可解释的断言失败或中断，不能用隐藏重试掩盖页面状态变化。

允许的工具是明确的小集合：

- 以 role、label 或 testId 定位，再执行 click、fill、select、key。
- 对可观察状态执行 wait、assert，输出对应预期和实际结果。
- 读取受限 DOM／可访问性 snapshot、截图、console、pageerror、network 与 trace。
- 打开 Host 已分配的原型路由，并关闭当前事项所属预览能力。

禁止 raw `run_code`／evaluate、安装依赖、任意 CDP 地址、任意 target 选择、file URL 和任意文件上传下载。
不得通过通用执行入口绕过受限工具；业务附件场景只使用维护者核准并由 Host 分配的合成样本能力。
原型 execution guard 仅显式允许持有有效 scope 的上述工具，不能放行整个 `mcp__*` 命名空间。
现有 [execution-guard.ts](../../../packages/studio-plugin/src/host/adapters/platform/execution-guard.ts) 第 100 行默认拒绝非控制／文件工具；实施必须同步这道授权边界。

## 5. 导航前安装网络围栏

新 Chromium 不继承 Electron session 的 `webRequest`；不能把原保护检查的规则当作新浏览器已经具备的隔离。
Host 创建上下文后，先安装默认拒绝规则和事件处理，再创建／使用 target，最后导航；任何步骤失败都关闭上下文。
只允许当前 scope 的精确 `http://127.0.0.1:<port>` origin 静态资源；路径和文件仍受预览 server 校验，不放开全部 localhost。
拒绝外站、跨 origin 重定向、其他 localhost 端口、WebSocket、Service Worker、iframe、权限请求、弹窗及下载。
新 target、重导航和请求重定向也逐次验证；不能只校验首次导航 URL。
拒绝访问身份页面、协同服务、开发工具端口和 file URL；浏览器拿不到 Host API、真实凭据或用户浏览器状态。
预览仍发送现有 CSP，页面仍安装 prototype guard，保持 handler 精确分派和未知请求拒绝。
这些规则属于多层应用约束，CSP、页面 guard、MCP 参数均不等于操作系统级防火墙。
[Playwright MCP 安全说明](https://github.com/microsoft/playwright-mcp#security)明确其不是安全边界，origin 参数不能代替可信 Host 约束。
必须用实际监听 sink 验证允许和拒绝路径，记录监听地址、尝试、浏览器拒绝事件及 sink 实际收到的请求数。
没有测到的协议、重定向、target 或浏览器版本路径明确列为未验证，不声称绝对隔离。

## 6. Mock、安全检查与业务检查分别记录

当前 [runtime.ts](../../../packages/studio-plugin/assets/prototype-template/src/mock/runtime.ts) 第 28 行起在内存精确调用 handler，不产生真实业务 HTTP 请求。
[prototype-guard.js](../../../packages/studio-plugin/assets/prototype-template/public/prototype-guard.js) 第 10 行起禁止直接网络及 Service Worker 注册，故本设计保留它而不接 MSW。
应用 [app.tsx](../../../packages/studio-plugin/assets/prototype-template/src/app.tsx) 等待 initializeMock 后再渲染；未就绪时不能继续业务验证。
内存数据的保存和刷新恢复须如实写进用例；不能把合成数据当后端持久化，也不能伪造 Mock API HAR。
network 证据记录静态请求和被拒绝的请求；业务结果通过页面可观察状态和断言证明，必要的 handler 诊断只能由维护者提供受控入口。

保留 [Electron 保护检查](../../../apps/desktop-distribution/build/studio-browser-check.ts)：独立 session、Mock ready、未知请求和网络负向探针。
其现状只返回检查摘要 hash，页面非空不能证明业务正确；新增 Chromium 检查不得悄悄改变该检查的含义。
分别记录 Electron 保护检查、Chromium 业务流程检查和真实 Electron 桌面闭环，各自注明通过、失败或未运行。
三者绑定同一源代码、静态产物和 Mock 版本；修改后须重新判断证据有效性。
Chromium 可以证明该静态原型在所测浏览器的业务表现，不能替代 Electron 内实际业务交互、原生会话、Host 和协同持久化的桌面验收。
业务用例从实际需求验收和补充边界派生；不是把所有可能业务测试变成每次原型对话或确认的强制门禁。

## 7. 本地浏览器验证的完整示例

示例假定需求实际包含订单必填、金额计算、保存、详情、取消、失败保留输入及跨供应商审批；不向没有这些规则的项目强加相同测试。
Host 固定当前事项、候选源码、构建和 Mock 版本，用受管 pnpm 冻结安装，执行 typecheck、lint、build 并记录退出结果。
复用 [startPrototypePreview](../../../packages/studio-plugin/src/host/prototype/preview.ts) 启动静态 server，验证实例 ready；这一步仅证明服务就绪。
创建受限浏览器并装围栏，导航 Host 分配的订单路由；等待 Mock ready 和“新增订单”等真实业务定位元素。

| 操作 | 明确预期 | 需要留下的实际证据 |
| --- | --- | --- |
| 空表单点保存 | 必填提示出现，未新增订单。 | expect／actual、提示 DOM、截图及列表数量。 |
| 补供应商、数量和金额 | 按需求完成字段校验与金额计算。 | 输入值、计算结果和对应断言；边界值来自实际规则。 |
| 保存后打开列表和详情 | 新订单可定位，列表与详情关键字段一致。 | 新行、详情 DOM、关键值和保存后截图。 |
| 编辑后取消 | 保留原值，不写入取消的修改。 | 编辑前后详情与列表断言。 |
| 模拟保存失败 | 显示明确错误，当前输入保留，可重试。 | 失败提示、仍在的输入、console／pageerror 及重试结果。 |
| 跨供应商审批导航 | 可从相关入口抵达正确订单／审批，关系和状态符合需求。 | 路由、供应商／订单关系、允许操作与状态断言。 |

验证同时采集每步 console、pageerror 和 network blocked；预期的拒绝探针单列，不能将它与意外业务错误混在一起忽略。
每步输出测试 ID、操作、预期、实际、通过／失败及证据引用；超时或未定位到元素按失败／未运行如实返回，不用截图猜测成功。
截图由 Host 分配输出位置并交附件 store，模型通过原生图片结果实际消费后才可声称“看过页面”。
不支持图片的模型路线明确说明“未看图”，仍可读取 DOM／断言；不得把收到附件路径等同于视觉审查。
失败保留输入、trace 和现场供用户查看或继续修复；取消时释放浏览器与预览进程，工程和唯一草稿按既有状态保护规则保留。

## 8. 持久证据与过期规则

证据 manifest 记录 user／验证 run／原生 Session、任务及代次或只读 baselineId／commitSha、预览代次、源码 SHA／输入 hash／buildHash、模板及 Mock 版本。
同时记录 Playwright/core、Chromium revision／版本、Electron／产品版本、平台架构、开始结束时间、用例来源和实际执行范围。
附件包括步骤截图、DOM／可访问性快照、断言、console／pageerror、静态网络与拒绝日志、trace、sink 结果及其 SHA-256。
使用 [Playwright tracing](https://playwright.dev/docs/trace-viewer) 复用成熟快照与时序诊断；trace 可能含页面数据，保存范围和访问权限由 Host 控制。
摘要指向实际可读附件，不能只存“通过”或一个无法追溯的结果 hash。完整证据保存于本机账号／项目／事项隔离的受管诊断目录，独立于工作树，接受后清理现场不自动删除仍被引用的证据。协同后台只保存有限检查摘要、来源标识及 hash；截图、trace、DOM 和日志不进入控制数据库，也不混入仅允许原型源码改动的 Git 候选。证据缺失或不可读如实显示，不以旧 hash 保持“可核实通过”。
源码、构建、Mock、测试集合或浏览器组合变化后，相关证据标记过期并说明差异；仅重新打开页面不能恢复旧通过状态。
未执行、取消、超时和未覆盖分别记录，不用聚合绿灯掩盖局部缺口；诊断详情在输出／诊断入口展示，不占业务操作主界面。

## 9. 最低 POC 与交付边界

以下六项属于新能力的最低技术验证，结果应提供命令、版本、样本和实际附件，不能由静态设计代替。

1. 真实业务用例：在同一固定产物完成第 7 节适用流程，locator／expect／截图／trace 可追溯，并区分 Electron 保护检查结果。
2. 两任务隔离：并行事项各自预览、工具 scope 和状态独立；串用 scope、target、附件或其他 loopback 端口被拒绝。
3. 恶意负向 sink：真实监听验证外站／重定向／其他端口／WS／SW／iframe／弹窗／下载等拒绝路径，并列出未测路径。
4. 取消和恢复：取消／预览重启／构建变化后旧能力立即无效；对话可离线恢复，按需创建新浏览器，不复用旧活状态。
5. 干净机离线：安装包自带受管 Chromium，在无用户 Chrome、无首次下载条件下启动；记录签名、杀毒、许可证及真实包体增量。
6. 截图进原生模型：图片由附件 store 进入真实原生会话，支持图片的模型完成可核对的页面观察；非图像路线明确“未看图”。

POC 通过只允许确认该固定技术组合可实施；正式交付仍需当前安装包、真实 Electron 业务桌面和指定协同服务的完整闭环。
本文未实施依赖、浏览器服务、编辑器或 runtime lock，也未执行上述 POC；不能据此报告原型功能完成或生产就绪。
