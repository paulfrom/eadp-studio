# 本地工作台实施记录

验证边界：只做仓库检查、TypeScript 静态检查和构建；未启动桌面、真实模型、原型进程或运行时验收。**静态验证通过 ≠ 桌面验收通过 ≠ 生产就绪。** 接口证据与未验证操作见 [静态核查](local-workbench-static-audit.md)，缺口见 [blocked-upstream](blocked-upstream.md)。

## 阶段 0

已提交 `4311ba5`：固定 rc.2 源码核查、缺口登记与桌面未验证操作清单。主 Agent 执行 `pnpm check` 通过。退出异步保存接口缺口不绕过；继续实现不依赖该接口的功能。

## 阶段 1

2026-11-06：新五包骨架、Workspace 首页与工作台、原生会话承载、角色策略及活动文档服务；三个业务 child slot 由 Shell 声明，各功能包独立注册。requirements 的空 flush 仅为本阶段计划明确的占位，阶段 2 替换。共享契约目录从 `packages/contracts` 移为 `packages/eadp-contracts`，保留单一 `@eadp/contracts` 包身份；旧领域导出在后续退役阶段删除，未增加兼容别名。

新装配入口 `pnpm build:plugins` 使用隔离的 `.local/build/local-workbench-dsh`，只装配新五包。旧发行入口尚待阶段 6 替换，不能声称最终发行已切换。上游修改仅来自维护的 fail-closed 编辑；官方 Typert 先生成 Host Remote，再编译 Client。

主 Agent 静态门禁：Host / Client 编译通过；五包各自 Host / Client `tsc --noEmit` 通过；共享契约和四个插件构建通过，声明入口存在、客户端无未打包的产品包 import。命令为 `node apps/desktop-distribution/build/prepare-workbench.mjs --stage-only` 后调用其 `buildWorkbench()`；完整可复用入口为 `pnpm build:plugins`。本机详细日志 `.local/build/workbench-stage1-build.log`，可重建，不作为运行时证据。根 `pnpm check` 结果随阶段提交记录。

仍未实现/验证：桌面退出前异步保存协调、禁止宿主自动创建默认 Workspace（均 blocked-upstream）；本阶段全部桌面行为；后续需求编辑/提案、原型、知识库与最终发行。阶段 2–7 尚未完成。
