# 阶段二需求协同 波次一实现计划：共享契约 + 协同后台

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `@eadp/contracts`、`@eadp/asset-domain`、`@eadp/collaboration-api` 运行时代码对齐已是目标形态的 `db/schema.sql`：需求去分类并获得稳定 REQ 编号、绑定独立需求模板，删除批次/冻结/自动升版，通用场景由项目初始化系统预置接受，新增独立一致性对比记录的提交与查询 API。

**Architecture:** schema.sql（1537 行）已包含双类型编号、双模板目录约束、`builtin_key='general'`、`acceptance_kind='system-provisioned'`、三张一致性对比表及全部不变量触发器；本波次只改应用层与契约，不改 schema。后台不保存材料正文/完整 diff/原始模型响应；对比记录走表自带 `operation_key` 幂等，不经 Git。

**Tech Stack:** TypeScript + TypeBox（`@sinclair/typebox`）、Fastify、pg（PostgreSQL 17）、node:test + tsx。

**设计依据：** `docs/design/02-requirements.md`（已定稿）、`docs/adr/0003-user-directed-revision-consistency.md`、`docs/adr/0004-builtin-general-scenario.md`。验收对应 R01–R05、R11–R13、R21、R23–R25 的后台部分。

## Global Constraints

- 不保留向后兼容：删除 categoryId、scenario-batch、frozenBy、associationRevision、ProjectView.categories，不加兼容层或迁移。
- 协议上限（schema.sql:1055-1142）：ID/操作键 ≤100 字符；冲突摘要、失败摘要 ≤500 字符；每次对比冲突 ≤100 条；每条冲突涉及材料 1–100 个；序号 1–100；SHA-256 为 64 位小写十六进制（复用现有 `Sha256Schema`）。越限拒绝，不截断。
- 对比相关路径不执行任何 Git 操作、不加载固定材料正文（不复用 `repository.entities()`/`hydrateResult`/`fixedVersion`），对比目录查询走纯 SQL。
- 冲突记录无处理状态字段；对比与冲突记录不可变（schema 触发器已强制）。
- 通用场景：`acceptance_kind='system-provisioned'` 只能由初始化事务写入；固定读取按接受途径选严格契约（`parseBuiltinScenario` 字节比对），禁止普通解析失败后 fallback。
- 编号：`studio_project_counters(project_id,kind)` 行锁递增；编号独立先提交，业务回滚不回收；同一 `operation_key` 重放返回原编号。
- 中文错误文案沿用现有风格；DomainError 码新增：`ENTITY_NUMBER_EXHAUSTED`（替代 SCENARIO_NUMBER_EXHAUSTED）、`GENERAL_SCENARIO_REQUIRED`、`GENERAL_SCENARIO_MISMATCH`、`GENERAL_SCENARIO_UNRESERVED`、`INVALID_BUILTIN_SCENARIO`、`BUILTIN_SCENARIO_IMMUTABLE`、`AUTO_COMPARISON_RECORDED`、`COMPARISON_CONFIRMATION_MISMATCH`、`COMPARISON_NOT_FOUND`、`PREREQUISITE_UNCONFIRMED`、`CONFLICT_ORDINAL_SEQUENCE`（422，冲突序号必须为 1..N 连续）。
- 验证数据库命名约定：`SCENARIO_SCHEMA_TEST_DATABASE_URL` → `eadp_scenario_schema_check_*`；`STUDIO_TEST_DATABASE_URL` → `eadp_auth_check_*`；`check:transactions` → `eadp_scenario_transaction_check_*`。未设置变量的跳过不计入通过。

## 验证环境准备（所有 DB 套件共用）

```bash
docker run -d --name eadp-wave1-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17
# 每个套件独立空库，例如：
docker exec eadp-wave1-pg psql -U postgres -c "CREATE DATABASE eadp_auth_check_wave1"
docker exec eadp-wave1-pg psql -U postgres -c "CREATE DATABASE eadp_scenario_schema_check_wave1"
docker exec eadp-wave1-pg psql -U postgres -c "CREATE DATABASE eadp_scenario_transaction_check_wave1"
# 对应 URL: postgres://postgres:test@localhost:55432/<库名>
```

非 DB 校验命令：

```bash
pnpm --filter @eadp/contracts typecheck && pnpm --filter @eadp/asset-domain typecheck
pnpm --filter @eadp/collaboration-api typecheck
pnpm --filter @eadp/collaboration-api exec tsx --test src/*.test.ts src/auth/*.test.ts src/modules/*.test.ts src/persistence/*.test.ts
```

---

### Task 1: 契约基座（contracts + asset-domain）

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/asset-domain/src/index.ts`

**Interfaces:**
- Produces（后续任务依赖的确切名字）：
  - `TemplateCatalogSchema` / `TemplateCatalog`（替代 ScenarioTemplateCatalogSchema，不保留旧名）
  - `ProjectManifest.scenarioTemplates?: TemplateCatalog`、`ProjectManifest.requirementTemplates?: TemplateCatalog`
  - `BuiltinScenarioMetadataSchema` / `BuiltinScenarioMetadata` / `isBuiltinScenarioMetadata(value)`
  - `ReserveEntitySchema`：requirement 分支必填 `templateId: IdSchema, templateRef: FixedReferenceSchema`，无 categoryId/batch
  - `ClaimSchema.purpose: 'design' | 'prototype'`；`MaterialIntegrationSchema.stage: 'material' | 'prototype'`，无 `expectedAssociationRevision`/`batchRequirementIds`
  - `reviewInputText(input: Pick<MaterialIntegrationRequest,'stage'|'expectedHead'|'token'> & { confirmations: readonly Pick<ConfirmationInput,'entityId'|'expectedRevision'|'fixed'>[] }, root: Pick<EntityView,'current'|'occupation'>): string`
  - `EntityView`：删 `categoryId/frozenBy/associationRevision`，增 `builtinKey?: 'general'`；`FixedVersion` 增 `builtin?: boolean`，`metadata: MaterialMetadata | BuiltinScenarioMetadata`
  - `ProjectView`：删 `categories`，增 `generalScenario?: { entityId: string; code: string }`
  - `ComparisonFailureSchema`/`ComparisonFailure`、`ConsistencyConflictInputSchema`、`SubmitConsistencyComparisonSchema`/`SubmitConsistencyComparisonRequest`、`ConsistencyConflictView`、`ConsistencyComparisonView`、`ConsistencyContextView`
  - asset-domain：`GENERAL_SCENARIO_TITLE`、`GENERAL_SCENARIO_SUMMARY`、`generalScenarioMetadata(entityId)`、`generalScenarioDocument(entityId): string`、`parseBuiltinScenario(markdown, entityId): BuiltinScenarioMetadata`

- [x] **Step 1: 改写 `packages/contracts/src/index.ts`**

按下列锚点编辑（均为精确替换）：

1. 删除 `CategorySchema`/`CategoryRequest`（:73-74）。
2. `metadataFields`（:26-37）删 `categoryId` 行；拆分为三个分支并替换 :38-45：

```ts
const scenarioMetadata = { ...metadataFields, kind: Type.Literal('scenario'), templateId: IdSchema, templateRef: FixedReferenceSchema, applicability: Type.Optional(Type.Never()) };
const requirementMetadata = { ...metadataFields, kind: Type.Literal('requirement'), templateId: IdSchema, templateRef: FixedReferenceSchema };
const aggregateMetadata = { ...metadataFields, kind: Type.Union([Type.Literal('baseline'), Type.Literal('handoff')]) };
export const MaterialMetadataSchema = Type.Union([object(scenarioMetadata), object(requirementMetadata), object(aggregateMetadata)]);
export type MaterialMetadata = Static<typeof MaterialMetadataSchema>;
export const ConfirmedMaterialMetadataSchema = Type.Union([
  object({ ...scenarioMetadata, businessEvidence: Type.Array(businessEvidenceSchema, { minItems: 1, maxItems: 100 }) }),
  object({ ...requirementMetadata, businessEvidence: Type.Array(businessEvidenceSchema, { minItems: 1, maxItems: 100 }) }),
  object({ ...aggregateMetadata, businessEvidence: Type.Array(businessEvidenceSchema, { minItems: 1, maxItems: 100 }) }),
]);
```

3. 在其后新增内置通用场景严格契约（正文由 asset-domain 生成，字节级一致）：

```ts
const emptyList = Type.Array(Type.Never(), { maxItems: 0 });
/** Metadata of the system-provisioned general scenario; read only through the strict builtin contract. */
export const BuiltinScenarioMetadataSchema = object({
  entityId: IdSchema, kind: Type.Literal('scenario'), title: Type.Literal('通用场景'), summary: Type.String({ minLength: 1, maxLength: 500 }),
  scenarioIds: emptyList, prerequisites: emptyList, sources: emptyList, referencedAssets: emptyList,
  businessEvidence: emptyList, openQuestions: emptyList,
  coreRulesPresent: Type.Literal(false), acceptanceCriteriaPresent: Type.Literal(false),
});
export type BuiltinScenarioMetadata = Static<typeof BuiltinScenarioMetadataSchema>;
export function isBuiltinScenarioMetadata(value: unknown): value is BuiltinScenarioMetadata { return Value.Check(BuiltinScenarioMetadataSchema, value); }
```

4. 模板目录改名并加入需求目录（:51-56）：

```ts
export const TemplateCatalogSchema = object({ defaultTemplateId: IdSchema, templates: Type.Array(object({ id: IdSchema, name: text, path: Type.String({ minLength: 1, maxLength: 400 }) }), { minItems: 1, maxItems: 100 }) });
export type TemplateCatalog = Static<typeof TemplateCatalogSchema>;
export const ProjectManifestSchema = object({ schemaVersion: Type.Literal(1), projectId: IdSchema, gitlabProjectId: Type.Integer({ minimum: 1 }), repositoryUrl: text, stableBranch: text,
  directories: Type.Tuple([Type.Literal('场景'), Type.Literal('需求'), Type.Literal('交接'), Type.Literal('原型代码')]),
  /** Absent in projects accepted before the template catalogs existed; reading them must not fail. */
  scenarioTemplates: Type.Optional(TemplateCatalogSchema),
  /** Requirement template catalog; new initializations must declare it. */
  requirementTemplates: Type.Optional(TemplateCatalogSchema) });
```

5. `reserveFields`（:75）删 `batch`；`ReserveEntitySchema`（:76-80）替换为：

```ts
const reserveFields = { ...keyed, title: text, sourceCandidateId: Type.Optional(IdSchema) };
export const ReserveEntitySchema = Type.Union([
  object({ ...reserveFields, kind: Type.Literal('scenario'), templateId: Type.Optional(IdSchema), templateRef: Type.Optional(FixedReferenceSchema), sources: Type.Optional(Type.Never()) }),
  object({ ...reserveFields, kind: Type.Literal('requirement'), templateId: IdSchema, templateRef: FixedReferenceSchema, sources: Type.Array(SourceSchema, { minItems: 1, maxItems: 100 }) }),
  object({ ...reserveFields, kind: Type.Union([Type.Literal('baseline'), Type.Literal('handoff')]), templateId: Type.Optional(Type.Never()), templateRef: Type.Optional(Type.Never()), sources: Type.Optional(Type.Array(SourceSchema, { maxItems: 100 })) }),
]);
```

6. `ClaimSchema`（:82）purpose 改 `Type.Union([Type.Literal('design'), Type.Literal('prototype')])`。
7. `MaterialIntegrationSchema`（:104-108）stage 改 `Type.Union([Type.Literal('material'), Type.Literal('prototype')])`，删除 `expectedAssociationRevision`/`batchRequirementIds` 两个字段。
8. `reviewInputText`（:115-124）删除批次分支与参数：

```ts
export function reviewInputText(input: Pick<MaterialIntegrationRequest, 'stage' | 'expectedHead' | 'token'> & { confirmations: readonly Pick<ConfirmationInput, 'entityId' | 'expectedRevision' | 'fixed'>[] }, root: Pick<EntityView, 'current' | 'occupation'>): string {
  const value = { expectedHead: input.expectedHead, token: input.token,
    ...(input.stage === 'prototype' ? { current: root.current, prerequisites: root.occupation?.prerequisiteBindings } : {
      inputs: input.confirmations.map(c => ({ entityId: c.entityId, revision: c.expectedRevision, sha256: c.fixed.sha256 })).sort((a, b) => a.entityId.localeCompare(b.entityId)),
    }),
  };
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, stable(item)])) : v;
  return JSON.stringify(stable(value));
}
```

9. `FixedVersion`（:149-153）：`metadata` 类型改 `MaterialMetadata | BuiltinScenarioMetadata`，增字段 `builtin?: boolean`。
10. `EntityView`（:165-173）：删 `categoryId`、`frozenBy`、`associationRevision`；在 `kind` 后增 `builtinKey?: 'general'`。`EntityOccupancyView`（:174）的 Pick 列表删 `'frozenBy' | 'associationRevision'`、增 `'builtinKey'`。
11. `ProjectView`（:175-180）：删 `categories` 行，增 `generalScenario?: { entityId: string; code: string }`。
12. 文件末尾新增一致性对比契约：

```ts
export const ComparisonFailureSchema = Type.Union(['model-failed', 'timeout', 'permission-denied', 'read-failed', 'context-limit', 'relationship-unavailable', 'submission-failed', 'cancelled', 'internal-error'].map(Type.Literal));
export type ComparisonFailure = Static<typeof ComparisonFailureSchema>;
const conflictSummary = Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
export const ConsistencyConflictInputSchema = object({
  id: IdSchema, ordinal: Type.Integer({ minimum: 1, maximum: 100 }), summary: conflictSummary,
  relation: Type.Union([Type.Literal('formal'), Type.Literal('potential')]),
  entities: Type.Array(IdSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
});
export type ConsistencyConflictInput = Static<typeof ConsistencyConflictInputSchema>;
const comparisonBase = { ...keyed, id: IdSchema, entityId: IdSchema,
  coverage: Type.Union([Type.Literal('complete'), Type.Literal('partial')]),
  conflicts: Type.Array(ConsistencyConflictInputSchema, { maxItems: 100 }) };
const comparisonResults = [
  { result: Type.Literal('completed'), failureCode: Type.Optional(Type.Never()), summary: Type.String({ maxLength: 500 }) },
  { result: Type.Literal('failed'), failureCode: Type.Union(['model-failed', 'timeout', 'permission-denied', 'read-failed', 'context-limit', 'relationship-unavailable', 'submission-failed', 'internal-error'].map(Type.Literal)), summary: conflictSummary },
  { result: Type.Literal('cancelled'), failureCode: Type.Literal('cancelled'), summary: Type.String({ maxLength: 500 }) },
] as const;
/** Whitelist-only comparison submission; conclusions and conflict digests, never material content. */
export const SubmitConsistencyComparisonSchema = Type.Union([
  ...comparisonResults.map(r => object({ ...comparisonBase, ...r, trigger: Type.Literal('manual'), confirmationId: Type.Optional(Type.Never()) })),
  ...comparisonResults.map(r => object({ ...comparisonBase, ...r, trigger: Type.Literal('confirmation'), confirmationId: IdSchema })),
]);
export type SubmitConsistencyComparisonRequest = Static<typeof SubmitConsistencyComparisonSchema>;
export interface ConsistencyConflictView { id: string; ordinal: number; summary: string; relation: 'formal' | 'potential'; entities: string[] }
export interface ConsistencyComparisonView {
  id: string; entityId: string; trigger: 'manual' | 'confirmation'; confirmationId?: string;
  result: 'completed' | 'failed' | 'cancelled'; coverage: 'complete' | 'partial'; failureCode?: ComparisonFailure; summary: string;
  conflictCount: number; creator: AuditIdentity; createdAt: string; conflicts: ConsistencyConflictView[];
}
/** Formal relation catalog for one comparison target; control fields only, never material content. */
export interface ConsistencyContextView {
  entity: { id: string; kind: EntityKind; builtinKey?: 'general'; code?: string; title: string; revision: number; materialVersion: number; confirmationStatus: 'draft' | 'confirmed'; occupied: boolean };
  sources: Array<{ entityId: string; code?: string; title: string; version: number; confirmationId: string; fixed: FixedReference }>;
  requirements: Array<{ id: string; code?: string; title: string; revision: number; materialVersion: number; confirmationStatus: 'draft' | 'confirmed'; occupied: boolean; sources: AssetSource[] }>;
  prerequisites: Array<{ requirementId: string; code?: string; title: string; version: number; confirmationId: string }>;
}
```

- [x] **Step 2: 改写 `packages/asset-domain/src/index.ts`**

1. `validateMaterialMetadata`（:81-84）的模板身份检查从仅 scenario 推广到 scenario+requirement：

```ts
  if (metadata.kind === 'scenario' || metadata.kind === 'requirement') {
    repositoryPath(metadata.templateRef.path);
    requireCondition(metadata.templateRef.path === `.template/${metadata.templateId}.md`, 'TEMPLATE_IDENTITY_MISMATCH', 'The template path must match its stable template ID', 422);
  }
```

2. `parseProjectManifest`（:91-101）：两个目录各自校验，且跨目录 ID 唯一（同用 `.template/` 路径规则）：

```ts
  for (const catalog of [manifest.scenarioTemplates, manifest.requirementTemplates]) {
    if (!catalog) continue;
    requireCondition(new Set(catalog.templates.map(t => t.id)).size === catalog.templates.length && new Set(catalog.templates.map(t => t.path)).size === catalog.templates.length, 'DUPLICATE_TEMPLATE', 'Project template identities and paths must be unique', 422);
    requireCondition(catalog.templates.some(t => t.id === catalog.defaultTemplateId), 'DEFAULT_TEMPLATE_REQUIRED', 'The default template must exist in its catalog', 422);
    for (const template of catalog.templates) {
      repositoryPath(template.path);
      requireCondition(template.path === `.template/${template.id}.md`, 'TEMPLATE_IDENTITY_MISMATCH', 'Template paths must match their stable template IDs', 422);
    }
  }
  const all = [...(manifest.scenarioTemplates?.templates ?? []), ...(manifest.requirementTemplates?.templates ?? [])];
  requireCondition(new Set(all.map(t => t.id)).size === all.length, 'DUPLICATE_TEMPLATE', 'Template identities must be unique across scenario and requirement catalogs', 422);
```

3. 文件末尾新增通用场景固定文档（正文逐字复制 `docs/design/templates/general-scenario.md` 全文，含结尾换行）：

```ts
export const GENERAL_SCENARIO_TITLE = '通用场景';
export const GENERAL_SCENARIO_SUMMARY = '项目内置通用场景，用于关联暂不归属具体业务场景的需求。';
const GENERAL_SCENARIO_BODY = `# 通用场景

本场景由项目固定内置，用于关联暂不归属其他具体业务场景的需求，无须用户先新增、编辑或确认场景。

## 适用范围

用户可以直接选择本场景创建需求。需求的目标、范围、角色、流程、字段、规则、异常和验收条件，由该需求自身材料描述。

## 业务依据

本说明只提供需求的场景归属，不提供具体业务规则，也不代替需求自身的正式依据和确认。

## 需求管理

关联需求独立整理、修订和确认。新建需求无须先补充本场景的内容；需求中应直接说明自身的业务目标、规则和验收条件。
`;
/** Controlled metadata for the system-provisioned general scenario. */
export function generalScenarioMetadata(entityId: string): BuiltinScenarioMetadata {
  return { entityId, kind: 'scenario', title: GENERAL_SCENARIO_TITLE, summary: GENERAL_SCENARIO_SUMMARY, scenarioIds: [], prerequisites: [], sources: [], referencedAssets: [], businessEvidence: [], openQuestions: [], coreRulesPresent: false, acceptanceCriteriaPresent: false };
}
/** The exact document bytes the Host writes into the initialization commit; the backend rebuilds and byte-compares it. */
export function generalScenarioDocument(entityId: string): string {
  return `${GENERAL_SCENARIO_BODY}\n\`\`\`eadp-metadata\n${JSON.stringify(generalScenarioMetadata(entityId), null, 2)}\n\`\`\`\n`;
}
/** Strict fixed read for system-provisioned acceptance; never a fallback after ordinary parsing fails. */
export function parseBuiltinScenario(markdown: string, entityId: string): BuiltinScenarioMetadata {
  requireCondition(markdown === generalScenarioDocument(entityId), 'INVALID_BUILTIN_SCENARIO', 'Built-in general scenario content does not match the provisioned document', 422);
  return generalScenarioMetadata(entityId);
}
```

`BuiltinScenarioMetadata` 需要从 `@eadp/contracts` 导入（加到 :1 的 import 类型列表）。

- [x] **Step 3: 类型检查并提交**

```bash
pnpm --filter @eadp/contracts typecheck && pnpm --filter @eadp/asset-domain typecheck
```
预期：两个包通过；`@eadp/collaboration-api` 与 `@eadp/studio-plugin` 此时报类型错误属预期中间态（Task 2–6 消除）。
```bash
git add packages/contracts/src/index.ts packages/asset-domain/src/index.ts
git commit -m "阶段二契约：需求去分类、REQ 模板绑定、双模板目录、通用场景与一致性对比契约"
```

---

### Task 2: 持久层对齐 schema（repository.ts）

**Files:**
- Modify: `apps/collaboration-api/src/persistence/repository.ts`
- Test: `tests/collaboration/scenario-schema.test.mjs`（既有，作回归）、`apps/collaboration-api/src/persistence/check-transactions.ts`

**Interfaces:**
- Consumes: Task 1 的 `EntityView`/`ProjectView`/`FixedVersion` 新形状。
- Produces:
  - `reserveEntityNumber(database, projectId, kind: 'scenario' | 'requirement', actor, input): Promise<EntityNumber>`（替代 `reserveScenarioNumber`，不保留旧名）；`EntityNumber = { id: string; sequence: number; code: string }`
  - `entities()`/`saveEntity()` 不再读写 `category_id`/`association_revision`，映射 `builtin_key`
  - `saveConfirmation` 写入 `source_count`，需求来源补 `project_id`/`scenario_id` 列
  - `entityRow(c, projectId, id): Promise<Row>`（纯 SQL 存在性读取，供对比路径使用）

- [x] **Step 1: 改写编号预留（repository.ts:55-74 整体替换）**

```ts
export interface EntityNumber { id: string; sequence: number; code: string }
/** Commit a stable allocation before business writes so rollback never recycles a number. */
export async function reserveEntityNumber(database: Database, projectId: string, kind: 'scenario' | 'requirement', actor: Actor, input: ReserveEntityRequest): Promise<EntityNumber> {
  return transaction(database, async c => {
    await c.query('INSERT INTO studio_project_counters(project_id,kind) VALUES($1,$2) ON CONFLICT(project_id,kind) DO NOTHING', [projectId, kind]);
    await c.query('SELECT project_id FROM studio_project_counters WHERE project_id=$1 AND kind=$2 FOR UPDATE', [projectId, kind]);
    const completed = (await c.query<Row>('SELECT creator_id,action,request_hash FROM studio_operations WHERE project_id=$1 AND key=$2', [projectId, input.idempotencyKey])).rows[0];
    if (completed) requireCondition(Number(completed.creator_id) === actor.id && completed.action === 'entity.reserve' && completed.request_hash === requestHash(input), 'IDEMPOTENCY_CONFLICT', 'The creation operation already belongs to another request', 409);
    const previous = (await c.query<Row>('SELECT * FROM studio_entity_numbers WHERE project_id=$1 AND operation_key=$2', [projectId, input.idempotencyKey])).rows[0];
    if (previous) {
      requireCondition(Number(previous.creator_id) === actor.id && previous.kind === kind && previous.request_hash === requestHash(input), 'IDEMPOTENCY_CONFLICT', 'The creation operation already belongs to another request', 409);
      return { id: String(previous.entity_id), sequence: Number(previous.sequence), code: String(previous.code) };
    }
    const sequence = Number((await c.query<{ sequence: string }>('UPDATE studio_project_counters SET next_sequence=next_sequence+1 WHERE project_id=$1 AND kind=$2 RETURNING next_sequence-1 AS sequence', [projectId, kind])).rows[0]!.sequence);
    requireCondition(Number.isSafeInteger(sequence), 'ENTITY_NUMBER_EXHAUSTED', 'Entity numbering exceeds the supported range', 409);
    const value = { id: newId(), sequence, code: `${kind === 'scenario' ? 'SC' : 'REQ'}-${String(sequence).padStart(4, '0')}` };
    await c.query(`INSERT INTO studio_entity_numbers(project_id,kind,sequence,code,operation_key,entity_id,request_hash,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [projectId, kind, sequence, value.code, input.idempotencyKey, value.id, requestHash(input), actor.id, actor.username, actor.name]);
    return value;
  });
}
```

- [x] **Step 2: 项目视图去分类、暴露通用场景预留身份（repository.ts:37-46）**

`projectView` 删除 `categories: []`，签名改为纯同步组装；`project()`/`listProjects()` 追加预留身份查询：

```ts
function projectView(row: Row): Omit<ProjectView, 'generalScenario'> {
  return { id: String(row.id), gitlabProjectId: Number(row.gitlab_project_id), repositoryUrl: String(row.repository_url), stableBranch: String(row.stable_branch), name: String(row.name), namespaceId: Number(row.namespace_id), namespacePath: String(row.namespace_path), initializationStatus: row.state === 'ready' ? 'ready' : 'pending', recognizedHead: row.recognized_head as string | null, revision: Number(row.revision),
    ...(row.current_baseline_id ? { currentBaselineId: String(row.current_baseline_id) } : {}),
    ...(row.deployment_url ? { deployment: { baselineId: String(row.deployment_baseline_id), url: String(row.deployment_url), artifactSha256: String(row.deployment_artifact_sha256), deployedAt: date(row.deployed_at) } } : {}),
  };
}
async function withGeneralScenario(c: Transaction, view: Omit<ProjectView, 'generalScenario'>): Promise<ProjectView> {
  const reserved = (await c.query<Row>("SELECT entity_id,code FROM studio_entity_numbers WHERE project_id=$1 AND kind='scenario' AND operation_key='general-scenario'", [view.id])).rows[0];
  return { ...view, ...(reserved ? { generalScenario: { entityId: String(reserved.entity_id), code: String(reserved.code) } : {}) } };
}
export async function project(c: Transaction, id: string, lock = false): Promise<ProjectView> {
  const row = (await c.query<Row>(`SELECT * FROM studio_projects WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  requireCondition(row && row.gitlab_project_id !== null, 'PROJECT_NOT_FOUND', 'Project was not found', 404);
  return withGeneralScenario(c, projectView(row));
}
export async function listProjects(c: Transaction): Promise<ProjectView[]> {
  const result: ProjectView[] = [];
  for (const row of (await c.query<Row>("SELECT * FROM studio_projects WHERE state IN ('assigned','ready') ORDER BY id")).rows) result.push(await withGeneralScenario(c, projectView(row)));
  return result;
}
```

- [x] **Step 3: 实体目录读写对齐（repository.ts:76-123）**

`entities()` 的 view 字面量（:87）：删 `...(row.category_id !== null ? ...)` 与 `frozenBy: [], associationRevision: ...`，在 `kind` 后增 `...(row.builtin_key ? { builtinKey: row.builtin_key as 'general' } : {})`。

`saveEntity`（:106-123）整体替换 INSERT（删 `category_id`/`association_revision`，增 `builtin_key`；`builtin_key` 不可更新）：

```ts
export async function saveEntity(c: Transaction, projectId: string, value: EntityView) {
  await c.query(`INSERT INTO studio_entities(project_id,id,kind,builtin_key,sequence,code,title,summary,template_id,template_ref,revision,generation,material_version,confirmation_status,task_status,current_confirmation_id,${auditColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$18,$19,$20) ON CONFLICT(project_id,id) DO UPDATE SET title=excluded.title,summary=excluded.summary,template_id=excluded.template_id,template_ref=excluded.template_ref,revision=excluded.revision,generation=excluded.generation,material_version=excluded.material_version,confirmation_status=excluded.confirmation_status,task_status=excluded.task_status,current_confirmation_id=excluded.current_confirmation_id,last_editor_id=excluded.last_editor_id,last_editor_account=excluded.last_editor_account,last_editor_name=excluded.last_editor_name,last_edited_date=clock_timestamp()`, [projectId, value.id, value.kind, value.builtinKey ?? null, value.sequence ?? null, value.code ?? null, value.title, value.summary ?? '', value.templateId ?? null, value.templateRef ?? null, value.revision, value.generation, value.materialVersion, value.confirmationStatus, value.taskStatus, value.current?.confirmationId ?? value.legacyCurrent?.confirmationId ?? null, ...actorFields()]);
```

`saveEntity` 内需求分支（:108-121）：`studio_scenario_requirements`、`studio_entity_scenario_sources` 写入保持不变；前置写入补 `confirmation_id`（schema.sql:746 NOT NULL + 复合外键）：

```ts
    await c.query('DELETE FROM studio_prerequisites WHERE project_id=$1 AND entity_id=$2', [projectId, value.id]);
    for (const prerequisite of value.prerequisites) {
      const confirmed = (await c.query<{ id: string }>("SELECT id FROM studio_confirmations WHERE project_id=$1 AND entity_id=$2 AND version=$3 AND stage='material'", [projectId, prerequisite.requirementId, prerequisite.version])).rows[0];
      requireCondition(confirmed, 'PREREQUISITE_UNCONFIRMED', 'Prerequisites must bind accepted requirement versions', 409);
      await c.query(`INSERT INTO studio_prerequisites(project_id,entity_id,requirement_id,version,confirmation_id,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [projectId, value.id, prerequisite.requirementId, prerequisite.version, confirmed.id, ...actorFields()]);
    }
```

- [x] **Step 4: 确认接受写入补齐（repository.ts:196-208）**

`saveConfirmation` 的 INSERT 增加 `source_count` 列（值 = 需求固定场景来源数，scenario 为 0），需求来源 INSERT 补 `project_id`/`scenario_id`：

```ts
  const scenarioSources = input.stage === 'material' && metadata.kind === 'requirement' ? metadata.sources.filter(s => s.projectId === projectId && metadata.scenarioIds.includes(s.entityId)) : [];
  await c.query(`INSERT INTO studio_confirmations(id,project_id,entity_id,version,stage,revision,title,summary,commit_sha,path,sha256,method,read_hash,repair_task_id,integration_id,applicability,applicability_reason,source_count,${actorColumns},created_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [event.id, projectId, event.entityId, event.version, input.stage, event.revision, metadata.title, metadata.summary ?? '', event.fixed.commitSha, event.fixed.path, event.fixed.sha256, repair ? 'repair' : 'normal', method.readHash, repair ? method.repairTaskId : null, input.integrationId, metadata.applicability ? 'not-applicable' : 'applicable', metadata.applicability?.reason ?? null, scenarioSources.length, ...actorFields(), event.confirmedAt]);
  for (const source of scenarioSources) {
    const confirmationId = (await c.query<{ id: string }>("SELECT id FROM studio_confirmations WHERE project_id=$1 AND entity_id=$2 AND version=$3 AND stage='material'", [projectId, source.entityId, source.version])).rows[0]?.id;
    requireCondition(confirmationId, 'SCENARIO_SOURCE_UNCONFIRMED', 'Requirement sources must identify an accepted scenario version', 409);
    await c.query('INSERT INTO studio_requirement_sources(project_id,confirmation_id,scenario_id,scenario_confirmation_id) VALUES($1,$2,$3,$4)', [projectId, event.id, source.entityId, confirmationId]);
  }
```

注意：`metadata.kind === 'requirement'` 处 `metadata` 类型现为联合，BuiltinScenarioMetadata 不会进入此路径（内置不经过 saveConfirmation 的用户分支），无需额外收窄——TS 上 `metadata.kind` 判别后即可访问 `templateRef` 等字段；如有残余类型错误，用 `metadata.kind === 'scenario' || metadata.kind === 'requirement'` 判别收窄。

- [x] **Step 5: 新增纯 SQL 实体读取（供对比路径，不触发 Git）**

```ts
/** Control-row read without fixed-material hydration; comparison paths must not touch Git. */
export async function entityRow(c: Transaction, projectId: string, id: string): Promise<Row> {
  const row = (await c.query<Row>('SELECT * FROM studio_entities WHERE project_id=$1 AND id=$2', [projectId, id])).rows[0];
  requireCondition(row, 'ENTITY_NOT_FOUND', 'Entity was not found', 404); return row;
}
```

- [x] **Step 6: 更新 `check-transactions.ts` 并运行 schema 回归**

`apps/collaboration-api/src/persistence/check-transactions.ts`：删除 `project.categories` 赋值（:32）与 `categoryId`（:40）；`initial` 实体字面量删 `frozenBy/associationRevision`；把编号检查泛化为 scenario+requirement 双类型（各调 `reserveEntityNumber`，断言 `SC-`/`REQ-` 前缀、回滚不回收、并发唯一）。

运行（需先按“验证环境准备”建库）：

```bash
SCENARIO_SCHEMA_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/eadp_scenario_schema_check_wave1 node --test tests/collaboration/scenario-schema.test.mjs
SCENARIO_TRANSACTION_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/eadp_scenario_transaction_check_wave1 pnpm --filter @eadp/collaboration-api check:transactions
pnpm --filter @eadp/collaboration-api exec tsx --test src/persistence/*.test.ts
```
预期：schema 套件全过（对比表/编号/预置互斥回归）；事务检查通过。

- [x] **Step 7: 提交**

```bash
git add apps/collaboration-api/src/persistence/repository.ts apps/collaboration-api/src/persistence/check-transactions.ts
git commit -m "持久层对齐目标 schema：双类型编号、去分类与冻结列、前置确认引用、来源封存"
```

---

### Task 3: 模块与服务层去批次化，接入 REQ 编号与需求模板

**Files:**
- Modify: `apps/collaboration-api/src/modules/occupations.ts`、`visibility.ts`、`templates.ts`、`repairs.ts`、`integration.ts`
- Modify: `apps/collaboration-api/src/service.ts`、`gitlab-content.ts`
- Test: `apps/collaboration-api/src/modules/integration.test.ts`、`apps/collaboration-api/src/gitlab-content.test.ts`（先改测试看失败）

**Interfaces:**
- Consumes: Task 1/2 的契约与持久层。
- Produces:
  - `occupations.claim/release/finishOccupation/checkBoundInputs/updateRelations`：无 scenario-batch/frozenBy/associationRevision；builtin 实体拒绝占用
  - `GitLabContent.loadProjectTemplates(...)` 返回 `{ scenarios: ProjectTemplates; requirements: ProjectTemplates }`（`ProjectTemplates` 形状不变）；`verifyTemplate(actor, gitlabProjectId, kind: 'scenario' | 'requirement', fixed, templateId?)`；`verifyBinding(gitlab, content, actor, project, kind, input)`
  - `service.reserve`：scenario 与 requirement 都经 `reserveEntityNumber`；requirement 校验需求模板目录并绑定；无分类校验、无批次分支

- [x] **Step 1: 先改测试（失败先行）**

`integration.test.ts`：fixture 的 `project` 删 `categories`；`scenario()`/`requirement()` 实体删 `frozenBy/associationRevision`；`metadata()` 的 requirement 分支（:17）改 `{ ...common, kind: 'requirement', templateId: 'requirement-default', templateRef: { commitSha: fixed.commitSha, path: '.template/requirement-default.md', sha256: '0'.repeat(64) } }`；删除 :29 的批次改写用例，改为「已确认场景以普通 design 占用独立修订确认可通过」用例。

`gitlab-content.test.ts`：fixture 实体/项目（:32-34）同步去 categoryId/categories/frozenBy/associationRevision；:22、:81、:289 的 `scenario-batch` 相关用例删除；ReserveEntitySchema 断言（:191-196）改写为：

```ts
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'scenario' }), true);
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'requirement', sources: [{ projectId: 'project-1', entityId: 'source-1', version: 1 }] }), false); // 缺模板绑定
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'requirement', templateId: 'requirement-default', templateRef, sources: [{ projectId: 'project-1', entityId: 'source-1', version: 1 }] }), true);
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'requirement', templateId: 'requirement-default', templateRef, sources: [] }), false);
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'scenario', categoryId: 'x' } as never), false); // 白名单拒绝多余字段
```

运行 `pnpm --filter @eadp/collaboration-api exec tsx --test src/modules/integration.test.ts src/gitlab-content.test.ts` 确认失败。

- [x] **Step 2: occupations.ts 去批次（整体替换关键函数）**

删除 `assertNotFrozen`（:14）。`claim`（:15-35）替换为：

```ts
export async function claim(c: Transaction, projectId: string, all: EntityView[], id: string, actor: Actor, input: ClaimRequest): Promise<EntityView> {
  const value = entity(all, id);
  requireCondition(!value.builtinKey, 'BUILTIN_SCENARIO_IMMUTABLE', 'The built-in general scenario cannot be occupied or edited', 409);
  requireCondition(value.revision === input.expectedRevision, 'REVISION_CONFLICT', 'Entity revision has changed');
  requireCondition(!value.occupation, 'ALREADY_OCCUPIED', 'Entity already has an active persistent occupation');
  const bindings = input.purpose === 'prototype' ? prototypeBindings(value, all) : [];
  value.revision++; value.generation++; value.taskStatus = 'active';
  const occupation: OccupationView = { occupationId: newId(), generation: value.generation, taskId: input.taskId, clientId: input.clientId, expectedRevision: value.revision, entityId: id, ownerId: actor.id, purpose: input.purpose, inputVersion: value.materialVersion, prerequisiteBindings: bindings, createdAt: now() };
  value.occupation = occupation;
  await saveOccupation(c, projectId, occupation);
  await saveEntity(c, projectId, value);
  return value;
}
```

`finishOccupation`（:45-53）删 :50 的 frozenBy 清理循环。`checkBoundInputs`（:54-59）删 :58 的关联场景占用阻断。`updateRelations`（:60-75）：删 `assertNotFrozen` 调用与 :72 的关联场景冻结/associationRevision 循环，替换为仅校验场景可用：

```ts
  for (const sceneId of new Set([...value.scenarioIds, ...input.scenarioIds])) { const scene = entity(all, sceneId); requireCondition(scene.kind === 'scenario', 'SCENARIO_SOURCE_REQUIRED', 'Requirement sources must identify scenarios'); }
```

（其余逻辑不变：design 占用 + requirement、validatePrerequisites、来源逐一 `fixedVersion` 真实读出。）同时在 `updateRelations` 开头加 `requireCondition(!value.builtinKey, 'BUILTIN_SCENARIO_IMMUTABLE', ...)`——虽需求才走此路径，防御性保留。

- [x] **Step 3: visibility.ts / templates.ts / repairs.ts**

`visibility.ts:7-8`：destructuring 与返回列表删 `frozenBy, associationRevision`，增 `builtinKey`。

`templates.ts:20` 替换（需求也可显式切换模板，内置场景不可）：

```ts
  requireCondition((value.kind === 'scenario' || value.kind === 'requirement') && !value.builtinKey && occupation.purpose === 'design', 'TEMPLATE_BINDING_REQUIRES_DESIGN', 'Template binding requires an owned material design task');
```

`verifyBinding`（:11-16）签名加 `kind: 'scenario' | 'requirement'`，内部 `content.verifyTemplate(actor, project.gitlabProjectId, kind, input.templateRef, input.templateId)`。审计动作名 `scenario.template-bound` 改 `material.template-bound`。

`repairs.ts:37`：`['design', 'scenario-batch']` 改 `'design'` 单值比较，并在同处加 builtin 拒绝。

- [x] **Step 4: integration.ts 去批次（精确替换）**

1. 删除 `validateBatch`（:22-32）。
2. `validateSources`（:33-45）：删 `pending` 分支（:41-42），保留：

```ts
  for (const source of scenarioSources) {
    const scenario = repository.entity(all, source.entityId);
    requireCondition(scenario.kind === 'scenario' && source.version <= scenario.materialVersion && source.version > 0, 'SCENARIO_VERSION_MISMATCH', 'Requirement source must bind an accepted scenario version');
  }
```

3. `validateConfirmation`：删 :55 的 categories 校验；:56 模板绑定检查推广到需求：

```ts
  if (value.kind === 'scenario' || value.kind === 'requirement') requireCondition(value.templateId === metadata.templateId && canonical(value.templateRef) === canonical(metadata.templateRef), 'TEMPLATE_BINDING_CHANGED', 'Material confirmation must bind its selected fixed template');
```

:63 的场景占用豁免改为无批次特判：`requireCondition(scenario.kind === 'scenario' && !scenario.occupation, 'SCENARIO_UNAVAILABLE', 'Related scenario is being revised')`——注意：设计规定源场景独立修订不构成冻结（§3「源场景正在独立修订不构成整体冻结，仍可绑定明确已接受版本」），因此**删除整个场景占用检查**，只保留 `scenario.kind === 'scenario'`。
4. `validateIntegration`（:76-93）：删 :85-88 的批次/强制同批分支，统一为：

```ts
  requireCondition(input.stage === 'prototype' ? occupation.purpose === 'prototype' : occupation.purpose === 'design', 'OCCUPATION_PURPOSE_MISMATCH', 'Integration stage does not match occupation purpose');
  checkBoundInputs(root, all);
  requireCondition(input.confirmations.length === 1 && input.confirmations[0]!.entityId === root.id, 'SINGLE_ENTITY_REQUIRED', 'Integration confirms exactly its occupied entity', 422);
```

（:83-84 的 DUPLICATE_CONFIRMATION/ROOT_CONFIRMATION_REQUIRED 由上行覆盖，可删。）
5. `complete`（:127-149）：:136-140 的排序循环与 associationRevision 推进替换为单确认：

```ts
    if (input.stage === 'prototype') ids.push(await completePrototype(c, project, root, actor, operation, input));
    else {
      const confirmation = input.confirmations[0]!;
      const value = repository.entity(all, confirmation.entityId);
      const event = await confirmMaterial(c, project.id, value, confirmation, materialFor(confirmation, materials), actor, value.id === root.id, operation.id); ids.push(event.id);
      if (confirmation.confirmationMethod === 'ai-repair') await completeRepair(c, confirmation.repairTaskId, actor);
    }
    await finishOccupation(c, project.id, all, root, 'completed', actor);
```

6. `confirmMaterial`（:110-116）：删 `value.categoryId = metadata.categoryId;`。
7. import 清理：删 `assertNotFrozen` 引用。

- [x] **Step 5: service.ts 改写**

1. `reserve`（:81-130）替换核心段：

```ts
  async reserve(actor: Actor, projectId: string, input: ReserveEntityRequest) {
    const bound = await this.authorize(actor, projectId, true);
    const replay = await this.replay(actor, projectId, 'entity.reserve', input);
    if (replay.found) return replay.result as EntityView;
    let template: { templateId: string; templateRef: FixedReference } | undefined;
    if (input.kind === 'scenario' || input.kind === 'requirement') {
      const catalogs = await this.content.loadProjectTemplates(actor, bound.gitlabProjectId, bound.recognizedHead!);
      const catalog = input.kind === 'scenario' ? catalogs.scenarios : catalogs.requirements;
      requireCondition(catalog.templates.length > 0, 'PROJECT_TEMPLATES_REQUIRED', `Publish the project ${input.kind} templates before creating a material`, 422);
      const selected = catalog.templates.find(t => t.id === (input.templateId ?? catalog.defaultTemplateId));
      requireCondition(selected, 'TEMPLATE_NOT_FOUND', 'Select an accepted project template', 422);
      requireCondition(!input.templateRef || canonical(input.templateRef) === canonical(selected.fixed), 'TEMPLATE_VERSION_MISMATCH', 'New materials bind the selected accepted project template');
      template = { templateId: selected.id, templateRef: selected.fixed };
    }
    const number = input.kind === 'scenario' || input.kind === 'requirement' ? await repository.reserveEntityNumber(this.database, projectId, input.kind, actor, input) : undefined;
    return this.mutate(actor, projectId, 'entity.reserve', input, async (c, project, all) => {
      requireCondition(project.recognizedHead === bound.recognizedHead, 'INTEGRATION_HEAD_CHANGED', 'Refresh accepted project configuration before creating a material');
      const sources = input.kind === 'requirement' ? input.sources : [];
      if (input.kind === 'requirement') {
        requireCondition(sources.length > 0 && new Set(sources.map(s => s.entityId)).size === sources.length, 'SCENARIO_SOURCE_REQUIRED', 'A requirement must bind one or more distinct accepted scenario versions', 422);
        for (const source of sources) {
          requireCondition(source.projectId === projectId, 'SCENARIO_SOURCE_REQUIRED', 'Requirement scenario sources must belong to the same project', 422);
          const scene = repository.entity(all, source.entityId);
          requireCondition(scene.kind === 'scenario' && scene.materialVersion >= source.version && source.version > 0, 'SCENARIO_VERSION_MISMATCH', 'Requirement sources must identify accepted scenario versions');
          await reuse.fixedVersion(c, projectId, scene.id, source.version);
        }
      }
      const value: EntityView = { id: number?.id ?? repository.newId(), kind: input.kind, title: input.title,
        ...(number ? { sequence: number.sequence, code: number.code } : {}), ...template,
        revision: 0, generation: 0, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'idle',
        scenarioIds: sources.map(s => s.entityId), ...(sources.length ? { scenarioSources: sources } : {}),
        prerequisites: [], authorId: actor.id };
      await repository.saveEntity(c, projectId, value);
      return repository.entity(await repository.entities(c, projectId), value.id);
    });
  }
```

2. `updateEntity`（:146-157）：删 `occupations.assertNotFrozen(value);` 行，加 `requireCondition(!value.builtinKey, 'BUILTIN_SCENARIO_IMMUTABLE', 'The built-in general scenario cannot be edited', 409);`。
3. `revisionImpact`（:159-168）：返回删 `associationRevision` 与 `frozenBy` 字段。
4. `verifySources`（:204-234）：删批次内挂起场景来源分支（:208-213 整段 if pendingScene）与 scenario-batch adoption 豁免（:225-228 的 if 块），保留同项目 fixedVersion 核验与跨项目 adoption 核验。
5. `bindTemplate`（:174-184）：先取实体 kind 再校验：

```ts
    const kind = await this.transact(actor, c => repository.entityRow(c, projectId, id)).then(row => row.kind as 'scenario' | 'requirement');
    await templates.verifyBinding(this.gitlab, this.content, actor, project, kind, input);
```

- [x] **Step 6: gitlab-content.ts 双模板目录与需求模板核验**

1. `loadProjectTemplates`（:34-48）返回双目录：

```ts
  async loadProjectTemplates(actor: Reader, gitlabProjectId: number, commitSha: string): Promise<{ scenarios: ProjectTemplates; requirements: ProjectTemplates }> {
    await this.gitlab.authorize(actor, gitlabProjectId);
    const manifest = await this.manifest(gitlabProjectId, commitSha);
    requireCondition(manifest.gitlabProjectId === gitlabProjectId, 'PROJECT_MANIFEST_IDENTITY_MISMATCH', 'Template manifest must belong to its GitLab project', 422);
    const load = async (catalog: TemplateCatalog | undefined): Promise<ProjectTemplates> => {
      // A project accepted before a catalog existed has none yet; the empty
      // catalog is a published state, not a read failure.
      if (!catalog) return { templates: [] };
      const templates: ProjectTemplates['templates'] = [];
      for (const template of catalog.templates) {
        const bytes = await this.file(gitlabProjectId, commitSha, template.path);
        requireCondition(utf8(bytes, 'INVALID_TEMPLATE_ENCODING').trim().length > 0, 'EMPTY_TEMPLATE', 'Project templates must contain Markdown text', 422);
        templates.push({ id: template.id, name: template.name, fixed: { commitSha, path: template.path, sha256: digest(bytes) } });
      }
      return { defaultTemplateId: catalog.defaultTemplateId, templates };
    };
    return { scenarios: await load(manifest.scenarioTemplates), requirements: await load(manifest.requirementTemplates) };
  }
  async verifyTemplate(actor: Reader, gitlabProjectId: number, kind: 'scenario' | 'requirement', fixed: FixedReference, templateId?: string): Promise<void> {
    const catalogs = await this.loadProjectTemplates(actor, gitlabProjectId, fixed.commitSha);
    const catalog = kind === 'scenario' ? catalogs.scenarios : catalogs.requirements;
    requireCondition(catalog.templates.some(t => (!templateId || t.id === templateId) && canonical(t.fixed) === canonical(fixed)), 'TEMPLATE_REFERENCE_MISMATCH', 'Template reference must match a fixed project catalog entry', 422);
  }
```

2. `verify()`（:74-81）：模板核验从仅 scenario 推广到 scenario+requirement：

```ts
    if (metadata.kind === 'scenario' || metadata.kind === 'requirement') {
      await this.verifyTemplate(actor, gitlabProjectId, metadata.kind, metadata.templateRef, metadata.templateId);
      if (metadata.templateRef.commitSha !== fixed.commitSha) {
        const ancestor = await this.gitlab.json<{ id: string }>(`/projects/${gitlabProjectId}/repository/merge_base?refs[]=${metadata.templateRef.commitSha}&refs[]=${fixed.commitSha}`);
        requireCondition(ancestor.id === metadata.templateRef.commitSha, 'TEMPLATE_HISTORY_MISMATCH', 'Bound template must belong to the fixed material history', 422);
      }
    }
```

3. :110 的 `input.stage === 'material' || input.stage === 'scenario-batch'` 改 `input.stage === 'material'`。
4. `verifyTemplateChange`（:160-173）支持双目录：

```ts
    const before = await this.manifest(gitlabProjectId, expectedHead), after = await this.manifest(gitlabProjectId, candidateSha);
    const { scenarioTemplates: oldScenarios, requirementTemplates: oldRequirements, ...oldIdentity } = before;
    const { scenarioTemplates: newScenarios, requirementTemplates: newRequirements, ...newIdentity } = after;
    requireCondition(canonical(oldIdentity) === canonical(newIdentity), 'TEMPLATE_MANIFEST_SCOPE', 'Template publication cannot change project identity or directory declarations', 422);
    // Publishing templates declares catalogs; a project context change does not.
    const publishesCatalog = diffs.some(d => d.new_path === 'project.assets.json' || d.new_path.startsWith('.template/'));
    requireCondition(newScenarios || newRequirements || !publishesCatalog, 'TEMPLATE_CATALOG_REQUIRED', 'Template publication must declare a project template catalog', 422);
    // A published template identity can never be removed from its catalog.
    for (const [oldCatalog, newCatalog] of [[oldScenarios, newScenarios], [oldRequirements, newRequirements]] as const) {
      requireCondition((oldCatalog?.templates ?? []).every(t => (newCatalog?.templates ?? []).some(n => n.id === t.id && n.path === n.path)), 'TEMPLATE_DELETE_FORBIDDEN', 'Published template identities must remain in the project catalog', 422);
    }
    const catalog = [...(newScenarios?.templates ?? []), ...(newRequirements?.templates ?? [])];
    requireCondition(diffs.every(d => !d.deleted_file && !d.renamed_file && (d.new_path === 'project.assets.json' || d.new_path === PROJECT_CONTEXT_PATH || catalog.some(t => t.path === d.new_path))), 'TEMPLATE_PATH_SCOPE', 'Template publication cannot delete templates or change files outside the catalog and project context', 422);
    await this.loadProjectTemplates(actor, gitlabProjectId, candidateSha);
```

5. `service.projectTemplates`（:170-173）随行展开：`return { acceptedHead: project.recognizedHead, ...await this.content.loadProjectTemplates(...) }` 现在返回 `{ acceptedHead, scenarios, requirements }`。

- [x] **Step 7: 运行单元测试与类型检查**

```bash
pnpm --filter @eadp/collaboration-api typecheck
pnpm --filter @eadp/collaboration-api exec tsx --test src/*.test.ts src/auth/*.test.ts src/modules/*.test.ts src/persistence/*.test.ts
```
预期全绿（studio-plugin 红属预期，Task 6 处理）。

- [x] **Step 8: 提交**

```bash
git add apps/collaboration-api/src
git commit -m "协同后台去批次化：独立占用与确认、REQ 编号、需求模板绑定、内置场景防改写"
```

---

### Task 4: 通用场景系统预置接受

**Files:**
- Modify: `apps/collaboration-api/src/projects.ts`、`project-initialization.ts`、`service.ts`（transact 增加 loadBuiltin）、`persistence/repository.ts`（loadBuiltin 上下文 + strip/hydrate 例外）
- Modify: `apps/collaboration-api/src/gitlab-content.ts`（`readBuiltinScenario`）
- Test: `apps/collaboration-api/src/project-initialization.test.ts`、`tests/collaboration/backend-lifecycle.test.ts`

**Interfaces:**
- Produces:
  - `verifyProjectInitialization(...)` 返回 `Promise<{ generalFixed: FixedReference }>`（原 void）
  - `RepositoryContext.loadBuiltin?: (projectId, fixed: FixedReference, entityId: string) => Promise<BuiltinScenarioMetadata>`
  - `GitLabContent.readBuiltinScenario(actor, gitlabProjectId, fixed, entityId): Promise<BuiltinScenarioMetadata>`
  - `ProjectView.generalScenario` 在项目创建（assigned）后即可见

- [x] **Step 1: 先写失败测试**

`project-initialization.test.ts` 扩展 fixture（GitLab HTTP fixture 已有 tree/blob 模拟），新增用例：
- 初始化提交缺 `场景/通用场景.md` → `GENERAL_SCENARIO_REQUIRED`
- 文件正文与 `generalScenarioDocument(reservedId)` 差一个字符 → `GENERAL_SCENARIO_MISMATCH`
- metadata 中 entityId 不是预留身份 → `GENERAL_SCENARIO_MISMATCH`
- 正确文档 → 通过且返回 `generalFixed.sha256` 与实际字节一致
- manifest 缺 `requirementTemplates` → `INITIALIZATION_TEMPLATES_REQUIRED`

运行确认失败。

- [x] **Step 2: 创建项目时预留通用场景身份（projects.ts）**

在 `createProject` 的 assigned 事务（:94-98）内、audit 之前插入：

```ts
        await c.query("INSERT INTO studio_project_counters(project_id,kind) VALUES($1,'scenario') ON CONFLICT(project_id,kind) DO NOTHING", [pending.id]);
        const reserved = await c.query<{ sequence: string }>("UPDATE studio_project_counters SET next_sequence=next_sequence+1 WHERE project_id=$1 AND kind='scenario' RETURNING next_sequence-1 AS sequence", [pending.id]);
        const sequence = Number(reserved.rows[0]!.sequence);
        await c.query(`INSERT INTO studio_entity_numbers(project_id,kind,sequence,code,operation_key,entity_id,request_hash,creator_id,creator_account,creator_name) VALUES($1,'scenario',$2,$3,'general-scenario',$4,$5,$6,$7,$8) ON CONFLICT(project_id,operation_key) DO NOTHING`,
          [pending.id, sequence, `SC-${String(sequence).padStart(4, '0')}`, randomUUID(), repository.requestHash({ generalScenario: pending.id }), actor.id, actor.username, actor.name]);
```

（ON CONFLICT 兜底：assigned 事务只会执行一次，重试在 :51 提前返回。）

- [x] **Step 3: 初始化核验通用场景文件（project-initialization.ts）**

1. import 增 `generalScenarioDocument`（来自 `@eadp/asset-domain`）与 `FixedReference` 类型。
2. 函数签名改 `Promise<{ generalFixed: FixedReference }>`；:36 的目录校验改为要求双目录：

```ts
  requireCondition(manifest.scenarioTemplates && manifest.requirementTemplates, 'INITIALIZATION_TEMPLATES_REQUIRED', 'Initialization must declare the project scenario and requirement template catalogs', 422);
```

3. 在 :37（loadProjectTemplates）之后、分支头复核之前追加：

```ts
  const scenarioEntries = await gitlab.list(`${prefix}/tree?ref=${commitSha}&path=${encodeURIComponent('场景')}`);
  const generalEntry = scenarioEntries.find(e => record(e) && e.name === '通用场景.md' && e.type === 'blob');
  requireCondition(generalEntry && typeof generalEntry.id === 'string' && /^[a-f0-9]{40}$/.test(generalEntry.id), 'GENERAL_SCENARIO_REQUIRED', 'Initialization requires the provisioned general scenario document', 422);
  const generalBytes = await gitlab.bytes(`${prefix}/blobs/${generalEntry.id}/raw`, 64 * 1024);
  requireCondition(createHash('sha1').update(`blob ${generalBytes.length}\0`).update(generalBytes).digest('hex') === generalEntry.id, 'GENERAL_SCENARIO_MISMATCH', 'General scenario bytes differ from the fixed Git blob', 422);
  requireCondition(!(generalBytes[0] === 0xef && generalBytes[1] === 0xbb && generalBytes[2] === 0xbf) && !generalBytes.includes(13), 'GENERAL_SCENARIO_MISMATCH', 'General scenario must use UTF-8 without BOM and LF line endings', 422);
  requireCondition(project.generalScenario, 'GENERAL_SCENARIO_UNRESERVED', 'The project has no reserved general scenario identity', 409);
  const generalText = new TextDecoder('utf-8', { fatal: true }).decode(generalBytes);
  requireCondition(generalText === generalScenarioDocument(project.generalScenario.entityId), 'GENERAL_SCENARIO_MISMATCH', 'General scenario content does not match the reserved identity and provisioned document', 422);
```

4. 末尾 `return { generalFixed: { commitSha, path: '场景/通用场景.md', sha256: createHash('sha256').update(generalBytes).digest('hex') } };`

- [x] **Step 4: 初始化事务写入预置接受（projects.ts initializeProject）**

:122-129 替换为：

```ts
    const { generalFixed } = await verifyProjectInitialization(this.gitlab, actor, project, input.commitSha);
    return transaction(this.database, async c => {
      const current = await repository.project(c, projectId, true), replay = await repository.previous(c, projectId, actor, 'project.initialize', input);
      if (replay.found) return replay.result as ProjectView;
      requireCondition(current.initializationStatus === 'pending' && current.recognizedHead === null, 'PROJECT_ALREADY_INITIALIZED', 'The project is already initialized', 409);
      const reserved = current.generalScenario;
      requireCondition(reserved, 'GENERAL_SCENARIO_UNRESERVED', 'The project has no reserved general scenario identity', 409);
      const initializationId = randomUUID(), confirmationId = randomUUID();
      await c.query(`INSERT INTO studio_project_initializations(id,project_id,operation_key,request_hash,commit_sha,creator_id,creator_account,creator_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [initializationId, projectId, input.idempotencyKey, repository.requestHash(input), input.commitSha, actor.id, actor.username, actor.name]);
      const sequence = Number((await c.query<{ sequence: string }>('SELECT sequence FROM studio_entity_numbers WHERE project_id=$1 AND entity_id=$2', [projectId, reserved.entityId])).rows[0]!.sequence);
      await c.query(`INSERT INTO studio_entities(project_id,id,kind,builtin_key,sequence,code,title,summary,revision,generation,material_version,confirmation_status,task_status,current_confirmation_id,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name) VALUES($1,$2,'scenario','general',$3,$4,$5,$6,1,0,1,'confirmed','idle',$7,$8,$9,$10,$8,$9,$10)`,
        [projectId, reserved.entityId, sequence, reserved.code, GENERAL_SCENARIO_TITLE, GENERAL_SCENARIO_SUMMARY, confirmationId, actor.id, actor.username, actor.name]);
      await c.query(`INSERT INTO studio_confirmations(id,project_id,entity_id,version,stage,revision,title,summary,commit_sha,path,sha256,acceptance_kind,initialization_id,source_count) VALUES($1,$2,$3,1,'material',1,$4,$5,$6,$7,$8,'system-provisioned',$9,0)`,
        [confirmationId, projectId, reserved.entityId, GENERAL_SCENARIO_TITLE, GENERAL_SCENARIO_SUMMARY, generalFixed.commitSha, generalFixed.path, generalFixed.sha256, initializationId]);
      current.initializationStatus = 'ready'; current.recognizedHead = input.commitSha; current.revision++;
      await repository.saveProject(c, current);
      await repository.remember(c, projectId, actor, 'project.initialize', input, current);
      return current;
    });
```

import 增 `GENERAL_SCENARIO_TITLE, GENERAL_SCENARIO_SUMMARY`（`@eadp/asset-domain`）。事务顺序满足触发器：initialization guard 要求 state='assigned'（saveProject 之前成立）；提交时延迟触发器核验不变量。

- [x] **Step 5: 内置固定读取路径（repository.ts + gitlab-content.ts + service.ts）**

1. `RepositoryContext`（repository.ts:11-14）增 `loadBuiltin?: (projectId: string, fixed: FixedReference, entityId: string) => Promise<BuiltinScenarioMetadata>`；新增：

```ts
export async function loadBuiltin(projectId: string, fixed: FixedReference, entityId: string): Promise<BuiltinScenarioMetadata> {
  const loader = context().loadBuiltin;
  requireCondition(loader, 'FIXED_CONTENT_LOADER_REQUIRED', 'Accepted material must be read from its fixed Git version', 500);
  return loader(projectId, fixed, entityId);
}
```

2. `fixedVersionOf`（:172-175）：`metadata:` 改为按接受途径分流（versionRows 的 `f.*` 已含 `acceptance_kind`），并对内置版本打标：

```ts
async function fixedVersionOf(projectId: string, row: Row): Promise<FixedVersion> {
  const fixed = fixedReference(row);
  const builtin = row.acceptance_kind === 'system-provisioned';
  return { version: Number(row.version), fixed,
    metadata: builtin ? await loadBuiltin(projectId, fixed, String(row.entity_id)) : await loadMaterial(projectId, fixed),
    ...(builtin ? { builtin: true } : {}),
    confirmationId: String(row.id), confirmedBy: Number(row.creator_id ?? 0), confirmedAt: date(row.created_date), title: String(row.title), summary: String(row.summary), applicability: row.applicability as 'applicable' | 'not-applicable', ...(row.applicability_reason ? { applicabilityReason: String(row.applicability_reason) } : {}), ...(row.read_hash ? { readHash: String(row.read_hash) } : {}), reuse: { enabled: Boolean(row.enabled), reason: String(row.reason) }, ...(row.baseline_id ? { prototypeBaselineId: String(row.baseline_id) } : {}) };
}
```

注意 `studio_eligibility` 对内置场景不存在行（guard 禁止 enabled；初始化也不写）——检查 versionRows 的 JOIN：`JOIN studio_eligibility e USING(...)` 是内连接，内置版本无 eligibility 行会被过滤掉！修正：对 system-provisioned 行改 LEFT JOIN 语义。把 `versionRows`（:168-170）的 JOIN 改 `LEFT JOIN studio_eligibility e USING(project_id,entity_id,version)`，并在 `fixedVersionOf` 中 `reuse: { enabled: Boolean(row.enabled), reason: String(row.reason ?? (builtin ? 'System provisioned' : '')) }`。同时在 initialize 事务中补一行 eligibility 反而更贴合现有形状——**决定**：initialize 事务补插 `studio_eligibility(project_id,entity_id,version,enabled,reason,...)` = `(…,1,true,'System provisioned', actor…)`？schema guard `studio_builtin_eligibility_guard` 禁止 `NEW.enabled=true` 对内置场景！所以不能插 enabled=true；插 enabled=false 又会被复用资格误读。**最终方案**：保持 LEFT JOIN，内置版本 `reuse: { enabled: false, reason: 'Built-in scenario is provisioned by initialization' }`。eligibility 表对内置场景无行。

3. `stripMaterial`/`hydrateResult` 例外（:239-263）：strip 时内置版本保留 metadata；hydrate 跳过内置：

```ts
function stripMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMaterial);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const keepMetadata = source.builtin === true;
  const result = Object.fromEntries(Object.entries(source).filter(([key]) => (keepMetadata && key === 'metadata') || !['metadata', 'body', 'businessEvidence', 'openQuestions', 'files', 'evidence', 'coreRulesPresent', 'acceptanceCriteriaPresent'].includes(key)).map(([key, item]) => [key, stripMaterial(item)]));
  if (typeof source.id === 'string' && typeof source.kind === 'string' && Array.isArray(source.files)) result.fileProjectionFromCurrent = true;
  return result;
}
```
`hydrateResult` 中 :256 改 `if (source.fixed && source.version && source.confirmationId && source.builtin !== true) result.metadata = await loadMaterial(...)`。

4. `GitLabContent.readBuiltinScenario`：

```ts
  /** Strict provisioned-content read; selected by persisted acceptance kind, never as a parse fallback. */
  async readBuiltinScenario(actor: Reader, gitlabProjectId: number, fixed: FixedReference, entityId: string): Promise<BuiltinScenarioMetadata> {
    await this.gitlab.authorize(actor, gitlabProjectId);
    const bytes = await this.file(gitlabProjectId, fixed.commitSha, fixed.path);
    requireCondition(digest(bytes) === fixed.sha256, 'CONTENT_HASH_MISMATCH', 'Fixed Git material does not match the confirmed SHA-256', 422);
    return parseBuiltinScenario(utf8(bytes, 'INVALID_MATERIAL_ENCODING'), entityId);
  }
```

5. `service.transact`（:23-36）的 `withContext` 增：

```ts
        loadBuiltin: async (projectId, fixed, entityId) => {
          const project = await repository.project(c, projectId);
          return this.content.readBuiltinScenario(actor, project.gitlabProjectId, fixed, entityId);
        },
```

- [x] **Step 6: 运行测试**

```bash
pnpm --filter @eadp/collaboration-api typecheck
pnpm --filter @eadp/collaboration-api exec tsx --test src/project-initialization.test.ts src/*.test.ts src/modules/*.test.ts src/persistence/*.test.ts src/auth/*.test.ts
STUDIO_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/eadp_auth_check_wave1 pnpm --filter @eadp/collaboration-api exec tsx --test ../../tests/collaboration/backend-lifecycle.test.ts
```

`backend-lifecycle.test.ts` 初始化用例需先行扩展（随 Step 1 一起改）：创建项目后 GET state 断言 `project.generalScenario.code === 'SC-0001'`；初始化成功后断言目录含 builtinKey='general' 实体、`confirmationStatus='confirmed'`、且对其 `claim` 返回 `BUILTIN_SCENARIO_IMMUTABLE`；重复 initialize 重放返回同一项目视图不重复预置。

- [x] **Step 7: 提交**

```bash
git add apps/collaboration-api/src tests/collaboration/backend-lifecycle.test.ts
git commit -m "项目初始化系统预置通用场景：身份预留、固定内容字节核验、接受事实同事务落库"
```

---

### Task 5: 一致性对比 API

**Files:**
- Modify: `apps/collaboration-api/src/persistence/repository.ts`（对比持久化与目录投影）
- Modify: `apps/collaboration-api/src/service.ts`、`routes.ts`
- Test: `tests/collaboration/backend-comparisons.test.ts`（新建）、`apps/collaboration-api/src/gitlab-content.test.ts`（补 SubmitConsistencyComparisonSchema 白名单断言）

**Interfaces:**
- Consumes: Task 1 契约、Task 2 `entityRow`。
- Produces:
  - `repository.saveComparison(c, projectId, actor, input): Promise<ConsistencyComparisonView>`（表自带 operation_key 幂等；重复同请求返回已存视图）
  - `repository.listComparisons(c, projectId, { entityId?, limit, offset }): Promise<ConsistencyComparisonView[]>`
  - `repository.getComparison(c, projectId, id): Promise<ConsistencyComparisonView>`
  - `repository.consistencyContext(c, projectId, entityId): Promise<ConsistencyContextView>`
  - `service.submitComparison / listComparisons / getComparison / consistencyContext`
  - 路由：`POST /v1/projects/:projectId/consistency-comparisons`、`GET …/consistency-comparisons`、`GET …/consistency-comparisons/:comparisonId`、`GET …/entities/:entityId/consistency-context`

- [x] **Step 1: 先建失败测试 `tests/collaboration/backend-comparisons.test.ts`**

复用 `backend-scenarios.test.ts` 的启动夹具（GitLab HTTP fixture + 临时库初始化项目）。用例清单（对应 R15/R20/R21/R23/R24/R25 后台部分）：
1. 手动提交 completed+complete+2 条冲突 → 200，视图含 conflicts 且 conflictCount=2；再 GET 列表/详情一致。
2. 同 operationKey 同请求体重传 → 返回同一 comparisonId 视图，不产生新记录；同 key 不同请求体 → 409 `IDEMPOTENCY_CONFLICT`。
3. trigger='confirmation' 带真实 confirmationId → 接受；同 confirmation 第二次自动对比 → 409 `AUTO_COMPARISON_RECORDED`；trigger='confirmation' 带其他实体的 confirmationId → 422 `COMPARISON_CONFIRMATION_MISMATCH`；trigger='manual' 带 confirmationId → 400（契约拒绝）。
4. 白名单：多余字段、summary 501 字符、conflicts 101 条、entities 101 个、ordinal=0、sha256 非 64 位小写（本契约不含 sha 字段，改验 id 非法字符）→ 400。
5. failed 必须带非空 summary 与非 cancelled 失败码；cancelled 的 failureCode 必须为 'cancelled'；completed 不得带 failureCode → 400。
6. 冲突涉及不存在实体 → 404 `ENTITY_NOT_FOUND`。
7. 无写权限成员（Reporter）提交 → 403；无读权限非成员查询 → 403/404。
8. `GET entities/:id/consistency-context`：场景视角返回关联需求列表及其固定来源（version+confirmationId+fixed）；需求视角返回 sources 与 prerequisites（含 confirmationId）；全程不触发 Git（fixture 断言无 content 请求——GitLab fixture 记录请求路径，断言无 `/repository/files` 调用）。
9. 冲突无处理状态：尝试 PATCH/PUT 对比或冲突路由 → 404。

运行确认全部失败（路由 404）。

- [x] **Step 2: repository 对比持久化（追加到 repository.ts 末尾）**

```ts
async function comparisonView(c: Transaction, row: Row): Promise<ConsistencyComparisonView> {
  const conflicts: ConsistencyConflictView[] = [];
  const conflictRows = (await c.query<Row>('SELECT * FROM studio_consistency_conflicts WHERE project_id=$1 AND comparison_id=$2 ORDER BY ordinal', [row.project_id, row.id])).rows;
  for (const conflict of conflictRows) {
    const entities = (await c.query<{ entity_id: string }>('SELECT entity_id FROM studio_consistency_conflict_entities WHERE project_id=$1 AND comparison_id=$2 AND conflict_id=$3 ORDER BY ordinal', [row.project_id, row.id, conflict.id])).rows.map(r => r.entity_id);
    conflicts.push({ id: String(conflict.id), ordinal: Number(conflict.ordinal), summary: String(conflict.summary), relation: conflict.relation as 'formal' | 'potential', entities });
  }
  return { id: String(row.id), entityId: String(row.entity_id), trigger: row.trigger as 'manual' | 'confirmation',
    ...(row.confirmation_id ? { confirmationId: String(row.confirmation_id) } : {}),
    result: row.result as ConsistencyComparisonView['result'], coverage: row.coverage as ConsistencyComparisonView['coverage'],
    ...(row.failure_code ? { failureCode: row.failure_code as ComparisonFailure } : {}),
    summary: String(row.summary), conflictCount: Number(row.conflict_count), creator: snapshot(row, 'creator'), createdAt: date(row.created_date), conflicts };
}
/** Atomically store one comparison and its sealed conflict set; the operation key makes submission idempotent. */
export async function saveComparison(c: Transaction, projectId: string, actor: Actor, input: SubmitConsistencyComparisonRequest): Promise<ConsistencyComparisonView> {
  const hash = requestHash(input);
  const existing = (await c.query<Row>('SELECT * FROM studio_consistency_comparisons WHERE project_id=$1 AND operation_key=$2', [projectId, input.idempotencyKey])).rows[0];
  if (existing) {
    requireCondition(Number(existing.creator_id) === actor.id && existing.request_hash === hash, 'IDEMPOTENCY_CONFLICT', 'The comparison operation key already belongs to another request', 409);
    return comparisonView(c, existing);
  }
  requireCondition(input.conflicts.every((conflict, index) => conflict.ordinal === index + 1), 'CONFLICT_ORDINAL_SEQUENCE', 'Conflict ordinals must be a contiguous sequence starting at 1', 422);
  try {
    await c.query(`INSERT INTO studio_consistency_comparisons(id,project_id,entity_id,trigger,confirmation_id,operation_key,request_hash,result,coverage,failure_code,summary,conflict_count,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [input.id, projectId, input.entityId, input.trigger, input.trigger === 'confirmation' ? input.confirmationId : null, input.idempotencyKey, hash, input.result, input.coverage, input.result === 'completed' ? null : input.failureCode, input.summary, input.conflicts.length, ...actorFields()]);
  } catch (error) {
    if ((error as { constraint?: string }).constraint === 'studio_one_auto_comparison') throw new DomainError('AUTO_COMPARISON_RECORDED', 'This confirmation already has an automatic comparison; query the original record', 409);
    throw error;
  }
  for (const conflict of input.conflicts) {
    await c.query(`INSERT INTO studio_consistency_conflicts(project_id,comparison_id,id,ordinal,summary,relation,entity_count) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [projectId, input.id, conflict.id, conflict.ordinal, conflict.summary, conflict.relation, conflict.entities.length]);
    for (const [index, entityId] of conflict.entities.entries()) {
      await c.query(`INSERT INTO studio_consistency_conflict_entities(project_id,comparison_id,conflict_id,ordinal,entity_id) VALUES($1,$2,$3,$4,$5)`,
        [projectId, input.id, conflict.id, index + 1, entityId]);
    }
  }
  const stored = (await c.query<Row>('SELECT * FROM studio_consistency_comparisons WHERE project_id=$1 AND id=$2', [projectId, input.id])).rows[0]!;
  return comparisonView(c, stored);
}
export async function listComparisons(c: Transaction, projectId: string, filter: { entityId?: string; limit: number; offset: number }): Promise<ConsistencyComparisonView[]> {
  const rows = filter.entityId
    ? (await c.query<Row>('SELECT * FROM studio_consistency_comparisons WHERE project_id=$1 AND entity_id=$2 ORDER BY created_date DESC,id DESC LIMIT $3 OFFSET $4', [projectId, filter.entityId, filter.limit, filter.offset])).rows
    : (await c.query<Row>('SELECT * FROM studio_consistency_comparisons WHERE project_id=$1 ORDER BY created_date DESC,id DESC LIMIT $2 OFFSET $3', [projectId, filter.limit, filter.offset])).rows;
  const result: ConsistencyComparisonView[] = [];
  for (const row of rows) result.push(await comparisonView(c, row));
  return result;
}
export async function getComparison(c: Transaction, projectId: string, id: string): Promise<ConsistencyComparisonView> {
  const row = (await c.query<Row>('SELECT * FROM studio_consistency_comparisons WHERE project_id=$1 AND id=$2', [projectId, id])).rows[0];
  requireCondition(row, 'COMPARISON_NOT_FOUND', 'Comparison was not found', 404);
  return comparisonView(c, row);
}
```

- [x] **Step 3: repository.consistencyContext（纯 SQL，不加载材料正文）**

```ts
/** Formal relation catalog for comparison inputs; control fields only, no Git reads. */
export async function consistencyContext(c: Transaction, projectId: string, entityId: string): Promise<ConsistencyContextView> {
  const target = await entityRow(c, projectId, entityId);
  const occupied = async (id: string) => Boolean((await c.query('SELECT id FROM studio_occupations WHERE project_id=$1 AND entity_id=$2 AND active', [projectId, id])).rowCount);
  const card = (row: Row) => ({ id: String(row.id), kind: row.kind as ConsistencyContextView['entity']['kind'], ...(row.builtin_key ? { builtinKey: 'general' as const } : {}), ...(row.code ? { code: String(row.code) } : {}), title: String(row.title), revision: Number(row.revision), materialVersion: Number(row.material_version), confirmationStatus: row.confirmation_status as 'draft' | 'confirmed' });
  const sources: ConsistencyContextView['sources'] = [];
  for (const row of (await c.query<Row>(`SELECT e.id,e.code,e.title,s.scenario_confirmation_id,f.version,f.commit_sha,f.path,f.sha256 FROM studio_entity_scenario_sources s JOIN studio_confirmations f ON f.id=s.scenario_confirmation_id JOIN studio_entities e ON e.project_id=f.project_id AND e.id=f.entity_id WHERE s.project_id=$1 AND s.entity_id=$2 ORDER BY e.sequence`, [projectId, entityId])).rows) {
    sources.push({ entityId: String(row.id), ...(row.code ? { code: String(row.code) } : {}), title: String(row.title), version: Number(row.version), confirmationId: String(row.scenario_confirmation_id), fixed: { commitSha: String(row.commit_sha), path: String(row.path), sha256: String(row.sha256) } });
  }
  const requirements: ConsistencyContextView['requirements'] = [];
  for (const row of (await c.query<Row>(`SELECT e.* FROM studio_scenario_requirements r JOIN studio_entities e ON e.project_id=r.project_id AND e.id=r.requirement_id WHERE r.project_id=$1 AND r.scenario_id=$2 ORDER BY e.sequence`, [projectId, entityId])).rows) {
    const requirementSources = (await c.query<Row>('SELECT f.entity_id,f.version FROM studio_entity_scenario_sources s JOIN studio_confirmations f ON f.id=s.scenario_confirmation_id WHERE s.project_id=$1 AND s.entity_id=$2', [projectId, row.id])).rows;
    requirements.push({ ...card(row), occupied: await occupied(String(row.id)), sources: requirementSources.map(s => ({ projectId, entityId: String(s.entity_id), version: Number(s.version) })) });
  }
  const prerequisites: ConsistencyContextView['prerequisites'] = [];
  for (const row of (await c.query<Row>(`SELECT p.requirement_id,p.version,p.confirmation_id,e.code,e.title FROM studio_prerequisites p JOIN studio_entities e ON e.project_id=p.project_id AND e.id=p.requirement_id WHERE p.project_id=$1 AND p.entity_id=$2 ORDER BY e.sequence`, [projectId, entityId])).rows) {
    prerequisites.push({ requirementId: String(row.requirement_id), ...(row.code ? { code: String(row.code) } : {}), title: String(row.title), version: Number(row.version), confirmationId: String(row.confirmation_id) });
  }
  return { entity: { ...card(target), occupied: await occupied(entityId) }, sources, requirements, prerequisites };
}
```

- [x] **Step 4: service 方法**

```ts
  async submitComparison(actor: Actor, projectId: string, input: SubmitConsistencyComparisonRequest) {
    await this.authorize(actor, projectId, true);
    return this.transact(actor, async c => {
      await repository.entityRow(c, projectId, input.entityId);
      if (input.trigger === 'confirmation') {
        const confirmation = await repository.confirmation(c, projectId, input.confirmationId);
        requireCondition(confirmation.event.entityId === input.entityId && confirmation.stage === 'material', 'COMPARISON_CONFIRMATION_MISMATCH', 'Automatic comparison must bind a material confirmation of its target', 422);
      }
      for (const conflict of input.conflicts) for (const involved of conflict.entities) await repository.entityRow(c, projectId, involved);
      const view = await repository.saveComparison(c, projectId, actor, input);
      await repository.audit(c, projectId, actor, 'consistency.submit', { comparisonId: view.id });
      return view;
    });
  }
  async listComparisons(actor: Actor, projectId: string, query: { entityId?: string; limit: number; offset: number }) {
    await this.authorize(actor, projectId);
    return this.transact(actor, c => repository.listComparisons(c, projectId, query));
  }
  async getComparison(actor: Actor, projectId: string, id: string) {
    await this.authorize(actor, projectId);
    return this.transact(actor, c => repository.getComparison(c, projectId, id));
  }
  async consistencyContext(actor: Actor, projectId: string, entityId: string) {
    await this.authorize(actor, projectId);
    return this.transact(actor, c => repository.consistencyContext(c, projectId, entityId));
  }
```

注意 `submitComparison` 用 `transact` 而非 `mutate`：对比记录表自带 operation_key 幂等，不写 `studio_operations`，避免双轨。

- [x] **Step 5: 路由（routes.ts:51 之后追加）**

```ts
  write('POST', `${base}/consistency-comparisons`, contract.SubmitConsistencyComparisonSchema, (a, p, b) => service.submitComparison(a, p.projectId!, b));
  app.get<{ Params: { projectId: string }; Querystring: Record<string, string> }>(`${base}/consistency-comparisons`, request => {
    const query = request.query, limit = Number(query.limit ?? '20'), offset = Number(query.offset ?? '0');
    requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0, 'INVALID_PAGINATION', 'Comparison queries require limit 1..100 and a non-negative offset', 422);
    if (query.entityId !== undefined) requireCondition(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(query.entityId) && query.entityId.length <= 100, 'INVALID_PAGINATION', 'Invalid entity filter', 422);
    return service.listComparisons(request.actor, request.params.projectId, { ...(query.entityId ? { entityId: query.entityId } : {}), limit, offset });
  });
  read(`${base}/consistency-comparisons/:comparisonId`, (a, p) => service.getComparison(a, p.projectId!, p.comparisonId!));
  read(`${base}/entities/:entityId/consistency-context`, (a, p) => service.consistencyContext(a, p.projectId!, p.entityId!));
```

（routes.ts 需 import `requireCondition`：现无引用，从 `@eadp/asset-domain` 引入。）

- [x] **Step 6: 运行新套件与全量后端测试**

```bash
STUDIO_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/eadp_auth_check_wave1 pnpm --filter @eadp/collaboration-api exec tsx --test ../../tests/collaboration/backend-comparisons.test.ts
```
预期全绿。

- [x] **Step 7: 提交**

```bash
git add apps/collaboration-api/src tests/collaboration/backend-comparisons.test.ts
git commit -m "一致性对比记录 API：白名单提交、表级幂等、关系目录投影，不经 Git"
```

---

### Task 6: 消费方机械适配（保持 workspace 可编译）

**Files:**
- Modify: `packages/studio-plugin/src/host/application/ports.ts`（:36-37 分类必填抛错）、`studio.ts`（:116 /categories 调用、:409/:415 分类强制、:807-834 候选链路）、`packages/studio-plugin/src/shared/studio.ts`（:34 Candidate、:68 selectCandidate 的 categoryId）
- Modify: `packages/studio-plugin/src/client/components/MaterialCatalog.tsx`、`MaterialEditor.tsx`、`StudioPanel.tsx`、`ScenarioChatPanel.tsx` 中对 `categoryId`/`categories`/`frozenBy`/`associationRevision` 的引用
- Test: `tests/gitlab-auth-host/`、`tests/windows-desktop/` 中引用旧字段的断言

**Interfaces:**
- Consumes: Task 1 契约。
- Produces: studio-plugin 编译通过；候选创建传 `templateId/templateRef`（取需求模板目录默认项）；**不实现**联合拆分、通用场景生成、双栏重构（波次二/三）。

- [x] **Step 1: 删除分类与批次引用**

逐处精确删除/改写（以编译错误清单为准推进）：`ports.ts` 的 initialMetadata 去 categoryId 校验；`studio.ts` 删 `/categories` 拉取与 `createMaterial` 的 categoryId 传参，需求创建改从 `projectTemplates().requirements` 取 `defaultTemplateId` 及对应 `fixed` 传入 `templateId/templateRef`；`shared/studio.ts` 的 `Candidate` 与 `selectCandidate` 删 `categoryId`。

- [x] **Step 2: 客户端组件去分类**

MaterialCatalog 删分类侧栏/筛选的渲染与状态（保留既有卡片/分页结构，波次三再按样稿重构）；MaterialEditor/StudioPanel/ScenarioChatPanel 删 categoryId 字段读写；`frozenBy`/`associationRevision` 的展示改为不渲染（冻结提示随批次删除）。

- [x] **Step 3: 测试同步与全量校验**

```bash
# studio-plugin 无独立 typecheck 脚本；其编译门禁为装配进 DSH 构建树后的 tsc -b
node apps/desktop-distribution/build/prepare-studio-plugin.mjs && pnpm --dir .local/build/dsh exec tsc -b
pnpm --filter @eadp/contracts typecheck && pnpm --filter @eadp/asset-domain typecheck && pnpm --filter @eadp/collaboration-api typecheck
pnpm --filter @eadp/collaboration-api exec tsx --test src/*.test.ts src/auth/*.test.ts src/modules/*.test.ts src/persistence/*.test.ts
node --test tests/gitlab-auth-host/ tests/windows-desktop/ tests/scripts/  # 按各套件实际入口
```
逐处修复引用旧字段的测试断言（删分类、frozenBy 相关断言，实体夹具补 `templateId/templateRef`）。

- [x] **Step 4: 提交**

```bash
git add packages/studio-plugin tests
git commit -m "消费方适配新契约：移除分类与批次字段引用，需求创建绑定需求模板"
```

---

### Task 7: DB 套件重写与文档收尾

**Files:**
- Modify: `tests/collaboration/backend-scenarios.test.ts`（重写分类/批次用例）、`backend-consistency.test.ts`（同步 reserve/claim 契约）、`studio-workflow.test.ts`（去 addCategory/categoryId :94-95/:113/:131）
- Modify: `apps/collaboration-api/README.md`（删分类、批次、`POST /categories` 描述，补对比端点与通用场景预置）
- Modify: `docs/milestones.md`（阶段二状态追加波次一记录）、`docs/design/02-requirements-wave1-plan.md`（勾选与偏差记录）

- [x] **Step 1: backend-scenarios.test.ts 重写**

- 删除 S21（:158-167 需求分类）、S23/S24（:168-191 批次冻结）及所有 `scenario-batch`/`frozenBy`/`expectedAssociationRevision`/`batchRequirementIds`/`categories` 引用（:53、:78、:90-99、:123、:177、:181、:187-188）。
- 新增/改写用例（对应 R01/R02/R04/R12/R13 后台部分）：
  - R01：需求 reserve 返回 `REQ-0001` 形编号与稳定 UUID；同 operationKey 重试返回同编号同 UUID；编号不因后续失败回收。
  - R02：改名（updateEntity）后编号不变；同项目重名需求各自获递增编号。
  - R04：空 sources、跨项目 source.entityId、version 大于已接受版本 → `SCENARIO_SOURCE_REQUIRED`/`SCENARIO_VERSION_MISMATCH`；缺 `templateId/templateRef` → 400。
  - 通用场景来源：绑定 builtin 场景 version 1 创建需求成功（fixedVersion 通道含系统预置读取）。
  - R12：关系写入构造自引用/重复/环 → `INVALID_PREREQUISITE`/`DUPLICATE_PREREQUISITE`/`DEPENDENCY_CYCLE`；绑定未接受版本的前置 → `PREREQUISITE_UNCONFIRMED`；文档确认不受未完成前置阻断（确认成功）。
  - R13：已确认场景直接以 design 占用独立修订并确认（无 BATCH_REQUIRED）；关联需求可独立占用/确认；打开/刷新不产生占用或来源升版。
  - 独立确认：单材料 integration（confirmations 长度 1）；长度 >1 → `SINGLE_ENTITY_REQUIRED`。
- [x] **Step 2: 同步其余套件**

`backend-consistency.test.ts`：reserve/claim 请求体去 categoryId/batch（:45-56）；`studio-workflow.test.ts` 删 `addCategory` 与 `categoryId` 参数。

- [x] **Step 3: 全量 DB 回归**

```bash
export STUDIO_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/eadp_auth_check_wave1
pnpm --filter @eadp/collaboration-api exec tsx --test ../../tests/collaboration/backend-lifecycle.test.ts ../../tests/collaboration/backend-consistency.test.ts ../../tests/collaboration/backend-scenarios.test.ts ../../tests/collaboration/backend-comparisons.test.ts
SCENARIO_SCHEMA_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/eadp_scenario_schema_check_wave1 node --test tests/collaboration/scenario-schema.test.mjs
SCENARIO_TRANSACTION_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/eadp_scenario_transaction_check_wave1 pnpm --filter @eadp/collaboration-api check:transactions
```
注意每套需独立空库（库名后缀区分），全部通过后记录命令与结果。

- [x] **Step 4: 文档更新**

`README.md`（apps/collaboration-api）：删除分类、批次、`POST /categories` 段落；新增「一致性对比」节（四个端点、白名单约束、幂等语义）与「通用场景预置」节（初始化事务、系统预置互斥）。`docs/milestones.md` 阶段二节追加：波次一完成范围、验证命令与结果、未覆盖项（波次二/三与 R 矩阵产品验收）。本计划文件勾掉已完成步骤并记录偏差。

- [x] **Step 5: 提交**

```bash
git add tests apps/collaboration-api/README.md docs/milestones.md docs/design/02-requirements-wave1-plan.md
git commit -m "阶段二波次一：测试套件重写与文档收尾"
```

---

## 偏差记录（执行收尾时回写）

- **Task 4（初始化事务写入顺序）**：计划字面 SQL 顺序（确认 → 实体）不可行——`studio_entities.current_confirmation_id` 与 `studio_confirmations` 对实体的外键均不可延迟。实际实现为同事务三步：先写实体（`current_confirmation_id` 为 null）→ 写入系统预置确认 → UPDATE 回填 `current_confirmation_id`。
- **Task 5（错误码清单补登）**：`CONFLICT_ORDINAL_SEQUENCE`（422）由本计划 Task 5 代码引入，但原 Global Constraints 错误码清单遗漏，收尾时已补入。
- **Task 6（编译门禁命令修正）**：`@eadp/studio-plugin` 没有 `typecheck` 脚本，其编译门禁是装配进 DSH 构建树后的 `tsc -b`（`node apps/desktop-distribution/build/prepare-studio-plugin.mjs` 生成 `.local/build/dsh`）；Task 6 Step 3 命令已据此修正。
- **Task 6 已知缺口（波次二范围，有意遗留）**：插件初始化清单写入器（`packages/studio-plugin/src/host/application/projects.ts` 的 `expectedManifest`/`initializeFiles`）尚不产出 `requirementTemplates` 与 `场景/通用场景.md`，插件驱动的新项目初始化对新后端会失败，待波次二补齐。
- **Task 7 Step 3（回归命令按套件拆分）**：四套 tsx DB 套件共用 `eadp_auth_check_*` 命名且各自完整执行非幂等的 `db/schema.sql`，合并为单条 tsx 命令会在同一库上并发建类型冲突；实际执行为每套单独重建空库后逐一运行。

## 自查记录

- Spec 覆盖：去分类（T1/T3/T6/T7）、REQ 编号（T2/T3/T7）、需求模板目录（T1/T3/T6）、取消冻结/批次/自动升版（T1/T3）、独立修订确认（T3/T7）、通用场景预置（T1/T4）、对比契约+存储+路由+目录（T1/T5）、白名单限度（T1/T5）、README/里程碑（T7）。拆分候选契约与联合拆分属 Host 侧（波次二），本波仅移除 categoryId 传参（T6）。
- 类型一致性：`reserveEntityNumber`、`TemplateCatalog`、`generalScenarioDocument`、`parseBuiltinScenario`、`readBuiltinScenario`、`saveComparison`、`consistencyContext` 等名字在各任务间保持一致；`EntityNumber` 替代 `ScenarioNumber`。
- 已知中间态：Task 1 后 api/studio-plugin 类型错误预期存在，Task 3 末 api 转绿，Task 6 末全 workspace 转绿。
