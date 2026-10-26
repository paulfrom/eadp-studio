# 材料确认修复实现计划：状态记录、卡死恢复与自动合并

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复验收三项缺口：动作点上报本地材料 git 状态与摘要（≤500字，后端纯记录）、待核对卡死（错误透传+自动重试）、远端分叉自动合并（git 三路合并，冲突 AI 直接产出合并结果并提示用户）。

**Architecture:** 后端新增追加型记录表与幂等写路由，无业务逻辑；Host 在占用开始/需求保存成功/确认前采集 git 状态并后台上报；确认视图在读取时派生子集成操作的真实错误；`state()` 对失败集成按 60 秒间隔自动恢复；`publish` 分叉时由 `CandidateMerges` 在任务 worktree 内 merge，干净则以 merge commit 重建候选（后端 `verifyCandidate` 零改动），冲突由 AI 会话写文件后 `completeMerge`，原集成记录置 `superseded`，确认操作 `remap` 到新候选。

**Tech Stack:** TypeScript、Fastify + TypeBox（contracts）、PostgreSQL（schema.sql 一次执行，无迁移）、node:test + tsx、DSH LLM（一站式推断与 Agent 会话）。

## Global Constraints

- 设计文档：`docs/design/material-confirmation-repair-2026-10-26.md`，本计划是其唯一实现来源。
- 摘要上限 **500**（TypeBox `maxLength: 500` + DB `varchar(500)` + Host 截断三处一致）。
- 状态记录只在三个动作点：`occupation-start` / `save` / `pre-confirmation`；后端纯记录，不读 Git、不含业务校验以外的逻辑。
- 自动合并仅覆盖 `stage === 'material'`；prototype 保留原报错。AI 冲突解决不要求用户二次确认。
- 不保留向后兼容、不加 migration/fallback；失败保留本地现场，绝不覆盖用户改动。
- 标准校验：`pnpm check:repository`；Host 测试：`apps/collaboration-api/node_modules/.bin/tsx --test tests/windows-desktop/<文件>`；后端测试需 `STUDIO_TEST_DATABASE_URL`（库名 `eadp_auth_check_[a-z0-9]+`，未设置会 skip，skip 不算通过）。
- 每个任务结束独立提交，提交信息用中文简述。

---

### Task 1: 状态记录契约与数据库表

**Files:**
- Modify: `packages/contracts/src/index.ts`（在 224-257 行对比契约之后追加）
- Modify: `apps/collaboration-api/db/schema.sql`（枚举区约 106 行后、对比表区约 1142 行后、不可变触发器区约 1520 行后追加）

**Interfaces:**
- Consumes: 现有 `object`、`keyed`、`IdSchema`、`Type`/`Static`/`Value`、`studio_forbid_mutation()`、`studio_control_id`。
- Produces: `MaterialStatusTrigger`（`'occupation-start'|'save'|'pre-confirmation'`）、`SubmitMaterialStatusReportSchema`、`SubmitMaterialStatusReportRequest`、`isSubmitMaterialStatusReportRequest(value)`、`MaterialStatusReportView`、`MaterialStatusReportFilter`；表 `studio_material_status_reports`、枚举 `studio_status_trigger`。

- [ ] **Step 1: 追加契约代码**

```ts
export const MaterialStatusTriggerSchema = Type.Union((['occupation-start', 'save', 'pre-confirmation'] as const).map(value => Type.Literal(value)));
export type MaterialStatusTrigger = Static<typeof MaterialStatusTriggerSchema>;
/** One append-only record of local material git status; the backend only records it. */
export const SubmitMaterialStatusReportSchema = object({
  ...keyed, id: IdSchema, entityId: IdSchema, trigger: MaterialStatusTriggerSchema,
  baseHead: Type.String({ pattern: '^[a-f0-9]{40}$' }),
  worktreeHead: Type.String({ pattern: '^[a-f0-9]{40}$' }),
  changedPathCount: Type.Integer({ minimum: 0, maximum: 3000 }),
  summary: Type.String({ maxLength: 500 }),
});
export type SubmitMaterialStatusReportRequest = Static<typeof SubmitMaterialStatusReportSchema>;
export function isSubmitMaterialStatusReportRequest(value: unknown): value is SubmitMaterialStatusReportRequest { return Value.Check(SubmitMaterialStatusReportSchema, value); }
export interface MaterialStatusReportView {
  id: string; entityId: string; trigger: MaterialStatusTrigger;
  baseHead: string; worktreeHead: string; changedPathCount: number; summary: string;
  creator: AuditIdentity; createdAt: string;
}
export interface MaterialStatusReportFilter { entityId?: string; limit: number; offset: number }
```

- [ ] **Step 2: 追加 SQL（枚举、表、索引、不可变触发器）**

```sql
CREATE TYPE studio_status_trigger AS ENUM ('occupation-start','save','pre-confirmation');
COMMENT ON TYPE studio_status_trigger IS '状态记录动作';

-- 本地材料 git 状态：仅追加记录，摘要不超 500 字，不含材料正文。
CREATE TABLE studio_material_status_reports (
  id studio_control_id PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  entity_id text NOT NULL,
  trigger studio_status_trigger NOT NULL,
  base_head text NOT NULL CHECK (base_head ~ '^[a-f0-9]{40}$'),
  worktree_head text NOT NULL CHECK (worktree_head ~ '^[a-f0-9]{40}$'),
  changed_path_count integer NOT NULL CHECK (changed_path_count BETWEEN 0 AND 3000),
  summary varchar(500) NOT NULL DEFAULT '',
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,id),
  FOREIGN KEY (project_id,entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_material_status_reports IS '材料状态记录';
COMMENT ON COLUMN studio_material_status_reports.id IS '状态记录ID';
COMMENT ON COLUMN studio_material_status_reports.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_material_status_reports.entity_id IS '目标材料ID';
COMMENT ON COLUMN studio_material_status_reports.trigger IS '触发途径';
COMMENT ON COLUMN studio_material_status_reports.base_head IS '基线提交';
COMMENT ON COLUMN studio_material_status_reports.worktree_head IS '工作区提交';
COMMENT ON COLUMN studio_material_status_reports.changed_path_count IS '变更文件数';
COMMENT ON COLUMN studio_material_status_reports.summary IS '状态摘要';
COMMENT ON COLUMN studio_material_status_reports.creator_id IS '发起人ID';
COMMENT ON COLUMN studio_material_status_reports.creator_account IS '发起人账号';
COMMENT ON COLUMN studio_material_status_reports.creator_name IS '发起人姓名';
COMMENT ON COLUMN studio_material_status_reports.created_date IS '记录时间';
CREATE INDEX studio_status_reports_target ON studio_material_status_reports(project_id,entity_id,created_date DESC);

CREATE TRIGGER studio_status_report_immutable BEFORE UPDATE OR DELETE ON studio_material_status_reports
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
```

- [ ] **Step 3: 校验**

Run: `pnpm check:repository`
Expected: 通过（契约类型被后续任务使用前，本步至少保证 TS/SQL 静态检查无错）。

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/index.ts apps/collaboration-api/db/schema.sql
git commit -m "新增材料 git 状态记录契约与数据表"
```

---

### Task 2: 后端状态记录持久化、服务与路由

**Files:**
- Modify: `apps/collaboration-api/src/persistence/repository.ts`（对比持久化 337-377 行之后追加）
- Modify: `apps/collaboration-api/src/service.ts`（submitComparison 311-328 行之后追加）
- Modify: `apps/collaboration-api/src/routes.ts`（63 行对比路由之后追加）
- Test: `tests/collaboration/backend-status-reports.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 契约与表；`repository.project/previous/remember/entityRow`、`actorColumns`、`actorFields()`、`snapshot(row,'creator')`、`date()`、`requireCondition`、`service.authorize/transact`。
- Produces: `repository.saveStatusReport/listStatusReports/getStatusReport`；`service.submitStatusReport(actor, projectId, entityId, input)`、`listStatusReports(actor, projectId, filter)`、`getStatusReport(actor, projectId, id)`；路由 `POST/GET ${base}/entities/:entityId/status-reports`、`GET …/:reportId`。幂等 action 字符串固定为 `'material.status-report'`。

- [ ] **Step 1: 写失败测试。** 新建 `tests/collaboration/backend-status-reports.test.ts`：把 `tests/collaboration/backend-comparisons.test.ts:1-103` 的导入、fixture、登录、`send/post/get`、项目与实体（`scene`）准备代码原样复制作为 setup（`databaseUrl` 不存在时 skip 的写法保留），随后只保留下面的用例。`report()` 工厂与用例完整代码：

```ts
const reportsUrl = `${base}/entities/${scene.id}/status-reports`
const head = (letter: string) => letter.repeat(40)
const report = (overrides: Record<string, unknown> = {}) => ({ idempotencyKey: key(), id: key(), entityId: scene.id, trigger: 'save', baseHead: head('a'), worktreeHead: head('b'), changedPathCount: 2, summary: '未提交变更 2 个文件：场景/登录.md（修改）', ...overrides })

await t.test('a status report is recorded without any Git content read and reads back identically', async () => {
  const payload = report(), gitBefore = gitlab.paths.length
  const created = await post<MaterialStatusReportView>(reportsUrl, payload)
  assert.equal(created.id, payload.id); assert.equal(created.entityId, scene.id)
  assert.equal(created.trigger, 'save'); assert.equal(created.baseHead, head('a'))
  assert.equal(created.changedPathCount, 2); assert.equal(created.creator.id, 1)
  const list = await get<MaterialStatusReportView[]>(reportsUrl)
  assert.deepEqual(list, [created])
  const detail = await get<MaterialStatusReportView>(`${reportsUrl}/${created.id}`)
  assert.deepEqual(detail, created)
  assert.ok(gitlab.paths.slice(gitBefore).every(path => !path.includes('/repository/files')), '纯记录不得读取 Git 内容')
})

await t.test('the operation key replays the original record and rejects a changed request', async () => {
  const payload = report()
  const original = await post<MaterialStatusReportView>(reportsUrl, payload)
  const replay = await post<MaterialStatusReportView>(reportsUrl, payload)
  assert.deepEqual(replay, original)
  const stored = await database.query<{ count: string }>('SELECT count(*) AS count FROM studio_material_status_reports WHERE project_id=$1 AND id=$2', [project.id, payload.id])
  assert.equal(stored.rows[0]!.count, '1')
  const changed = await send('POST', reportsUrl, { ...payload, summary: '同键不同内容' })
  assert.equal(changed.statusCode, 409, changed.body)
  assert.equal(changed.json<{ error: { code: string } }>().error.code, 'IDEMPOTENCY_CONFLICT')
})

await t.test('summary over 500 chars and mismatched route entity are rejected', async () => {
  const long = await send('POST', reportsUrl, report({ summary: '长'.repeat(501) }))
  assert.equal(long.statusCode, 400)
  const mismatch = await send('POST', reportsUrl, report({ entityId: 'other-entity' }))
  assert.equal(mismatch.statusCode, 422)
  assert.equal(mismatch.json<{ error: { code: string } }>().error.code, 'STATUS_REPORT_TARGET_MISMATCH')
})
```

文件顶部补充导入：`import type { MaterialStatusReportView } from '../../packages/contracts/src/index.ts'`（若该测试文件已统一从 `@eadp/contracts` 导入则沿用其写法）。

- [ ] **Step 2: 运行确认失败**

Run: `STUDIO_TEST_DATABASE_URL=postgresql://scenario_test:scenario_test@127.0.0.1:5433/eadp_auth_check_status pnpm --filter @eadp/collaboration-api exec tsx --test ../../tests/collaboration/backend-status-reports.test.ts`
Expected: 路由 404/500，用例失败。

- [ ] **Step 3: repository 追加**

```ts
function statusReportView(row: Row): MaterialStatusReportView {
  return { id: String(row.id), entityId: String(row.entity_id), trigger: row.trigger as MaterialStatusTrigger,
    baseHead: String(row.base_head), worktreeHead: String(row.worktree_head), changedPathCount: Number(row.changed_path_count),
    summary: String(row.summary), creator: snapshot(row, 'creator'), createdAt: date(row.created_date) };
}
/** Append-only local git status fact; idempotency lives in studio_operations, not on this table. */
export async function saveStatusReport(c: Transaction, projectId: string, actor: Actor, input: SubmitMaterialStatusReportRequest): Promise<MaterialStatusReportView> {
  await c.query(`INSERT INTO studio_material_status_reports(id,project_id,entity_id,trigger,base_head,worktree_head,changed_path_count,summary,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [input.id, projectId, input.entityId, input.trigger, input.baseHead, input.worktreeHead, input.changedPathCount, input.summary, ...actorFields()]);
  return getStatusReport(c, projectId, input.id);
}
export async function listStatusReports(c: Transaction, projectId: string, filter: MaterialStatusReportFilter): Promise<MaterialStatusReportView[]> {
  const rows = (await c.query<Row>('SELECT * FROM studio_material_status_reports WHERE project_id=$1 AND ($2::text IS NULL OR entity_id=$2) ORDER BY created_date DESC,id DESC LIMIT $3 OFFSET $4',
    [projectId, filter.entityId ?? null, filter.limit, filter.offset])).rows;
  return rows.map(statusReportView);
}
export async function getStatusReport(c: Transaction, projectId: string, id: string): Promise<MaterialStatusReportView> {
  const row = (await c.query<Row>('SELECT * FROM studio_material_status_reports WHERE project_id=$1 AND id=$2', [projectId, id])).rows[0];
  requireCondition(row, 'STATUS_REPORT_NOT_FOUND', 'Status report was not found', 404);
  return statusReportView(row);
}
```

补充类型导入（`MaterialStatusReportView`、`MaterialStatusReportFilter`、`MaterialStatusTrigger`、`SubmitMaterialStatusReportRequest`，均来自 `@eadp/contracts`）。

- [ ] **Step 4: service 追加（复用 mutate 的锁/重放顺序，但不水合实体、不读 Git）**

```ts
async submitStatusReport(actor: Actor, projectId: string, entityId: string, input: SubmitMaterialStatusReportRequest): Promise<MaterialStatusReportView> {
  await this.authorize(actor, projectId, true);
  requireCondition(input.entityId === entityId, 'STATUS_REPORT_TARGET_MISMATCH', 'Status report must name the entity in its route', 422);
  return this.transact(actor, async c => {
    await repository.project(c, projectId, true);
    const project = await repository.project(c, projectId); repository.assertProjectReady(project);
    const previous = await repository.previous(c, projectId, actor, 'material.status-report', input);
    if (previous.found) return repository.getStatusReport(c, projectId, input.id);
    await repository.entityRow(c, projectId, entityId);
    const result = await repository.saveStatusReport(c, projectId, actor, input);
    await repository.remember(c, projectId, actor, 'material.status-report', input, { id: result.id });
    return result;
  });
}
async listStatusReports(actor: Actor, projectId: string, filter: MaterialStatusReportFilter): Promise<MaterialStatusReportView[]> {
  return this.transact(actor, c => repository.listStatusReports(c, projectId, filter));
}
async getStatusReport(actor: Actor, projectId: string, id: string): Promise<MaterialStatusReportView> {
  return this.transact(actor, c => repository.getStatusReport(c, projectId, id));
}
```

- [ ] **Step 5: routes 追加**

```ts
write('POST', `${base}/entities/:entityId/status-reports`, contract.SubmitMaterialStatusReportSchema, (a, p, b) => service.submitStatusReport(a, p.projectId!, p.entityId!, b));
app.get<{ Params: { projectId: string; entityId: string }; Querystring: Record<string, string> }>(`${base}/entities/:entityId/status-reports`, request => {
  const query = request.query, limit = Number(query.limit ?? '20'), offset = Number(query.offset ?? '0');
  requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0, 'INVALID_PAGINATION', 'Status report queries require limit 1..100 and a non-negative offset', 422);
  return service.listStatusReports(request.actor, request.params.projectId, { entityId: request.params.entityId, limit, offset });
});
read(`${base}/entities/:entityId/status-reports/:reportId`, (a, p) => service.getStatusReport(a, p.projectId!, p.reportId!));
```

- [ ] **Step 6: 运行测试至全部通过**（命令同 Step 2），随后 `pnpm check:repository`。

- [ ] **Step 7: Commit**

```bash
git add apps/collaboration-api/src/persistence/repository.ts apps/collaboration-api/src/service.ts apps/collaboration-api/src/routes.ts tests/collaboration/backend-status-reports.test.ts
git commit -m "后端记录本地材料 git 状态：幂等提交与查询"
```

---

### Task 3: Host 状态采集、摘要与三个动作点上报

**Files:**
- Create: `packages/studio-plugin/src/host/application/material-status.ts`
- Create: `packages/studio-plugin/src/host/adapters/dsh/summary.ts`
- Modify: `packages/studio-plugin/src/host/application/ports.ts`（`HostPorts` 加 `summarize?`）
- Modify: `packages/studio-plugin/src/host/composition.ts`（ports 注入 summarize）
- Modify: `packages/studio-plugin/src/host/application/scenario-workspaces.ts`（`ScenarioRecord` 加 `statusReports?`，构造函数装配）
- Modify: `packages/studio-plugin/src/host/application/requirement-saves.ts`（保存成功回调）
- Modify: `packages/studio-plugin/src/host/application/material-confirmations.ts`（确认前上报）
- Modify: `packages/studio-plugin/src/host/application/studio.ts`（claim 后上报 + `state()` 恢复上报）
- Modify: `packages/studio-plugin/src/shared/studio.ts`（`TaskView` 加 `baseHead?: string`）
- Test: `tests/windows-desktop/material-status.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `POST …/status-reports`；`ScenarioWorkspaces.deps.deliver`（即 `lane.append`）；`ports.git.state`、`ports.gitLocal`。
- Produces:
  - `ports.summarize?(input: { subject: string; facts: string }, signal: AbortSignal): Promise<string>`
  - `ScenarioRecord.statusReports?: LocalMaterialStatusReport[]`
  - `MaterialStatusReports.report(input: { projectId: string; entityId: string; trigger: MaterialStatusTrigger; worktree: string; baseHead?: string }): Promise<void>`（永不抛出，错误落 `record.message`）
  - `MaterialStatusReports.resume(projectId: string): void`（对未 shared 且已有 submission 的记录重新投递）
  - `TaskView.baseHead?: string`

- [ ] **Step 1: 写失败测试 `tests/windows-desktop/material-status.test.ts`（完整代码）**

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MaterialStatusReports } from '../../packages/studio-plugin/src/host/application/material-status.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { ScenarioRecord } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'

const head = 'b'.repeat(40)
test('status reports carry mechanical plus optional AI summaries and recover after failure', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'status-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const owner: ScenarioRecord = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: {} }
  ;(await store.read()).scenarios.push(owner); await store.save()
  const posts: Array<{ url: string; body: { summary: string; worktreeHead: string; changedPathCount: number; idempotencyKey: string } }> = []
  let failing = true
  const api = { async request(method: string, url: string, body: never) { if (failing) throw new Error('网络不可用'); posts.push({ url, body }); return {} } } as unknown as CollaborationClient
  const ports = {
    git: { state: async () => ({ root: 'w', head, branch: 'main', dirty: true, repositoryUrl: 'https://gitlab.test/p.git' }) },
    gitLocal: async () => ' M 场景/登录.md\0?? 场景/新增.md\0',
    summarize: async () => '本次编辑调整登录场景并新增一个场景草稿',
  } as unknown as HostPorts
  const pending: Array<() => Promise<void>> = []
  const reports = new MaterialStatusReports(store, api, ports, { record: async () => owner, deliver: work => { pending.push(work) } })
  await reports.report({ projectId: 'p', entityId: 'e', trigger: 'save', worktree: '/w', baseHead: 'a'.repeat(40) })
  assert.equal(pending.length, 1); await pending[0]!()
  assert.equal(posts.length, 0, '首次上报失败不得发成功')
  assert.equal(owner.statusReports![0]!.message, '网络不可用')
  failing = false; reports.resume('p'); assert.equal(pending.length, 2); await pending[1]!()
  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.url, '/v1/projects/p/entities/e/status-reports')
  assert.equal(posts[0]!.body.worktreeHead, head)
  assert.equal(posts[0]!.body.changedPathCount, 2)
  assert.match(posts[0]!.body.summary, /未提交变更 2 个文件：场景\/登录.md（修改）、场景\/新增.md（新增）/)
  assert.match(posts[0]!.body.summary, /本次编辑调整登录场景/)
  assert.ok(posts[0]!.body.summary.length <= 500)
  assert.equal(owner.statusReports![0]!.shared, true)
  reports.resume('p'); assert.equal(pending.length, 2, '已共享记录不再重发')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `apps/collaboration-api/node_modules/.bin/tsx --test tests/windows-desktop/material-status.test.ts`
Expected: FAIL（模块 `material-status.ts` 不存在）。

- [ ] **Step 3: 实现 `material-status.ts`（完整代码）**

```ts
import { randomUUID } from 'node:crypto'
import type { MaterialStatusTrigger, SubmitMaterialStatusReportRequest } from '@eadp/contracts'
import type { CollaborationClient } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import type { ScenarioRecord } from './scenario-workspaces.ts'
import type { StudioStore } from './state.ts'

export interface LocalMaterialStatusReport {
  id: string; projectId: string; entityId: string; trigger: MaterialStatusTrigger;
  submission?: SubmitMaterialStatusReportRequest; shared: boolean; message?: string;
}
export interface MaterialStatusReportInput {
  projectId: string; entityId: string; trigger: MaterialStatusTrigger; worktree: string; baseHead?: string;
}
interface Dependencies {
  record(entityId: string, projectId?: string): Promise<ScenarioRecord>
  deliver(work: () => Promise<void>): void
}
interface StatusPath { path: string; status: string }
const LIMIT = 500
/** Mechanical digest of one porcelain status; the backend stores this text verbatim. */
export function mechanicalSummary(paths: StatusPath[]): string {
  if (!paths.length) return '工作区无未提交变更'
  const names = paths.map(value => `${value.path}（${value.status === 'D' ? '删除' : value.status === 'A' || value.status === '??' ? '新增' : '修改'}）`)
  return `未提交变更 ${paths.length} 个文件：${names.join('、')}`
}

/** Records local material git status at explicit action points; failures stay local for resume. */
export class MaterialStatusReports {
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient,
    private readonly ports: Pick<HostPorts, 'git' | 'gitLocal' | 'summarize'>, private readonly deps: Dependencies) {}

  async report(input: MaterialStatusReportInput): Promise<void> {
    const owner = await this.deps.record(input.entityId, input.projectId)
    const record: LocalMaterialStatusReport = { id: randomUUID(), projectId: input.projectId, entityId: input.entityId, trigger: input.trigger, shared: false }
    ;(owner.statusReports ??= []).push(record)
    await this.store.save()
    this.deps.deliver(async () => {
      try {
        const state = await this.ports.git.state(input.worktree)
        const paths = await this.changedPaths(input.worktree)
        let summary = mechanicalSummary(paths)
        if (this.ports.summarize) {
          try {
            const ai = await this.ports.summarize({ subject: '本地材料 git 状态摘要', facts: JSON.stringify({ entityId: input.entityId, trigger: input.trigger, baseHead: input.baseHead ?? state.head, worktreeHead: state.head, paths }) }, AbortSignal.timeout(30_000))
            if (ai.trim()) summary = `${summary}；${ai.trim()}`
          } catch { /* AI 摘要失败只保留机械摘要 */ }
        }
        record.submission = { idempotencyKey: record.id, id: record.id, entityId: input.entityId, trigger: input.trigger,
          baseHead: input.baseHead ?? state.head, worktreeHead: state.head, changedPathCount: paths.length, summary: summary.slice(0, LIMIT) }
        await this.store.save()
        await this.submit(record)
      } catch (error) { record.message = error instanceof Error ? error.message : '状态记录待核对'; await this.store.save() }
    })
  }

  /** Re-deliver unfinished submissions; a successful POST is idempotent on its record key. */
  resume(projectId: string): void {
    void this.store.read().then(local => {
      for (const owner of local.scenarios.filter(record => record.projectId === projectId)) {
        for (const record of owner.statusReports ?? []) {
          if (record.shared || !record.submission) continue
          this.deps.deliver(() => this.submit(record))
        }
      }
    }).catch(() => undefined)
  }

  private async submit(record: LocalMaterialStatusReport): Promise<void> {
    if (!record.submission || record.shared) return
    try {
      await this.api.request('POST', `/v1/projects/${encodeURIComponent(record.projectId)}/entities/${encodeURIComponent(record.entityId)}/status-reports`, record.submission)
      record.shared = true; delete record.message; await this.store.save()
    } catch (error) { record.message = error instanceof Error ? error.message : '状态记录待核对'; await this.store.save() }
  }

  private async changedPaths(worktree: string): Promise<StatusPath[]> {
    const entries = (await this.ports.gitLocal(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree)).split('\0').filter(Boolean)
    const paths: StatusPath[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!, name = entry.slice(3), code = entry.trim().split(/\s+/, 1)[0]!
      paths.push({ path: name, status: code.includes('D') ? 'D' : code.includes('?') || code.includes('A') ? code.includes('?') ? '??' : 'A' : 'M' })
      if (/[RC]/.test(entry.slice(0, 2))) index++
    }
    return paths
  }
}
```

- [ ] **Step 4: `ScenarioRecord` 增加 `statusReports?: LocalMaterialStatusReport[]`（`scenario-workspaces.ts:37` 接口内追加字段，`import type { LocalMaterialStatusReport } from './material-status.ts'`）。`ports.ts` 的 `HostPorts` 增加：**

```ts
/** One-shot short-text inference with no Agent tools, Session persistence, or Git access. */
summarize?(input: { subject: string; facts: string }, signal: AbortSignal): Promise<string>
```

- [ ] **Step 5: `adapters/dsh/summary.ts`（完整代码，模式同 `consistency.ts`）**

```ts
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'

/** A one-shot summary call has no Session log, Agent, tools, or filesystem authority. */
export async function summarizeText(ctx: Context, input: { subject: string; facts: string }, signal: AbortSignal): Promise<string> {
  const call = await ctx.llm.prepareCall({ ...ctx.agentDefaultModel.currentSelection(), maxTokens: 1024 }, signal)
  const assembler = new BlockAssembler()
  let finished = false
  for await (const chunk of call.stream({ ...call.config, signal, tools: [],
    system: '用不超过120字中文概括输入的本地材料变更事实。仅依据输入，不编造未提供的内容，直接输出摘要文本。',
    messages: [{ role: 'user', content: [{ type: 'text', text: `${input.subject}\n${input.facts}` }] }],
  })) { signal.throwIfAborted(); if (chunk.type === 'finish') finished = true; assembler.push(chunk) }
  signal.throwIfAborted()
  if (!finished || assembler.finish.kind !== 'stop' || assembler.blocks().some(block => block.type === 'tool-call')) throw new Error('状态摘要未产生完整文本结果')
  return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('\n')
}
```

`composition.ts` 在 ports 对象中追加（import `summarizeText` from './adapters/dsh/summary.ts'）：`summarize: (input, signal) => summarizeText(ctx, input, signal),`。

- [ ] **Step 6: 装配与三个动作点接线**

1. `scenario-workspaces.ts`：`ScenarioWorkspaces` 增加 `readonly statusReports: MaterialStatusReports`，构造函数内 `this.statusReports = new MaterialStatusReports(store, api, ports, { record: (entityId, projectId) => this.record(entityId, projectId), deliver: work => deps.deliver(work) })`；`requirementSaves` 的 deps 增加 `applied` 回调（见第 2 点）。
2. `requirement-saves.ts`：deps 接口增加 `applied?(operation: RequirementSaveOperation): void`；`writeDirectory` 末尾 `operation.status = 'applied'; operation.message = '需求已保存'; await this.persist(operation)` 之后调用 `this.deps.applied?.(operation)`。`ScenarioWorkspaces` 装配该回调：

```ts
applied: operation => {
  void this.store.read().then(local => {
    const task = local.tasks.find(value => path.resolve(value.worktree) === path.resolve(operation.root!))
    return this.statusReports.report({ projectId: operation.projectId, entityId: operation.entityId, trigger: 'save', worktree: operation.root!, ...(task?.baseHead ? { baseHead: task.baseHead } : {}) })
  }).catch(() => undefined)
}
```

（`operation.projectId` 若在该类型上名为其他字段，以 `requirement-saves.ts` 实际字段为准；`operation.root!` 即工作区。）
3. `shared/studio.ts` 的 `TaskView` 增加 `baseHead?: string`；`studio.ts` 的 `designTask` 创建 task 字面量时加 `baseHead: remote.project.recognizedHead!`，并在 `const current = entity` 前记录 `const claimed = !entity.occupation`，函数返回 task 前：

```ts
if (claimed) void this.scenarios.statusReports.report({ projectId: remote.project.id, entityId: entity.id, trigger: 'occupation-start', worktree: task.worktree, baseHead: remote.project.recognizedHead! })
```

（existing task 提前 return 的分支同样适用：在 `if (existing) return existing` 前也执行该上报，保持每个新占用只记录一次。）
4. `material-confirmations.ts` 的 `confirm`：在 `await this.advance(owner, operation)` 之前执行：

```ts
void this.workspaces.statusReports.report({ projectId: operation.projectId, entityId: operation.entityId, trigger: 'pre-confirmation', worktree: task.worktree, baseHead: remote.project.recognizedHead ?? task.baseHead })
```

5. `studio.ts` 的 `state()` 末尾 `if (selected) await this.scheduleRequirementRecoveries(selected.id)` 后追加 `if (selected) this.scenarios.statusReports.resume(selected.id)`。

- [ ] **Step 7: 运行测试至通过，并跑回归**

Run: `apps/collaboration-api/node_modules/.bin/tsx --test tests/windows-desktop/material-status.test.ts` → PASS
Run: `apps/collaboration-api/node_modules/.bin/tsx --test tests/windows-desktop/*.test.ts` → 无回归
Run: `pnpm check:repository` → 通过

- [ ] **Step 8: Commit**

```bash
git add packages/studio-plugin/src tests/windows-desktop/material-status.test.ts
git commit -m "动作点上报本地材料 git 状态与摘要"
```

---

### Task 4: 确认视图透传真实集成错误

**Files:**
- Modify: `packages/studio-plugin/src/host/application/material-confirmations.ts:96-100`（`view`）
- Modify: `packages/studio-plugin/src/host/application/studio.ts:494-497`（pending 构造传参）
- Test: `tests/windows-desktop/material-confirmation-view.test.ts`（新建）

**Interfaces:**
- Produces: `MaterialConfirmations.view(owner: ScenarioRecord, operations?: PendingOperation[]): { operationId: string; message: string; expectedHash?: string } | undefined`——`phase='integrating'` 且子操作 `phase='unknown'` 时返回子操作真实 message。

- [ ] **Step 1: 写失败测试（完整代码）**

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MaterialConfirmations } from '../../packages/studio-plugin/src/host/application/material-confirmations.ts'
import type { ScenarioRecord } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'
import type { PendingOperation } from '../../packages/studio-plugin/src/host/application/state.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'

test('an integrating confirmation surfaces the child operation failure instead of the generic pending text', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'confirm-view-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const confirmations = new MaterialConfirmations(store, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never)
  const owner = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: [],
    materialConfirmations: [{ operationId: 'c1', accountId: 1, projectId: 'p', entityId: 'e', request: {}, fingerprint: '', task: {}, occupation: {}, phase: 'integrating', integrationId: 'i1' }] } as ScenarioRecord
  const child = { id: 'i1', projectId: 'p', phase: 'unknown', message: 'GitLab 拒绝推送：凭据失效' } as PendingOperation
  assert.equal(confirmations.view(owner, [child])?.message, 'GitLab 拒绝推送：凭据失效')
  assert.equal(confirmations.view(owner, [])?.message, '确认已提交，正在核对原结果')
})
```

- [ ] **Step 2: 运行确认失败**（`tsx --test tests/windows-desktop/material-confirmation-view.test.ts`，真实错误被默认文案覆盖）。

- [ ] **Step 3: 实现 `view`（替换原方法）**

```ts
view(owner: ScenarioRecord, operations?: PendingOperation[]): { operationId: string; message: string; expectedHash?: string } | undefined {
  const operation = current(owner)
  if (!operation || operation.phase === 'accepted' || operation.phase === 'superseded') return undefined
  const child = operation.integrationId ? operations?.find(value => value.id === operation.integrationId && value.projectId === operation.projectId) : undefined
  const failure = child?.phase === 'unknown' ? child.message : undefined
  return { operationId: operation.operationId,
    message: operation.message ?? failure ?? (operation.phase === 'integrating' ? '确认已提交，正在核对原结果' : '请按选择恢复保存并继续确认'),
    ...(operation.savedHash ? { expectedHash: operation.savedHash } : {}) }
}
```

`studio.ts:495` 改为 `const save = this.scenarios.requirementSaves.view(record), confirmation = this.confirmations.view(record, local.operations)`。

- [ ] **Step 4: 测试通过 + `pnpm check:repository`。**

- [ ] **Step 5: Commit**

```bash
git add packages/studio-plugin/src/host/application/material-confirmations.ts packages/studio-plugin/src/host/application/studio.ts tests/windows-desktop/material-confirmation-view.test.ts
git commit -m "确认待核对视图透传集成真实错误"
```

---

### Task 5: 失败集成自动恢复（60 秒最小间隔）

**Files:**
- Modify: `packages/studio-plugin/src/host/application/git-integrations.ts`（新增 `recover`、记录最近尝试时间）
- Modify: `packages/studio-plugin/src/host/application/studio.ts:428-449`（`state()` 增加失败操作恢复）
- Test: `tests/windows-desktop/git-integrations.test.ts`（追加用例）

**Interfaces:**
- Produces: `GitIntegrations.recover(operation: PendingOperation): void`——仅 `phase='unknown'` 时按 60 秒最小间隔重新 `schedule`；构造器新增可选第 6 参 `now: () => number = Date.now`。

- [ ] **Step 1: 追加失败测试。** 在 `tests/windows-desktop/git-integrations.test.ts` 中复用现有 `fixture(t)`（`tests/windows-desktop/git-integrations.test.ts:36-93` 的 fake api/git/lane）与其失败注入方式，新增用例：让首次集成失败（fake api 的 prepare 抛错一次），随后验证自动恢复节奏。完整用例：

```ts
test('unknown operations recover automatically at most once per retry interval', async t => {
  const f = await fixture(t)
  let now = 1_000_000
  const runner = new GitIntegrations(f.store, f.api, f.ports, f.lane, { accepted: async () => undefined }, () => now)
  const operation = await runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(operation.phase, 'unknown')
  const callsAfterFailure = f.calls.length
  runner.recover(operation) // 距上次尝试不足 60 秒：不调度
  await f.lane.settle()
  assert.equal(f.calls.length, callsAfterFailure)
  now += 61_000
  f.failures.prepare = false // 按 fixture 实际失败开关名调整
  runner.recover(operation)
  await f.lane.settle()
  assert.equal(operation.phase, 'accepted')
})
```

注意：fixture 当前在文件内直接 new GitIntegrations；把 fixture 的 `create` 改为可传入 `now`（或直接在该用例内自建等价 fake）。`f.store/f.api/f.ports` 若 fixture 未导出，则在 fixture 返回对象上补充导出，属同一文件内改动。失败开关以该文件实际字段为准（如 `failures.prepare`）。

- [ ] **Step 2: 运行确认失败**（`recover` 不存在，TS 报错/测试失败）。

- [ ] **Step 3: 实现。** `GitIntegrations` 增加：

```ts
private static readonly RETRY_INTERVAL_MS = 60_000
private readonly attempts = new Map<string, number>()
constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts,
  private readonly lane: BackgroundLane, private readonly deps: Dependencies, private readonly now: () => number = Date.now) {}

/** Re-drive a failed integration from projection reads; one automatic attempt per interval. */
recover(operation: PendingOperation): void {
  if (operation.phase !== 'unknown') return
  const identity = `${operation.accountId}:${operation.projectId}:${operation.id}`
  if (this.now() - (this.attempts.get(identity) ?? 0) < GitIntegrations.RETRY_INTERVAL_MS) return
  this.schedule(operation)
}
```

`resume()` 在 `const started = this.run(operation)` 前记录 `this.attempts.set(identity, this.now())`（手动重试也计入间隔）。
`studio.ts` 的 `state()` 在 accepted 恢复循环之后追加：

```ts
for (const operation of local.operations) if (operation.accountId === account.id && allowed.has(operation.projectId)) this.integrations.recover(operation)
```

- [ ] **Step 4: 测试通过 + 全量 Host 测试无回归 + `pnpm check:repository`。**

- [ ] **Step 5: Commit**

```bash
git add packages/studio-plugin/src/host/application/git-integrations.ts packages/studio-plugin/src/host/application/studio.ts tests/windows-desktop/git-integrations.test.ts
git commit -m "失败集成按最小间隔自动恢复"
```

---

### Task 6: WorkspaceGit 三路合并能力

**Files:**
- Modify: `packages/studio-plugin/src/host/adapters/workspace/git.ts`（`fastForward` 附近新增 `merge`/`completeMerge`）
- Test: `tests/windows-desktop/workspace-git-merge.test.ts`（新建，真实 git）

**Interfaces:**
- Produces:
  - `type GitMergeResult = { status: 'merged'; commit: string } | { status: 'conflicted'; files: string[] }`
  - `WorkspaceGit.merge(root: string, commit: string, identity: GitIdentity): Promise<GitMergeResult>`——非零退出且无冲突文件时抛错，保留现场。
  - `WorkspaceGit.completeMerge(root: string, files: readonly string[], identity: GitIdentity): Promise<string>`——`git add` 冲突文件后 `commit --no-edit`，返回 merge commit SHA。

- [ ] **Step 1: 写失败测试（真实 git，完整代码）**

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { WorkspaceGit } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'
import type { PlatformRuntime, ProcessResult } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'

const exec = promisify(execFile)
const identity = { name: 'Tester', email: 'tester@example.test' }
const runtime = (() => {
  const run = (file: string, args: string[], options: { cwd: string }): Promise<ProcessResult> => new Promise(resolve => {
    execFile(file, args, { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr, stdoutBytes: Buffer.from(stdout) } as ProcessResult)
    })
  })
  return { run, start: (file: string, args: string[], options: { cwd: string }) => ({ done: run(file, args, options), onOutput: () => () => {} }) } as unknown as PlatformRuntime
})()

test('merge reports a clean merge commit and conflicted files, completeMerge finishes them', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-merge-')); t.after(() => rm(root, { recursive: true, force: true }))
  await exec('git', ['init', '--initial-branch', 'main'], { cwd: root })
  await exec('git', ['config', 'user.name', identity.name], { cwd: root }); await exec('git', ['config', 'user.email', identity.email], { cwd: root })
  const git = new WorkspaceGit(runtime)
  const commitAll = async (message: string) => { await exec('git', ['add', '-A'], { cwd: root }); await exec('git', ['commit', '-m', message], { cwd: root }); return (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim() }
  await writeFile(path.join(root, 'a.md'), 'base\n'); const base = await commitAll('base')
  await exec('git', ['checkout', '-b', 'candidate'], { cwd: root })
  await writeFile(path.join(root, 'a.md'), 'base\ncandidate\n'); await commitAll('candidate')
  await exec('git', ['checkout', 'main'], { cwd: root })
  await writeFile(path.join(root, 'b.md'), 'remote\n'); const remote = await commitAll('remote')
  await exec('git', ['checkout', 'candidate'], { cwd: root })
  const clean = await git.merge(root, remote, identity)
  assert.equal(clean.status, 'merged')
  // 冲突场景：双方改同一行
  await exec('git', ['checkout', '-b', 'conflict', base], { cwd: root })
  await writeFile(path.join(root, 'a.md'), 'candidate line\n'); await commitAll('candidate edit')
  await exec('git', ['checkout', 'main'], { cwd: root })
  await writeFile(path.join(root, 'a.md'), 'remote line\n'); const remote2 = await commitAll('remote edit')
  await exec('git', ['checkout', 'conflict'], { cwd: root })
  const conflicted = await git.merge(root, remote2, identity)
  assert.equal(conflicted.status, 'conflicted')
  assert.deepEqual(conflicted.files, ['a.md'])
  await writeFile(path.join(root, 'a.md'), 'merged line\n')
  const merged = await git.completeMerge(root, ['a.md'], identity)
  assert.match(merged, /^[a-f0-9]{40}$/)
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), merged)
})
```

注意：`main` 上后续冲突场景以 `base` 显式建 `conflict` 分支、第二次合并前 `main` 的 head 为 `remote2`，`merge` 的对象是 `remote2`，语义正确。

- [ ] **Step 2: 运行确认失败**（`merge` 不存在）。

- [ ] **Step 3: 实现（追加到 `WorkspaceGit`，`fastForward` 之后）**

```ts
/** Three-way merge of one fetched commit; conflicted paths keep the merge state for AI resolution. */
async merge(root: string, commit: string, identity: GitIdentity): Promise<GitMergeResult> {
  fixedSha(commit)
  if (!identity.name.trim() || !identity.email.includes('@') || /[\r\n\0]/.test(identity.name + identity.email)) throw new Error('Git 提交身份无效。')
  const result = await this.result(root, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'merge', '--no-ff', '--no-edit', fixedSha(commit)])
  if (result.exitCode === 0) return { status: 'merged', commit: fixedSha((await this.command(root, ['rev-parse', 'HEAD'])).stdout.trim()) }
  const files = (await this.command(root, ['diff', '--name-only', '-z', '--diff-filter=U'])).stdout.split('\0').filter(Boolean).map(gitRelativePath)
  if (!files.length) throw new Error(`git 合并失败（退出码 ${result.exitCode}），现场已保留。`)
  return { status: 'conflicted', files }
}
/** Finish a conflicted merge after the conflict files hold their resolved bytes. */
async completeMerge(root: string, files: readonly string[], identity: GitIdentity): Promise<string> {
  if (!files.length) throw new Error('没有待完成的合并冲突文件。')
  await this.command(root, ['add', '--', ...files.map(gitRelativePath)])
  await this.command(root, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '--no-edit'])
  return fixedSha((await this.command(root, ['rev-parse', 'HEAD'])).stdout.trim())
}
```

文件顶部追加 `export type GitMergeResult = { status: 'merged'; commit: string } | { status: 'conflicted'; files: string[] }`。

- [ ] **Step 4: 测试通过 + `pnpm check:repository`。**

- [ ] **Step 5: Commit**

```bash
git add packages/studio-plugin/src/host/adapters/workspace/git.ts tests/windows-desktop/workspace-git-merge.test.ts
git commit -m "Git 适配器支持三路合并与冲突完成"
```

---

### Task 7: 分叉自动合并与 AI 冲突解决（CandidateMerges）

**Files:**
- Create: `packages/studio-plugin/src/host/application/candidate-merges.ts`
- Modify: `packages/studio-plugin/src/host/application/git-integrations.ts`（`RemoteDiverged`、`run` 分叉接管、`Dependencies.merge?`）
- Modify: `packages/studio-plugin/src/host/application/material-confirmations.ts`（`remap`、`mergeNote` 字段）
- Modify: `packages/studio-plugin/src/host/application/fixed-candidates.ts`（`materialEvidence` 改为公开 `materialChecks`，更新 :101 调用）
- Modify: `packages/studio-plugin/src/host/application/state.ts:19`（`PendingOperation.phase` 加 `'superseded'`）
- Modify: `packages/studio-plugin/src/host/application/studio.ts`（装配、会话输出路由、pending 过滤 superseded）
- Test: `tests/windows-desktop/candidate-merges.test.ts`（新建）
- Test: `tests/windows-desktop/git-integrations.test.ts`（追加分叉接管用例）

**Interfaces:**
- Consumes: Task 6 的 `merge/completeMerge`；`FixedCandidates.materialChecks(candidateSha, draft): CheckEvidence`；`ports.session/prompt`；`studio.ts` 的 `entity()`、`identity()`。
- Produces:
  - `MergeNote = { remoteFiles: string[]; aiFiles: string[] }`
  - `MergedCandidate = { task: TaskView; draft: MaterialDraft; prepare: MaterialIntegrationRequest; note: MergeNote }`
  - `mergeNoteText(note: MergeNote): string`
  - `CandidateMerges.merge(operation, request, remoteHead, branch): Promise<MergedCandidate | undefined>`（原任务现场缺失返回 `undefined`）
  - `CandidateMerges.accept(sessionId, output): Promise<boolean>`（接入 `acceptSessionOutput` 路由）
  - `MaterialConfirmations.remap(originalIntegrationId: string, next: MergedCandidate): Promise<void>`
  - `GitIntegrations` 的 `Dependencies.merge?(operation: PendingOperation, request: MaterialIntegrationRequest, head: string, branch: string): Promise<boolean>`
  - `RemoteDiverged extends Error { readonly head: string; readonly branch: string }`

- [ ] **Step 1: 写失败测试 `tests/windows-desktop/candidate-merges.test.ts`（完整代码）**

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CandidateMerges } from '../../packages/studio-plugin/src/host/application/candidate-merges.ts'
import { StudioStore, type PendingOperation } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { MaterialIntegrationRequest, CheckEvidence, EntityView } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'

const sha = (letter: string) => letter.repeat(40)
const candidate = sha('1'), expected = sha('2'), remote = sha('3'), merged = sha('4')
const task: TaskView = { projectId: 'p', entityId: 'e', sessionId: 's1', purpose: 'material', inputHash: '', worktree: '/w' }
const operation = { id: 'op1', accountId: 1, projectId: 'p', entityId: 'e', phase: 'unknown',
  task: { projectId: 'p', entityId: 'e', worktree: '/w', purpose: 'material', sessionId: 's1', inputHash: '' },
  candidateSha: candidate, expectedHead: expected, fixedPath: '场景/e.md', sha256: sha('c'), prepare: {}, token: {} } as PendingOperation
const request = { idempotencyKey: 'op1', sourceSha: candidate, candidateSha: candidate, expectedHead: expected,
  allowedPaths: ['场景/e.md'], checks: { candidateSha: candidate, passed: true, checks: [] }, entityId: 'e',
  token: {}, stage: 'material',
  confirmations: [{ entityId: 'e', fixed: { commitSha: candidate, path: '场景/e.md', sha256: sha('c') }, readHash: sha('c'), authorConfirmed: true }] } as unknown as MaterialIntegrationRequest
const draft = { path: '场景/e.md', sha256: sha('d'), body: 'merged', entityId: 'e', metadata: { entityId: 'e', sources: [] } } as unknown as MaterialDraft

async function fixture(t: { after(fn: () => unknown): void }, conflict: boolean, outOfScope = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'merges-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const local = await store.read(); local.tasks.push(structuredClone(task)); await store.save()
  const calls: string[] = []
  let currentHead = candidate
  const ports = {
    session: async (_task: TaskView) => 'studio-merge-op1-333333333333',
    prompt: async () => { calls.push('prompt') },
    git: {
      state: async () => ({ root: '/w', head: currentHead, branch: 'main', dirty: false, repositoryUrl: 'https://gitlab.test/p.git' }),
      fetch: async () => { calls.push('fetch') },
      changedFiles: async (_root: string, from: string, to: string) => from === expected && to === remote ? ['场景/remote.md'] : outOfScope ? ['其他/x.md'] : ['场景/e.md'],
      merge: async () => { currentHead = merged; return conflict ? { status: 'conflicted', files: ['场景/e.md'] } : { status: 'merged', commit: merged } },
      completeMerge: async (_root: string, files: string[]) => { calls.push(`complete:${files.join(',')}`); currentHead = merged; return merged },
    },
  } as unknown as HostPorts
  const merges = new CandidateMerges(store, ports, {
    entity: async () => ({ entity: { id: 'e', kind: 'scenario' } as EntityView }),
    identity: async () => ({ name: '作者', email: 'a@b.test' }),
    checks: (candidateSha: string) => ({ candidateSha, passed: true, checks: [] }) as CheckEvidence,
    readDraft: async () => structuredClone(draft),
  })
  return { merges, calls }
}

test('a clean merge rebuilds the candidate on the new remote head and keeps the original read hash', async t => {
  const { merges } = await fixture(t, false)
  const result = await merges.merge(operation, request, remote, 'main')
  assert.ok(result)
  assert.equal(result.prepare.idempotencyKey, `m-${merged}`)
  assert.equal(result.prepare.expectedHead, remote)
  assert.equal(result.prepare.candidateSha, merged)
  assert.equal(result.prepare.sourceSha, merged)
  assert.equal(result.prepare.confirmations[0]!.fixed.commitSha, merged)
  assert.equal(result.prepare.confirmations[0]!.fixed.sha256, sha('d'))
  assert.equal(result.prepare.confirmations[0]!.readHash, sha('c'), '用户阅读版本不随合并改变')
  assert.deepEqual(result.note, { remoteFiles: ['场景/remote.md'], aiFiles: [] })
})

test('a conflicted merge waits for the agent turn and completes the merge commit', async t => {
  const { merges, calls } = await fixture(t, true)
  const promise = merges.merge(operation, request, remote, 'main')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['fetch', 'prompt'])
  assert.equal(await merges.accept('studio-merge-op1-333333333333', { kind: 'turn-ended', reason: 'stop' }), true)
  const result = await promise
  assert.ok(result)
  assert.deepEqual(result.note.aiFiles, ['场景/e.md'])
  assert.ok(calls.includes('complete:场景/e.md'))
})

test('a merged result outside the material scope is rejected and nothing is produced', async t => {
  const { merges } = await fixture(t, false, true)
  await assert.rejects(merges.merge(operation, request, remote, 'main'), /超出本材料允许范围/)
})

test('a missing original task returns undefined for the manual recovery path', async t => {
  const { merges } = await fixture(t, false)
  const missing = { ...operation, task: { ...operation.task, worktree: '/gone' } }
  assert.equal(await merges.merge(missing, request, remote, 'main'), undefined)
})
```

- [ ] **Step 2: 运行确认失败**（模块不存在）。

- [ ] **Step 3: 实现 `candidate-merges.ts`（完整代码）**

```ts
import type { CheckEvidence, EntityView, MaterialIntegrationRequest } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../shared/studio.ts'
import type { GitIdentity } from '../adapters/workspace/git.ts'
import type { HostPorts, SessionOutput } from './ports.ts'
import type { PendingOperation, StudioStore } from './state.ts'

export interface MergeNote { remoteFiles: string[]; aiFiles: string[] }
export interface MergedCandidate { task: TaskView; draft: MaterialDraft; prepare: MaterialIntegrationRequest; note: MergeNote }
export function mergeNoteText(note: MergeNote): string {
  if (!note.remoteFiles.length && !note.aiFiles.length) return '已基于远端最新版本重建候选'
  const automatic = note.remoteFiles.length ? `已自动合并远端变更：${note.remoteFiles.join('、')}` : ''
  const ai = note.aiFiles.length ? `${automatic ? '；' : ''}AI 解决冲突：${note.aiFiles.join('、')}` : ''
  return `${automatic}${ai}`
}
interface Dependencies {
  entity(entityId: string, projectId?: string): Promise<{ entity: EntityView }>
  identity(projectId: string): Promise<GitIdentity>
  checks(candidateSha: string, draft: MaterialDraft): CheckEvidence
  readDraft(task: TaskView, entity: EntityView): Promise<MaterialDraft>
}
const mergeRules = '你是合并助手。当前工作区处于 git merge 冲突状态。逐个读取冲突文件，保留双方有效业务内容，解决全部冲突标记后直接写入合并后的完整文件。不提交、不执行 git 命令、不改冲突清单之外的文件。完成后用中文简述每个文件如何合并。'

/** Rebuilds a fixed candidate on a moved remote head; the agent resolves conflicts in place. */
export class CandidateMerges {
  private readonly pending = new Map<string, (error?: Error) => void>()
  constructor(private readonly store: StudioStore, private readonly ports: Pick<HostPorts, 'git' | 'session' | 'prompt'>, private readonly deps: Dependencies) {}

  async merge(operation: PendingOperation, request: MaterialIntegrationRequest, remoteHead: string, branch: string): Promise<MergedCandidate | undefined> {
    const local = await this.store.read()
    const task = local.tasks.find(value => value.projectId === operation.projectId && value.entityId === operation.entityId && value.worktree === operation.task.worktree && value.sessionId === operation.task.sessionId && value.purpose === operation.task.purpose)
    if (!task || task.cleanup) return undefined
    const { entity } = await this.deps.entity(operation.entityId, operation.projectId)
    const state = await this.ports.git.state(task.worktree)
    if (state.head !== operation.candidateSha) throw new Error('候选提交已变化，请核对原候选后再集成')
    await this.ports.git.fetch(task.worktree, branch)
    const identity = await this.deps.identity(operation.projectId)
    const remoteFiles = await this.ports.git.changedFiles(task.worktree, operation.expectedHead, remoteHead)
    const result = await this.ports.git.merge(task.worktree, remoteHead, identity)
    const aiFiles = result.status === 'conflicted' ? result.files : []
    const mergeSha = result.status === 'merged' ? result.commit : await this.resolveWithAgent(task, operation, remoteHead, result.files, identity)
    const after = await this.ports.git.state(task.worktree)
    if (after.dirty || after.head !== mergeSha) throw new Error('合并后工作区仍有未提交改动，已保留现场请核对')
    const scope = await this.ports.git.changedFiles(task.worktree, remoteHead, mergeSha)
    if (!scope.length || scope.some(file => !request.allowedPaths.includes(file))) throw new Error('合并结果超出本材料允许范围，已保留现场请核对')
    const draft = await this.deps.readDraft(task, entity)
    const confirmations = request.confirmations.map(value => ({ ...value, fixed: { ...value.fixed, commitSha: mergeSha, path: draft.path, sha256: draft.sha256 } }))
    const prepare: MaterialIntegrationRequest = { ...request, idempotencyKey: `m-${mergeSha}`, sourceSha: mergeSha, candidateSha: mergeSha,
      expectedHead: remoteHead, confirmations, checks: this.deps.checks(mergeSha, draft) }
    return { task, draft, prepare, note: { remoteFiles, aiFiles } }
  }

  /** Session-output entry: only merge sessions are claimed; everything else falls through. */
  async accept(sessionId: string, output: SessionOutput): Promise<boolean> {
    const settle = this.pending.get(sessionId)
    if (!settle) return false
    if (output.kind === 'turn-ended') { this.pending.delete(sessionId); settle(output.reason === 'aborted' ? new Error('AI 合并已中止，现场已保留') : undefined) }
    return true
  }

  private async resolveWithAgent(task: TaskView, operation: PendingOperation, remoteHead: string, files: string[], identity: GitIdentity): Promise<string> {
    const sessionId = `studio-merge-${operation.id}-${remoteHead.slice(0, 12)}`
    const sessionTask: TaskView = { ...task, sessionId }
    const completion = new Promise<void>((resolve, reject) => this.pending.set(sessionId, error => error ? reject(error) : resolve()))
    const timeout = new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('AI 合并超时，现场已保留')), 600_000); timer.unref() })
    try {
      await this.ports.session(sessionTask, mergeRules)
      await this.ports.prompt(sessionId, `本次合并的冲突文件：${files.join('、')}。原候选提交 ${operation.candidateSha}，远端新头 ${remoteHead}。请直接在工作区写入每个冲突文件的合并结果。`)
      await Promise.race([completion, timeout])
      return await this.ports.git.completeMerge(task.worktree, files, identity)
    } finally { this.pending.delete(sessionId) }
  }
}
```

- [ ] **Step 4: `fixed-candidates.ts` 将 `private async materialEvidence` 改为公开 `materialChecks`（签名与实现不变），并更新 :101 的 `this.materialEvidence(...)` 调用为 `this.materialChecks(...)`。**

- [ ] **Step 5: `git-integrations.ts` 分叉接管**

1. 新增并导出：

```ts
export class RemoteDiverged extends Error {
  constructor(readonly head: string, readonly branch: string) { super('Git 集成头已变化，需核对原候选并重新集成') }
}
```

2. `publish` 的 `else if (head !== operation.candidateSha) throw new Error('Git 集成头已变化，需核对原候选并重新集成')` 改为 `else if (head !== operation.candidateSha) throw new RemoteDiverged(head, branch)`。
3. `Dependencies` 增加 `merge?(operation: PendingOperation, request: MaterialIntegrationRequest, head: string, branch: string): Promise<boolean>`。
4. `run`：在 `try` 之前声明 `let request: MaterialIntegrationRequest | undefined`，把 try 内第一行改为 `request = this.prepare(operation)`（赋值仍在 try 内，准备失败仍走原失败路径），catch 块最前面插入：

```ts
if (error instanceof RemoteDiverged && request && operation.phase !== 'accepted' && this.deps.merge) {
  const handled = await this.deps.merge(operation, request, error.head, error.branch)
  if (handled) return
}
```

- [ ] **Step 6: `MaterialConfirmationOperation` 增加 `mergeNote?: MergeNote`（`import type { MergeNote } from './candidate-merges.ts'`，`mergeNoteText` 为运行时导入），并新增 `remap`：**

```ts
/** Rebind a confirmation to its merged candidate; the author's original read hash stays untouched. */
async remap(originalIntegrationId: string, next: MergedCandidate): Promise<void> {
  const local = await this.store.read()
  const operation = local.scenarios.flatMap(record => record.materialConfirmations ?? []).find(value => value.integrationId === originalIntegrationId)
  if (!operation) throw new Error('原确认记录缺失，合并候选已保留')
  operation.integrationId = next.prepare.idempotencyKey
  operation.prepare = structuredClone(next.prepare)
  operation.candidate = { ...operation.candidate!, task: structuredClone(next.task), draft: structuredClone(next.draft),
    prepare: structuredClone(next.prepare), confirmations: structuredClone(next.prepare.confirmations) }
  operation.mergeNote = structuredClone(next.note)
  operation.message = `${mergeNoteText(next.note)}，正在核对集成结果`
  operation.phase = 'integrating'
  await this.store.save()
}
```

- [ ] **Step 7: `state.ts:19` 的 phase 联合加 `'superseded'`；`studio.ts` 装配与路由**

1. 构造器内（`this.integrations = ...` 之前）：

```ts
this.candidateMerges = new CandidateMerges(store, ports, {
  entity: (id, projectId) => this.entity(id, projectId),
  identity: projectId => this.identity(projectId),
  checks: (candidateSha, draft) => this.fixedCandidates.materialChecks(candidateSha, draft),
  readDraft: (task, entity) => readMaterial(task.worktree, entity.kind, entity.id),
})
```

类属性声明 `readonly candidateMerges: CandidateMerges` 并 import。`this.integrations` 的 deps 增加：

```ts
merge: async (operation, request, head, branch) => {
  if (request.stage !== 'material') return false
  const merged = await this.candidateMerges.merge(operation, request, head, branch)
  if (!merged) return false
  const local = await this.store.read()
  const original = local.operations.find(value => value.id === operation.id && value.projectId === operation.projectId)
  if (original) { original.phase = 'superseded'; original.message = '已由自动合并候选承接' }
  await this.confirmations.remap(operation.id, merged)
  await this.store.save()
  await this.integrations.submit(merged.task, merged.draft, merged.prepare)
  return true
}
```

2. `acceptSessionOutput`（studio.ts:798-806）在 `if (await this.repairs.accept(...))` 之前插入 `if (await this.candidateMerges.accept(sessionId, output)) return`。
3. `state()` 的 pending 构造（studio.ts:489）：在 `.filter(op => op.projectId === selected?.id)` 上追加 `&& op.phase !== 'superseded'`。

- [ ] **Step 8: 在 `tests/windows-desktop/git-integrations.test.ts` 追加分叉接管用例**

```ts
test('a diverged remote head is handed to the merge dependency instead of failing', async t => {
  const f = await fixture(t)
  // 让 fake git 的 remoteHead 返回一个既非 expectedHead 也非 candidateSha 的值（按 fixture 实际变量设置）
  f.setRemoteHead('f'.repeat(40))
  const seen: string[] = []
  const runner = new GitIntegrations(f.store, f.api, f.ports, f.lane, {
    accepted: async () => undefined,
    merge: async (_operation, _request, head) => { seen.push(head); return true },
  })
  await runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.deepEqual(seen, ['f'.repeat(40)])
})
```

fixture 若没有 `setRemoteHead`/`f.store/f.api/f.ports` 导出，在该文件内补充（remoteHead 已是 fake 的可变值，见 `tests/windows-desktop/git-integrations.test.ts:67-83`）。另补一条 `merge` 返回 `false` 时操作落 `phase='unknown'` 且 message 为「Git 集成头已变化…」的断言。

- [ ] **Step 9: 全部相关测试通过 + 全量 Host 测试无回归 + `pnpm check:repository`。**

- [ ] **Step 10: Commit**

```bash
git add packages/studio-plugin/src tests/windows-desktop/candidate-merges.test.ts tests/windows-desktop/git-integrations.test.ts
git commit -m "远端分叉自动合并，冲突由 AI 产出合并结果"
```

---

### Task 8: 合并结果用户提示

**Files:**
- Modify: `packages/studio-plugin/src/host/application/material-confirmations.ts`（新增 `mergeNoticeFor`）
- Modify: `packages/studio-plugin/src/shared/scenarios.ts`（`ScenarioWorkspace` 加 `mergeNotice?: string`）
- Modify: `packages/studio-plugin/src/host/application/scenario-workspaces.ts`（snapshot 投影 mergeNotice）
- Modify: `packages/studio-plugin/src/client/scenarios/ScenarioWorkspace.tsx`（notice 展示）
- Test: `tests/windows-desktop/material-confirmation-merge-note.test.ts`（新建）

**Interfaces:**
- Produces: `mergeNoticeFor(owner: ScenarioRecord): string | undefined`——最近一次确认 `phase='accepted'` 且带 `mergeNote` 时返回 `mergeNoteText(note)`；`ScenarioWorkspace.mergeNotice?: string`；确认进行中由 Task 4 的 `view()` 通过 `operation.message` 显示同一文案（`remap` 已写入）。

- [ ] **Step 1: 写失败测试（完整代码）**

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeNoticeFor } from '../../packages/studio-plugin/src/host/application/material-confirmations.ts'
import { mergeNoteText } from '../../packages/studio-plugin/src/host/application/candidate-merges.ts'
import type { ScenarioRecord } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'

const owner = (phase: string, note?: { remoteFiles: string[]; aiFiles: string[] }) => ({
  materialConfirmations: [{ operationId: 'c1', phase, mergeNote: note }],
}) as ScenarioRecord

test('merge notes tell the user exactly which files were merged automatically and by AI', () => {
  assert.equal(mergeNoteText({ remoteFiles: ['场景/a.md'], aiFiles: [] }), '已自动合并远端变更：场景/a.md')
  assert.equal(mergeNoteText({ remoteFiles: ['场景/a.md'], aiFiles: ['场景/b.md'] }), '已自动合并远端变更：场景/a.md；AI 解决冲突：场景/b.md')
  assert.equal(mergeNoticeFor(owner('accepted', { remoteFiles: ['场景/a.md'], aiFiles: [] })), '已自动合并远端变更：场景/a.md')
  assert.equal(mergeNoticeFor(owner('accepted')), undefined)
  assert.equal(mergeNoticeFor(owner('integrating', { remoteFiles: ['场景/a.md'], aiFiles: [] })), undefined)
})
```

- [ ] **Step 2: 运行确认失败（`mergeNoticeFor` 不存在）。**

- [ ] **Step 3: 实现。** `material-confirmations.ts` 追加：

```ts
/** The latest accepted confirmation keeps its merge note visible until a new confirmation starts. */
export function mergeNoticeFor(owner: ScenarioRecord): string | undefined {
  const operation = current(owner)
  return operation?.phase === 'accepted' && operation.mergeNote ? mergeNoteText(operation.mergeNote) : undefined
}
```

`shared/scenarios.ts` 的 `ScenarioWorkspace` 增加 `mergeNotice?: string`；`scenario-workspaces.ts` 的 snapshot 返回对象（约 :182 的对象字面量）追加 `...(mergeNoticeFor(record) ? { mergeNotice: mergeNoticeFor(record) } : {})`（import `mergeNoticeFor`）。
`ScenarioWorkspace.tsx` 在工作区主容器顶部渲染（沿用该文件现有 css 模块导入；若无则 `import css from '../studio.module.css'`）：

```tsx
{scenario.mergeNotice && <div className={css.notice}>{scenario.mergeNotice}</div>}
```

（`scenario` 变量名以该组件实际 props 为准。）

- [ ] **Step 4: 测试通过 + `pnpm check:repository`。**

- [ ] **Step 5: Commit**

```bash
git add packages/studio-plugin/src tests/windows-desktop/material-confirmation-merge-note.test.ts
git commit -m "确认视图提示自动合并与 AI 合并文件清单"
```

---

## 收尾

- [ ] 全量验证：`apps/collaboration-api/node_modules/.bin/tsx --test tests/windows-desktop/*.test.ts`、后端 `backend-status-reports.test.ts` 与 `backend-comparisons.test.ts`（真实测试库）、`pnpm check:repository` 全部通过。
- [ ] 按验收口径复核设计文档三项缺口逐条关闭，必要时更新 `docs/milestones.md`。

---

## Task 7 修正记录（评审后，2026-10-26，用户已批准）

评审发现原方案两处计划级错误与两处 AI 生命周期缺陷，按以下修正执行，替代 Task 7 对应原文：

1. **后端 supersede 协议**（原"后端零改动"作废）：分叉时原集成在后端已是 `prepared`，直接提交新候选会被 `INTEGRATION_PENDING`（`modules/integration.ts:84`）拒绝。修正：`validateIntegration` 在 `assertOccupation` 之后，允许同占用（同 occupationId）的新 prepare 在同一事务内将该占用旧的 prepared 集成置为 `aborted`（可复用 `repository.abortIntegrations`），再写入新集成；其他占用/其他实体的 prepared 仍按 `INTEGRATION_PENDING` 拒绝。后端补真实 PostgreSQL 测试：同占用替换 prepare 后旧记录 aborted、新记录 prepared；不同占用仍 409。
2. **合并方向反转**（保证 `mergeSha^1 === remoteHead`）：先在工作区基于 `remoteHead` 检出临时合并分支，再 `git merge --no-ff --no-edit <原candidateSha>`；冲突时 `completeMerge` 保持该分支状态。适配器可增加一个"从指定 base 建分支"的小原语（如 `checkoutBranch(root, branch, baseSha)`），原 `merge` 不变。`CandidateMerges` 增加 `mergeSha` 第一父校验（`rev-list --parents -n 1` 经 `gitLocal`，其白名单已含 rev-list）：`parents[0] === mergeSha && parents[1] === remoteHead && parents.length === 3`，不符则抛错保留现场。
3. **AI 结束语义**：`accept` 仅 `turn-ended` 且 `reason === 'stop'` 视为成功；`error`、`aborted` 及其他 reason 全部以错误 settle，不进入 `completeMerge`。补 error/aborted/超时三个行为测试。
4. **超时生命周期**：超时除报错外必须 `await this.ports.cancelSession?.(sessionId)` 取消会话；迟到的输出因 pending 已删除而被 `accept` 忽略（返回 false）。计时器句柄提升为局部变量，在 `finally` 中 `clearTimeout`。
