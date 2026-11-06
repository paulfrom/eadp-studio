# 原型插件

通过 Shell 的 `eadp.prototype.view` 插槽提供 `原型/` 文件只读查看、随包模板创建，以及用户主动安装依赖、运行、停止和打开系统浏览器的入口。Host 的 `eadpPrototype` Remote 服务不向 Agent 注册执行工具。

每次文件操作核对原生 Workspace、路径 containment 与链接；隐藏依赖、构建产物、缓存、环境文件及密钥；超过 1 MiB、二进制或非 UTF-8 文件仅返回元数据。模板源仅为 `assets/prototype-template/` 和 manifest，校验完整清单及 SHA-256，只写不存在或空的目标目录，写入使用 exclusive-create，失败保留现场。

运行使用 `primary-runtime` 同级 `eadp-tools/runtime-manifest.json` 中固定 Node 22.22.3、pnpm 11.28.5，执行 `pnpm install --frozen-lockfile` 或 `pnpm run start`。不查找全局 PATH，不以开发机 Node 替代。安装可能执行依赖脚本，原型程序是用户授权的本机代码执行，不受 DSH 文件沙箱隔离。工具链发行准备在阶段 6 完成，缺少或不匹配时明确失败。

同一项目安装、运行、停止串行；安装状态与运行状态独立。启动时 Host 分配 loopback 端口，120 秒内 HTTP 可访问且自有 handle 未退出后才报告 running。日志仅本机内存保留总计尾部 200 KiB。停止使用官方 `terminate()` 和 `waitForExit()` 等待完整受管范围，失败保留 handle 供重试，不按端口结束未知进程。

Host → Typert → Client 顺序构建，公开 RPC 数据类型由 `@eadp/contracts/prototype` 提供。

当前仅允许静态验证，未执行桌面、真实模型、依赖安装或原型运行验收。官方 opaque `SubprocessHandle` 不暴露 PID 和 OS 进程创建时间，无法实现重启后的孤儿进程身份核对；`startedAt` 仅为 Host 启动请求时间，不是 OS 身份证据。插件通过 `ctx.effect` 释放资源，但缺少可靠桌面退出等待接口，不宣称退出闭环已验证。这些限制集中记录于仓库 `docs/blocked-upstream.md`。
