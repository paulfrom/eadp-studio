# asset-domain 退役

状态：计划删除，不建立改名后的资产流程包。新结构见 [architecture.md](../architecture.md)。

## 1. 删除理由

当前 `packages/asset-domain/src/index.ts`（约 11 KB）管理场景/需求/交接材料、强制 `eadp-metadata`、确认校验、材料种类映射及 Git 合并策略。新目标只有 `需求/` Markdown 与 `原型/` 代码，不再有正式资产生命周期。保留该包会继续向需求编辑器泄漏已删除的场景/确认/模板/来源概念。

## 2. 按职责处理

| 现有能力 | 处理与归属 |
| --- | --- |
| `repositoryPath`、`materialStem`、实际文件名/路径规则 | 不再使用；需求路径由 requirements 的 Host 文件服务校验；不复制旧规则 |
| `materialDirectoryOf`、`MaterialKind` | 删除多材料种类映射；新包使用明确的 `需求/`、`原型/`、`CONTEXT.md` |
| `parseMaterial`、`validateMaterialMetadata` | 删除强制元数据/确认合同；普通 Markdown 直接可读 |
| 固定场景来源、确认条件、需求前置、复用资格 | 删除，不迁成“可选隐藏字段” |
| `PROTOTYPE_MERGE_POLICY`、候选整合、固定 Git 内容验证 | 删除；新原型不依赖 Git/合并 |
| `DomainError` 中 HTTP status/旧业务错误码 | 删除；文件错误在 requirements/prototype/contracts 定义 |
| `digest`/`canonical` 辅助 | 仅作参考；版本改用 `ctx.fs.FsVersion`，路径改用 `resolve/contains`，不保留旧包 |

- 不为了保留十几个辅助函数留下旧资产包；不建立只有转发导出的兼容包。
- 若确实需要跨包共用的纯路径/名称规则，先在真实调用点证明复用，再放入合适归属；当前优先使用固定宿主 `ctx.fs` 与各包内的窄实现。

## 3. Editor 对应参考

- Editor 的版本条件写入、真实路径 containment、离场保存比旧资产状态更接近目标；EADP 直接用固定 DSH `ctx.fs` 与官方 workspace，不复制 Editor rc.5 代码。
- 不照搬 Editor 的 manuscript 包依赖方向，不新增同名工具包。

## 4. 实施与验收

1. 先随 requirements/prototype 新服务替换必要调用，再一次性删除 `packages/asset-domain` 依赖、目录和锁文件记录。
2. 全仓核对 `@eadp/asset-domain` 引用、构建装配、发行 payload、源码缓存边界。
3. 新 Markdown 不需要 metadata 块即可编辑；缺少场景/确认字段不报业务门禁；非法路径、版本冲突仍拒绝。
4. 退役不删除旧用户正文中的任何文本；手工整理旧需求时可明确处理旧元数据，新应用不再解析或补写状态。
5. `pnpm check`、受影响构建、真实需求/原型操作验证；不能只以类型不报错宣称完成。

以上尚未执行。
