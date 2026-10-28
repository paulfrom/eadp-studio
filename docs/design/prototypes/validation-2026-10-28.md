# 原型遗留问题修复与验证记录

日期：2026-10-28。范围：`implementation-issues.md` I01—I15。远程同步从 `60979b0` 快进至 `origin/main` 的 `68f269c`；原有未提交成果以 Git stash 临时保护后恢复，唯一原型工作台冲突保留远程新增流程并删除已失去适用位置的旧修改。当前验证对象包含未提交修复，不能只用 HEAD 重现。未推送、未部署。

## 已修复及证据

| 范围 | 本轮结果 | 验证及限制 |
| --- | --- | --- |
| I01、I05、I14 | 修复固定宿主 inbox 接口误用，按实际 nextTurn／nextStep 队列判断空闲；补项目事项恢复、未知消息查询、不重发及恢复后范围越界拒绝用例。 | 本地恢复回归通过；真实模型消息耐久、取消收敛、关闭 flush 和重启闭环仍待固定宿主验证。 |
| I02、I03、I06、I10 | 修复项目基线身份、取消依赖、可选参数及类型收窄错误；同步测试到项目事项／基线协议，保留材料及交接正向覆盖。 | 当前 Host/client 类型检查通过；人工／AI 并发写入、编辑器中文输入及异常关闭仍待桌面操作。 |
| I04 | 核验 Git 源码包摘要和维护者签名；增加 Compose 总资源边界及临时目录限制。 | [供应链记录](../../../apps/collaboration-api/git-verifier-supply-chain.md)、[签名复现](../../../apps/collaboration-api/git-verifier-signature-verification.md)。没有 Docker，未验证 Linux 限额执行／崩溃清理、最终镜像摘要或跨平台合并一致性。 |
| I07、I15 | 新增无需数据库的恢复权限及状态回归，覆盖完整 claims／操作身份、跨作者拒绝、aborted pending、管理员权限和纠正树检查。另复现无本地改动同步只移动 HEAD、未更新材料字节的问题，修复及真实 Git 回归随本轮交付。 | 新增后台 13 项全部通过；数据库事务、晚到 push 及真实管理员纠正仍待目标环境验证。 |
| I08 | 保存有界进程诊断及截断提示，历史检查按源码／产物／规则／工具指纹诊断失效；重启遗留运行项标中断；修复 Node 导入内嵌模块时静态加载 Electron。 | 日志／重启／失效回归及普通 Node 的真实 HostProcess 导入回归通过；不增加业务门禁。未验证原生视图 DPI、焦点及模态遮挡。 |
| I09 | 两个固定归档取得真实 SHA，装配及完整运行时认证通过；实际启动两个浏览器、页面点击和截图成功。生产构建强制携带浏览器；补齐解压脚本直接依赖。 | [运行时明细](../../../apps/desktop-distribution/build/studio-browser-runtime.md)。未形成当前版本安装包；最终许可／分发材料、安装后校验及原型工具端到端操作尚未验收。 |
| I11、I12 | 增加 10 项真实文件回归，验证同大小同时间戳内容修改、观察标识变化、目录／搜索陈旧分页拒绝、UTF-8 行范围续页、大小边界／超长行截断及符号链接拒绝。 | 10 项全部通过、无跳过；本轮未消除文档已记录的大文件及父目录替换竞争边界，不能宣称已取得完整工程或平台级无竞争保证。 |
| I13 | 修复 Windows 原生图片读取证据被路径分隔符检查静默丢弃的问题；路径仍经过 containedFile 校验，原始 hash 和当前占用校验保留。 | asset-workflow 37 项通过，包含内容变化／占用变化／越界路径拒绝；模型实际读取与权限竞态仍待桌面闭环。 |

## 可复跑验证入口

从仓库根目录执行 TypeScript 测试时，使用工作区实际 loader，不能假定根包安装了 tsx：

```powershell
node --import ./apps/collaboration-api/node_modules/tsx/dist/loader.mjs --test <test files>
```

- 仓库检查：`node scripts/check-repository.mjs`，492 个已跟踪文件／49 项模板摘要通过；模板 `releaseReady=false`。新修复测试及本文已随 `a94405d` 提交。
- 后端：三个领域／契约／API 包类型检查通过；整组后端回归 105 通过、0 失败、9 跳过（需要显式隔离测试数据库的用例未运行），日志 `.local/sync-backend-final.log`。
- Host/client：在 `.local/build/dsh` 对装配后的 Host/client tsconfig 执行 `tsc -b` 通过；日志 `.local/ui-host-typecheck3.log`。
- 原型及恢复聚焦回归：59 项通过，随后新增恢复范围拒绝用例，恢复文件单独 3 项通过；日志 `.local/ui-host-focused.log`、`.local/ui-host-queue-recovery.log`。
- 材料工作流：37 项通过；材料文档及原远端合并子集 25 项通过，固定候选 16 项通过。随后远端合并新增两个真实 Git 场景，完整该文件 12 项通过，覆盖 HEAD、文件字节和未暂存状态。
- 文件服务：`tests/windows-desktop/prototype-files.test.ts`，10 项通过。需求确认 11 项、需求现场 15 项、任务恢复 27 项及原生适配 7 项定向回归均通过；恢复真实模型行为仍未验收。
- Windows 随包 Git：设置 `EADP_TEST_RUNTIME_ROOT` 为 `.local/build/dsh/apps/desktop/.desktop-build/targets/win-x64/runtime/studio-tools` 后，平台 Git 6 项通过，含长路径；日志 `.local/sync-platform-git.log`。
- 完整脚本集：`$env:BASH_EXECUTABLE='D:/devtools/Git/bin/bash.exe'; node --test tests/scripts/*.test.mjs`，103 项全部通过，日志 `.local/sync-final-all-scripts.log`。包含真实普通 Node HostProcess 导入、构建／开发入口与工具栏；不等同实际安装包或 Linux 安装验证。
- 双浏览器：`.local/sync-browser-smoke.mjs`、`.local/sync-browser-smoke.json`、`.local/sync-browser-assembly.log`；这里只证明本机二进制及离线测试页面，未证明产品业务用例。

完整 Desktop 源码测试的初次补充运行仍有依赖解析、旧 fixture、Windows 文件收尾及 60 秒 Git 超时失败，见 `.local/ui-host-remaining.log`；本记录不宣称整个仓库测试全部通过。修复后的定向结果以最终交付补充为准。

## 外部及真实桌面边界

当前桌面 `.env.windows` 指定服务为 `http://100.119.183.44:6972`；`curl.exe --fail --silent --show-error --max-time 15 http://100.119.183.44:6972/health` 超时。Tailscale 服务正在运行，但 `tailscale ping --timeout=5s --c=1 100.119.183.44` 返回 `no matching peer`。未知后台版本，未更改网络配置或服务地址。

当前没有可执行 Docker，也没有配置显式隔离测试数据库；未对既有共享数据库执行测试 DDL。桌面当前版本的启动检查另记，不能从旧产物、独立浏览器、单测或类型检查推断桌面闭环通过。I01—I15 尚未整体关闭，生产就绪未达到。
