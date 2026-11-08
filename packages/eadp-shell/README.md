# 本地工作台 Shell

`@eadp/shell` 复用 DSH Workspace 作为项目身份，组合需求、原型、知识库 slot，并承载官方原生会话。Host 使用 `eadpShell` Typert 命名空间，Client 不读取本地文件。

Shell 提供工作台骨架、活动需求登记与会话策略。需求角色只允许读取与提案；原型角色的 write/edit 限于 `原型/` 源文件，并在解析目标后复核范围；不放行 shell、子 Agent 或原生搜索工具。需求与原型 preset 使用官方声明式 Agent preset。

桌面组合的目录选择只有原生 picker，不提供 picker 的 browse 创建能力，因此新建项目的目录由 Shell Host 的 `createProjectDirectory` 创建，不依赖 `uiWorkspace.createDirectory`。新建项目成功后自动创建并选中一个需求会话；会话创建失败时保留已建项目并显示错误。

需求会话先读取需求与业务材料，再检索知识目录并读取相关知识正文，形成结论或修改提案时说明实际采用的出处与适用范围。标签、标题和搜索摘要不能替代正文；知识缺失或读取失败须如实说明，不据此新增业务门禁。该行为由原生会话策略引导，实际工具调用与模型效果仍需真实桌面验证。

源码通过发行维护入口装配到固定 rc.2 工作区，`build/dependencies.json` 列出装配时注入的官方依赖，Host 构建后生成 Typert Remote，再构建 Client。`build/tsconfig*.json` 是装配位置的配置，不在源仓库伪造官方 workspace。

桌面退出前异步 flush 缺少上游公开接口，见 [缺口登记](../../docs/blocked-upstream.md)。本包没有私有退出 IPC 或主窗口补丁。静态验证通过不等于桌面验收通过或生产就绪。
