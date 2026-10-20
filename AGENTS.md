# 项目开发规则

0. 不保留向后兼容。过时实现直接删除，不加兼容层、migration 或 fallback。
1. 架构决策面向长期维护，不接受临时替代方案。
2. 优先从上下文、文件、工具和实际证据明确目标、范围与约束。
3. 沿用已有设计、约定和成果，采用最小实现，不做预防性抽象或配置层。
4. 主 Agent 负责拆分、关键判断、整合和验收；边界清晰的执行交给 subagent。
5. 组件模块化，职责分离，发现能够复用的代码要先进行代码抽象再复用，而不是重新写一遍。不应该存在过多的方法，每个方法的职责应该单一且职责明确，如果一个方法承担了太多的职责，应该将其拆分成多个方法。
7. 先考察成熟产品和已验证模式，再实施。
8. 必要的注释一定要保留，尤其对于关键方法和字段，只用解释方法或类作用，不说来自哪个需求。

## 代码结构与职责

项目使用 TypeScript 和 pnpm workspace，工作区包含 `apps/*` 与 `packages/*`。

| 位置 | 职责 |
| --- | --- |
| `packages/studio-plugin/src/client/` | Studio 工作台界面、页面和交互组件。 |
| `packages/studio-plugin/src/host/` | 桌面本地执行层：`application/` 编排业务流程，`adapters/` 对接本地及远端能力，`prototype/` 处理原型模板、检查、预览和发布。 |
| `packages/studio-plugin/src/shared/` | 界面与 Host 之间的命令、状态和结果等通信契约。 |
| `apps/collaboration-api/src/` | 协同后端：`routes.ts` 接入请求，`service.ts` 编排业务；`auth/` 处理身份与权限，`modules/` 实现协同领域流程，`persistence/` 处理数据库访问、事务和审计。 |
| `apps/collaboration-api/db/` | PostgreSQL 数据结构定义。 |
| `packages/asset-domain/` | 共享领域规则与业务校验。 |
| `packages/contracts/` | 跨端共享类型和 TypeBox 请求校验 Schema。 |
| `apps/desktop-distribution/build/` | 受维护的桌面发行装配脚本与 DSH 产品改动源码。 |
| `scripts/` | 开发环境、依赖获取、构建装配和仓库检查脚本。 |
| `tests/` | 协同后端、Host、构建脚本及桌面行为等验证。 |
| `docs/` | `design/` 保存设计文档，`dseign/` 保存界面设计稿，`milestones.md` 记录里程碑与差距。 |

## 仓库边界

- `packages/studio-plugin/assets/prototype-template/` 是具有独立依赖与锁文件的原型工程，作为模板快照随插件打包；修改模板须验证其自身工程。
- 用户业务工程中的场景、需求及原型代码由产品运行时管理，与本研发仓库分离；随包模板不能替代用户工程。
- DSH 版本由 `apps/desktop-distribution/release.lock.json` 固定，源码通过获取脚本生成于忽略的 `.local/upstream/dsh/`。必要发行改动放在 `apps/desktop-distribution/build/`，不修改缓存冒充维护成果。
- `.local/upstream/` 是供装配与验证使用的上游源码缓存，`.local/build/` 是生成的装配树；`artifacts/` 保存构建产物，`node_modules/` 保存安装依赖。这些目录都不是源码维护位置。

## Codebase Knowledge Graph

代码发现优先使用 codebase-memory-mcp；工具可用但项目未索引时，先执行 `index_repository`。

1. `search_graph`：定位函数、类、路由和变量。
2. `trace_path`：调用关系。
3. `get_code_snippet`：符号源码。
4. `query_graph`：复杂关系查询。
5. `get_architecture`：架构概览。

字符串、配置及非代码文档可用 `rg`；图工具不可用或覆盖不足时，回退 `rg`、文件搜索和源码读取，不因工具缺失阻断工作。
