# 本地状态使用 SQLite

状态：Accepted（2026-11-02）。替代 ADR-0005 中 JSON 状态自动重建及临时文件替换部分；业务流程和后台协同事实不变。

## 决策

用户要求减少项目自行生成和反复修改的过程文件，允许使用 SQLite，并明确允许一次性导入现有 JSON、保留原文件。

采用固定 Electron 44.7.0 自带的 Node 24.21.0 `node:sqlite`，无需添加原生 npm 模块或改变 DSH 版本。Node 开发入口同样支持该内置模块。

- 应用目录的 `studio.sqlite` 保存默认项目位置及脱敏操作日志。
- 应用 `users/<账号>/studio.sqlite` 保存设备身份、项目索引、初始化操作和跨项目调度元数据。
- 项目 `.eadp/users/<账号>/studio.sqlite` 保存该项目的草稿、操作、原型事项、候选、集成、材料读取和检查记录。项目私有数据不移入应用目录。
- `local_records` 按业务记录键保存当前领域快照，避免引入 ORM 或另建一套实体模型。未变化的内容不写入；全局队列 revision 只存在账户元数据中，避免一次保存重写所有项目。
- `local_activity` 追加脱敏事件，总事件字节量最多 20 MiB，按最老事件淘汰。旧 JSONL 不再追加或轮转。

项目事项和账户调度记录在同一个 ATTACH 事务中提交。采用 DELETE rollback journal、FULL synchronous、BEGIN IMMEDIATE 和有界 busy timeout；不使用 WAL，因为 SQLite 的跨附加数据库掉电原子性不适用于 WAL。事务可能生成 SQLite 自己管理的 rollback/super journal，这些是恢复所需文件，不能手工删除。正常记录保存不再生成 UUID JSON 临时文件并 rename。

记录与数据库损坏时明确报错并保留现场，不清空数据库，不重建新设备身份。已有事项恢复按 operation→task 归并队列顺序和选择；成功准备或投递后清理对应的失效错误。

## 文件边界

场景、需求、交接正文、原型源码、Git 工作树、构建输入输出、截图与 trace 等真实附件继续使用文件，因为现有编辑器、Git、构建及浏览器工具直接使用它们。项目 `owner.json` 是低频归属标记，模板清单是随包契约；不把它们混同于频繁改写的运行状态。官方原生会话持久化仍由 DSH 负责，不能修改其内部保存机制。

## 一次性导入

关闭使用相同状态目录的全部桌面及 Host 后执行：

```powershell
node scripts/import-local-state.mjs --state-directory "$env:APPDATA\eadp-studio\studio"
```

仅读取已知的当前格式 JSON 和索引登记的项目。导入保留 clientId、taskId、sessionId、草稿与操作身份；原文件不改动、不删除。脚本先核对源文件哈希，逐项目事务导入并记 receipt，最后发布账户索引；中断重跑不会覆盖已导入数据库中的新数据。离线导入不依赖同时附加全部项目数据库。正常运行时没有 JSON 回读或双写兼容层，未导入旧状态会提示先离线处理。

原 JSON 暂作唯一旧现场的保留副本；确认 SQLite 中的原事项、草稿及中断恢复均可用后，再另行清理。导入不释放后台占用、不发送模型消息、不提交或推送 Git。

## 限制与验证

SQLite 单次附加库数受运行时编译限制；普通业务保存只包含实际变化的项目及账户数据库，不能拆事务后伪称原子保存。多 Host 的逻辑状态仍需遵守现有单写者模型，文件锁不等于多个内存快照的自动合并。项目数据库应位于支持 SQLite 锁与刷盘语义的本机文件系统。

依据：[Node 24 SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)、[SQLite ATTACH 事务边界](https://www.sqlite.org/lang_attach.html)、[SQLite 原子提交](https://www.sqlite.org/atomiccommit.html)。构建、临时数据库验证和真实桌面结果分别记录，不能用前两者代替完整桌面验收。
