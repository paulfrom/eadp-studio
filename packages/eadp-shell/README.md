# 本地工作台 Shell

`@eadp/shell` 复用 DSH Workspace 作为项目身份，组合需求、原型、知识库 slot，并承载官方原生会话。Host 使用 `eadpShell` Typert 命名空间，Client 不读取本地文件。

阶段 1 提供工作台骨架与会话策略。当前 guard 拒绝全部文件写入，原型写入策略在后续阶段接入；不注册 shell、子 Agent 或原生搜索工具。需求与原型 preset 使用官方声明式 Agent preset。

源码通过发行维护入口装配到固定 rc.2 工作区，`build/dependencies.json` 列出装配时注入的官方依赖，Host 构建后生成 Typert Remote，再构建 Client。`build/tsconfig*.json` 是装配位置的配置，不在源仓库伪造官方 workspace。

桌面退出前异步 flush 缺少上游公开接口，见 [缺口登记](../../docs/blocked-upstream.md)。本包没有私有退出 IPC 或主窗口补丁。静态验证通过不等于桌面验收通过或生产就绪。
