# 项目开发规则

0. 不保留向后兼容。过时实现直接删除，不加兼容层、migration 或 fallback。
1. 架构决策面向长期维护，不接受临时替代方案。
2. 优先从上下文、文件、工具和实际证据明确目标、范围与约束。
3. 沿用已有设计、约定和成果，采用最小实现，不做预防性抽象或配置层。
4. 主 Agent 负责拆分、关键判断、整合和验收；边界清晰的执行交给 subagent。并行编码必须使用独立 worktree，每个 worktree 一个 writer；他人改动不得还原。
5. 组件模块化，职责分离。
6. 重要结论须有证据，执行须验证，失败继续定位和修正。
7. 先考察成熟产品和已验证模式，再实施。

## 仓库边界
- 根 `AGENTS.md` 是研发规则；模板所需 `AGENT.md` 是另一契约。前者不能替代后者。
- DSH 版本由 `apps/desktop-distribution/release.lock.json` 固定，源码通过获取脚本生成于忽略的 `.local/upstream/dsh/`。必要发行改动放在 `apps/desktop-distribution/build/`，不修改缓存冒充维护成果。

## Codebase Knowledge Graph

代码发现优先使用 codebase-memory-mcp。未索引时先 `index_repository`。

1. `search_graph`：定位函数、类、路由和变量。
2. `trace_path`：调用关系。
3. `get_code_snippet`：符号源码。
4. `query_graph`：复杂关系查询。
5. `get_architecture`：架构概览。

字符串、配置及非代码文档可用 `rg`；图覆盖不足时再回退文件搜索。
