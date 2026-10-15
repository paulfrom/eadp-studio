# Windows 原生首启检查

在 Windows 开发机上，使用未配置账号或 Key 的全新应用数据启动实际打包 exe：

```powershell
node tests/windows-desktop/verify-studio-first-launch.mjs --exe 'D:\absolute\path\DeepSeek Harness.exe' --timeout-ms 120000 --screenshot
```

`--exe` 必须是实际 `win-unpacked` 或安装后的 exe 绝对路径。脚本使用官方 Electron `--user-data-dir`、`--remote-debugging-port` 与 DSH 数据目录变量，所有测试状态和日志保留在本仓库新建的 `.local/acceptance/studio-first-launch-*` 中；不复用旧 profile，不预置凭证，也不点击欢迎页的“稍后配置”。

脚本显示原生应用窗口，通过真实 CDP 将应用页面置前，检查 `dsh-app://app/` 中唯一且可见的 `data-studio-panel="studio"`，其边界须覆盖 `main` 槽位的实际布局容器（跳过上游 `display: contents` 包装，允许 2px 测量误差）；发现官方 Welcome 页面或超时即失败。结果写入 `result.json`，`--screenshot` 在绘制帧完成后另保存 `studio.png`，仍需目视核对截图。结束时仅终止本脚本启动且仍存活的应用进程树，保留测试数据与证据。

退出码 0 表示该首启 DOM 检查通过，1 表示失败。这是**开发机全新应用数据**检查，不代表干净机安装、签名、升级、卸载、共存或会话/审批/取消/重启恢复验收通过。

运行时依赖闭包的 Windows 集成回归：

```powershell
node --test tests/windows-desktop/desktop-plugin-runtime.test.mjs
```

前置是本机已完成固定源码获取、装配及 win-x64 的 `prepare:runtime`、`prepare:packages`、`prepare:dsh`。测试使用真实上游解析 API、准备好的 production 包与 Electron Node-mode Host，独立 profile 启动后自动 shutdown，不开启 GUI、不调用模型或账号；临时目录链接需要 Windows 符号链接权限。它验证源码到运行时解析闭包及 Host 发现，不代替最终 ASAR、安装后首启 DOM 验收。裸目录 Host 可经物理 Node 包查找掩盖缺失的声明依赖，因此必须继续检查真实 ASAR。
