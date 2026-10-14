# Studio plugin

本包承载后续 DSH Host/client 插件。当前已导入 `assets/prototype-template/` 源码快照、具体 `AGENT.md` 及同级文件清单；规则加载与执行保护仍待验证，尚无插件入口、构建或宿主运行实现。

Host 应用服务及能力接入落在 `src/host/`，Studio 页面落在 `src/client/`，随对应 G0 任务创建实际文件。模板保留自己的依赖、锁定和运行规则，不作为根 workspace 子包安装。生成的用户业务原型不放入本包。
