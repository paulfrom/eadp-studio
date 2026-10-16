# 桌面升级接口与协同后端容器化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面端默认协同地址指向 `http://100.119.183.44:6972`；协同后端实现 DSH 强制更新策略检查接口 `/api/v0/check_client_update`；后端交付 Dockerfile 与根目录 `start-backend.sh` 一键启动（compose 编排 PostgreSQL + API）。

**Architecture:** 协同后端（Fastify + pg，tsx 直跑 TS）新增纯函数裁决模块 + 无会话路由；容器化为多阶段 Dockerfile（pnpm workspace 安装 → 非 root 运行时，entrypoint 幂等建 schema）；compose 仅本机一键拉起，企业形态仍是独立 PG + API 镜像。设计文档：`docs/superpowers/specs/2026-10-16-desktop-update-and-containerization-design.md`。

**Tech Stack:** Node 22 / pnpm 11.28.5 / Fastify 5 / pg 8 / tsx / node:test / Docker Compose。

## Global Constraints

- 不修改 `.local/upstream/dsh/` 上游缓存；不动 `apps/desktop-distribution/build/desktop-policy-edits.mjs`。
- 不改 `db:init` 既有语义；不引入迁移/兼容层（schema.sql 仍是唯一建库定义）。
- 升级接口契约（取证自上游 commit d743267，客户端 `mandatory-update-policy.ts`）：
  - 请求：`GET /api/v0/check_client_update?scenario=<任意>`；无鉴权；版本在 header `x-client-version`。
  - 放行：HTTP 2xx 且 body 严格 `{"code":0,"data":{"biz_code":0,"biz_data":null}}`。
  - 强制：`{"code":40005,"data":{"show_content":{"title"?,"detail"?},"desktop_app_link"?}}`；字段全可选，裸 `{"code":40005}` 即阻断；HTTP 状态码不参与判定。
  - `desktop_app_link` 客户端要求 HTTPS 且 origin 在桌面 manifest `allowedPageOrigins` 内，否则被丢弃。
- 裁决 fail-closed：配置了 `DESKTOP_UPDATE_MIN_VERSION` 时，header 缺失或版本不可解析 → 强制。
- 环境变量名固定：`DESKTOP_UPDATE_MIN_VERSION` / `DESKTOP_UPDATE_BLOCK_TITLE` / `DESKTOP_UPDATE_BLOCK_DETAIL` / `DESKTOP_UPDATE_APP_LINK`（可选；APP_LINK 必须是 HTTPS URL）。
- 不新增第三方依赖：semver 比较用最小自实现（lockfile 中的 semver 只是传递依赖，pnpm 严格模式下不可直接引用）。
- 端口约定：compose 默认映射 `6972:3001`，可用 `EADP_API_PORT` 覆盖（本机 systemd 服务已占 6972，验证时必须用覆盖端口）。
- 提交信息沿用仓库 conventional 风格（`feat:` / `docs:`，英文小写摘要）。

---

### Task 1: 桌面升级裁决模块与配置

**Files:**
- Create: `apps/collaboration-api/src/desktop-update.ts`
- Create: `apps/collaboration-api/src/desktop-update.test.ts`
- Modify: `apps/collaboration-api/src/config.ts`（接口 + `loadConfig` 末尾追加可选解析）

**Interfaces:**
- Produces:
  - `parseVersion(value: string): { major: number; minor: number; patch: number; prerelease: string[] } | undefined`
  - `compareVersions(a: NonNullable<ReturnType<typeof parseVersion>>, b: NonNullable<ReturnType<typeof parseVersion>>): number`（语义同 semver 优先级，返回负数/0/正数）
  - `decideDesktopUpdate(config: Config, headers: Record<string, unknown>): { code: 0; data: { biz_code: 0; biz_data: null } } | { code: 40005; data: { show_content: { title?: string; detail?: string }; desktop_app_link?: string } }`
  - `Config` 新增字段 `desktopUpdate?: { minVersion: string; title?: string; detail?: string; appLink?: string }`

- [ ] **Step 1: 写失败测试**

创建 `apps/collaboration-api/src/desktop-update.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.js';
import { compareVersions, decideDesktopUpdate, parseVersion } from './desktop-update.js';

const base = { DATABASE_URL: 'postgresql://synthetic', PG_SSL: 'disable', GITLAB_URL: 'http://gitlab.test', GITLAB_ALLOW_HTTP: 'true' };

test('parseVersion accepts semantic versions with optional prerelease and build metadata', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion('0.2.1-alpha.2'), { major: 0, minor: 2, patch: 1, prerelease: ['alpha', '2'] });
  assert.equal(parseVersion('0.2.1+build.5')!.prerelease.length, 0);
  assert.equal(parseVersion('v1.2'), undefined);
  assert.equal(parseVersion('1.2.x'), undefined);
  assert.equal(parseVersion(''), undefined);
});

test('compareVersions follows semver precedence including prerelease ordering', () => {
  const v = (s: string) => parseVersion(s)!;
  assert.ok(compareVersions(v('1.2.3'), v('1.2.10')) < 0);
  assert.ok(compareVersions(v('2.0.0'), v('1.9.9')) > 0);
  assert.equal(compareVersions(v('1.2.3'), v('1.2.3')), 0);
  assert.ok(compareVersions(v('1.0.0'), v('1.0.0-alpha')) > 0, 'release outranks prerelease');
  assert.ok(compareVersions(v('1.0.0-alpha.1'), v('1.0.0-alpha.2')) < 0);
  assert.ok(compareVersions(v('1.0.0-alpha'), v('1.0.0-alpha.1')) < 0, 'shorter prerelease has lower precedence');
  assert.ok(compareVersions(v('1.0.0-1'), v('1.0.0-alpha')) < 0, 'numeric identifier ranks below alphanumeric');
});

test('an unconfigured policy always returns the exact clear decision', () => {
  const config = loadConfig(base);
  assert.deepEqual(decideDesktopUpdate(config, {}), { code: 0, data: { biz_code: 0, biz_data: null } });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': '0.0.1' }), { code: 0, data: { biz_code: 0, biz_data: null } });
});

test('clients at or above the minimum version are cleared', () => {
  const config = loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.2.0' });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': '1.2.0' }), { code: 0, data: { biz_code: 0, biz_data: null } });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': '1.3.0-alpha.1' }), { code: 0, data: { biz_code: 0, biz_data: null } });
});

test('clients below the minimum version or with an unparsable version are blocked', () => {
  const config = loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.2.0', DESKTOP_UPDATE_BLOCK_TITLE: '请升级', DESKTOP_UPDATE_BLOCK_DETAIL: '详细说明' });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': '1.1.9' }), { code: 40005, data: { show_content: { title: '请升级', detail: '详细说明' } } });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': 'garbage' }).code, 40005);
  assert.deepEqual(decideDesktopUpdate(config, {}).code, 40005, 'missing version header fails closed');
});

test('an optional HTTPS app link is attached to the block decision', () => {
  const config = loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.0.0', DESKTOP_UPDATE_APP_LINK: 'https://download.example.com/eadp' });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': '0.9.0' }), { code: 40005, data: { show_content: {}, desktop_app_link: 'https://download.example.com/eadp' } });
});

test('config load rejects an invalid minimum version or a non-HTTPS app link', () => {
  assert.throws(() => loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: 'v1.2' }), /DESKTOP_UPDATE_MIN_VERSION/);
  assert.throws(() => loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.0.0', DESKTOP_UPDATE_APP_LINK: 'http://100.119.183.44/download' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.0.0', DESKTOP_UPDATE_APP_LINK: 'not-a-url' }), /DESKTOP_UPDATE_APP_LINK/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/collaboration-api && pnpm exec tsx --test src/desktop-update.test.ts`
Expected: FAIL，`Cannot find module './desktop-update.js'`（或 `decideDesktopUpdate is not a function`）。

- [ ] **Step 3: 实现 `desktop-update.ts`**

```ts
import type { Config } from './config.js';

export interface SemVer { major: number; minor: number; patch: number; prerelease: string[] }
export type DesktopUpdateDecision =
  | { code: 0; data: { biz_code: 0; biz_data: null } }
  | { code: 40005; data: { show_content: { title?: string; detail?: string }; desktop_app_link?: string } };

export function parseVersion(value: string): SemVer | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ? match[4].split('.') : [] };
}

export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined || y === undefined) return (x === undefined ? -1 : 1);
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function decideDesktopUpdate(config: Config, headers: Record<string, unknown>): DesktopUpdateDecision {
  const policy = config.desktopUpdate;
  const clear: DesktopUpdateDecision = { code: 0, data: { biz_code: 0, biz_data: null } };
  if (!policy) return clear;
  const client = parseVersion(String(headers['x-client-version'] ?? ''));
  if (client && compareVersions(client, parseVersion(policy.minVersion)!) >= 0) return clear;
  const show_content: { title?: string; detail?: string } = {};
  if (policy.title) show_content.title = policy.title;
  if (policy.detail) show_content.detail = policy.detail;
  const data: { show_content: { title?: string; detail?: string }; desktop_app_link?: string } = { show_content };
  if (policy.appLink) data.desktop_app_link = policy.appLink;
  return { code: 40005, data };
}
```

- [ ] **Step 4: 扩展 `config.ts`**

在 `apps/collaboration-api/src/config.ts` 顶部加 `import { parseVersion } from './desktop-update.js';`；`Config` 接口追加 `desktopUpdate?: { minVersion: string; title?: string; detail?: string; appLink?: string };`；`loadConfig` 的 `return` 之前追加：

```ts
  let desktopUpdate: Config['desktopUpdate'];
  if (env.DESKTOP_UPDATE_MIN_VERSION) {
    requireCondition(parseVersion(env.DESKTOP_UPDATE_MIN_VERSION) !== undefined, 'INVALID_CONFIG', 'DESKTOP_UPDATE_MIN_VERSION must be a semantic version', 500);
    if (env.DESKTOP_UPDATE_APP_LINK) {
      let link: URL;
      try { link = new URL(env.DESKTOP_UPDATE_APP_LINK); } catch { requireCondition(false, 'INVALID_CONFIG', 'Invalid DESKTOP_UPDATE_APP_LINK', 500); }
      requireCondition(link!.protocol === 'https:' && !link!.username && !link!.password, 'INVALID_CONFIG', 'DESKTOP_UPDATE_APP_LINK must be an HTTPS URL without credentials', 500);
    }
    desktopUpdate = { minVersion: env.DESKTOP_UPDATE_MIN_VERSION, title: env.DESKTOP_UPDATE_BLOCK_TITLE, detail: env.DESKTOP_UPDATE_BLOCK_DETAIL, appLink: env.DESKTOP_UPDATE_APP_LINK };
  }
```

`return` 语句整行替换为（追加 `desktopUpdate`；注意 `config.ts` 对 `desktop-update.ts` 是值导入、`desktop-update.ts` 对 `config.ts` 仅类型导入，无运行时循环）：

```ts
  return { publisherIds: new Set(publisherIds.map(Number)), publicationTokenSecret: env.PUBLICATION_TOKEN_SECRET, publicApiUrl: env.PUBLIC_API_URL?.replace(/\/$/, ''), databaseUrl: env.DATABASE_URL, databaseSsl: env.PG_SSL === 'require', gitlabUrl: url!.origin, gitlabToken: env.SEI_GITLAB_TOKEN || undefined, host: env.HOST ?? '127.0.0.1', port, desktopUpdate };
```

- [ ] **Step 5: 跑测试与类型检查确认通过**

Run: `cd apps/collaboration-api && pnpm exec tsx --test src/desktop-update.test.ts && pnpm exec tsc --noEmit`
Expected: 全部 PASS，typecheck 无输出。

- [ ] **Step 6: 提交**

```bash
git add apps/collaboration-api/src/desktop-update.ts apps/collaboration-api/src/desktop-update.test.ts apps/collaboration-api/src/config.ts
git commit -m "feat(collaboration-api): add desktop update decision module"
```

---

### Task 2: 升级检查路由与会话豁免

**Files:**
- Modify: `apps/collaboration-api/src/routes.ts:11`（豁免名单）、文件末尾追加路由
- Modify: `apps/collaboration-api/src/routes.ts:8`（`registerRoutes` 签名加 `config: Config` 参数）
- Modify: `apps/collaboration-api/src/app.ts:25`（传入 `config`）
- Test: `apps/collaboration-api/src/desktop-update.test.ts`（追加路由级测试）

**Interfaces:**
- Consumes: Task 1 的 `decideDesktopUpdate(config, headers)`、`loadConfig`。
- Produces: `GET /api/v0/check_client_update` 路由（无会话要求，`scenario` query 忽略）。

- [ ] **Step 1: 追加失败的路由测试**

在 `apps/collaboration-api/src/desktop-update.test.ts` 顶部追加导入：

```ts
import { createApp } from './app.js';
import type { Database } from './persistence/database.js';
```

文件末尾追加（mock 数据库只需满足 `onReady` 的 `ensureTestUser` 单次 `query` 与 `onClose` 的 `end`）：

```ts
test('the check endpoint is served without a session and ignores the scenario parameter', async () => {
  const database = { query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} } as unknown as Database;
  const app = createApp(loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.2.0' }), database);
  const blocked = await app.inject({ method: 'GET', url: '/api/v0/check_client_update?scenario=launch', headers: { 'x-client-version': '0.9.0' } });
  assert.equal(blocked.statusCode, 200);
  assert.equal(blocked.json().code, 40005);
  const cleared = await app.inject({ method: 'GET', url: '/api/v0/check_client_update?scenario=periodic', headers: { 'x-client-version': '1.2.0' } });
  assert.deepEqual(cleared.json(), { code: 0, data: { biz_code: 0, biz_data: null } });
  const anonymous = await app.inject({ method: 'GET', url: '/api/v0/check_client_update' });
  assert.equal(anonymous.statusCode, 200, 'no Authorization header is required');
  assert.equal(anonymous.json().code, 40005, 'missing version fails closed when a minimum is configured');
  await app.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/collaboration-api && pnpm exec tsx --test src/desktop-update.test.ts`
Expected: 新测试 FAIL，`404`（路由尚不存在，命中 `ROUTE_NOT_FOUND`）。

- [ ] **Step 3: 接线路由**

`apps/collaboration-api/src/routes.ts` 三处修改：

1. 顶部导入区追加：

```ts
import type { Config } from './config.js';
import { decideDesktopUpdate } from './desktop-update.js';
```

2. 第 8 行签名改为 `export function registerRoutes(app: FastifyInstance, service: CollaborationService, config: Config) {`。
3. 第 11 行整行替换为：

```ts
    if (request.routeOptions.url === '/health' || request.routeOptions.url === '/v1/auth/login' || request.routeOptions.url === '/v1/projects/:projectId/publication-current' || request.routeOptions.url === '/api/v0/check_client_update') return;
```

4. `/health` 路由行之后追加：

```ts
  app.get('/api/v0/check_client_update', request => decideDesktopUpdate(config, request.headers));
```

`apps/collaboration-api/src/app.ts:25` 改为：

```ts
  registerRoutes(app, new CollaborationService(database, gitlab, new PublicationAuthorization(config), auth), config);
```

- [ ] **Step 4: 跑测试与类型检查确认通过**

Run: `cd apps/collaboration-api && pnpm exec tsx --test src/ && pnpm exec tsc --noEmit`
Expected: 全部 PASS（含既有 `auth/gitlab.test.ts`、`project-initialization.test.ts`；`backend-lifecycle` 不在 `src/` 不受影响），typecheck 干净。

- [ ] **Step 5: 提交**

```bash
git add apps/collaboration-api/src/routes.ts apps/collaboration-api/src/app.ts apps/collaboration-api/src/desktop-update.test.ts
git commit -m "feat(collaboration-api): serve desktop update check endpoint"
```

---

### Task 3: 桌面端默认协同地址

**Files:**
- Modify: `packages/studio-plugin/src/host/composition.ts:35`

**Interfaces:**
- Produces: 桌面默认 `collaborationUrl` = `http://100.119.183.44:6972`（profile `cordis.patch.yml` 仍可覆盖）。

- [ ] **Step 1: 修改默认值**

`packages/studio-plugin/src/host/composition.ts:35` 改为：

```ts
  const collaborationUrl = config.collaborationUrl ?? 'http://100.119.183.44:6972'
```

- [ ] **Step 2: 确认无残留引用**

Run: `rg -n "127\.0\.0\.1:3001" packages/studio-plugin/src || true`
Expected: 无输出（唯一旧默认已替换）。此工作区无 `vendor/cordis`，独立 host typecheck 不可跑；字符串字面量改动不改变类型，桌面 typecheck 在下次 Windows 装配时执行。

- [ ] **Step 3: 提交**

```bash
git add packages/studio-plugin/src/host/composition.ts
git commit -m "feat(studio-plugin): default collaboration backend to tailscale address"
```

---

### Task 4: Dockerfile、entrypoint 与幂等建 schema

**Files:**
- Create: `apps/collaboration-api/Dockerfile`
- Create: `apps/collaboration-api/docker-entrypoint.sh`
- Create: `apps/collaboration-api/src/persistence/schema.ts`
- Create: `apps/collaboration-api/src/persistence/ensure-schema.ts`
- Modify: `apps/collaboration-api/src/persistence/initialize.ts`（改用共享 `applySchema`，行为不变）
- Create: `.dockerignore`（仓库根）

**Interfaces:**
- Produces: 镜像 `eadp-collaboration-api:local`；容器入口 `docker-entrypoint.sh`；`schemaApplied(c): Promise<boolean>`、`applySchema(c): Promise<void>`；镜像内启动命令 `node --use-env-proxy --import=tsx src/bootstrap.ts`（端口 3001，监听 `HOST`）。

- [ ] **Step 1: 抽取共享 schema 模块并重写 `initialize.ts`**

创建 `apps/collaboration-api/src/persistence/schema.ts`：

```ts
import { readFile } from 'node:fs/promises';
import type { Transaction } from './database.js';

export async function schemaApplied(c: Transaction): Promise<boolean> {
  return (await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='studio_users'")).rowCount > 0;
}

export async function applySchema(c: Transaction): Promise<void> {
  const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8');
  await c.query(schema);
}
```

`apps/collaboration-api/src/persistence/initialize.ts` 全文替换为：

```ts
import { createDatabase, transaction } from './database.js';
import { loadConfig } from '../config.js';
import { applySchema } from './schema.js';
const database = createDatabase(loadConfig());
try {
  await transaction(database, applySchema);
  console.log('Created the current collaboration schema.');
} catch { console.error('Schema initialization failed; check database reachability and whether the schema already exists.'); process.exitCode = 1; }
finally { await database.end(); }
```

- [ ] **Step 2: 写 `ensure-schema.ts`（检查-条件应用，可重复执行）**

创建 `apps/collaboration-api/src/persistence/ensure-schema.ts`：

```ts
import { createDatabase, transaction } from './database.js';
import { loadConfig } from '../config.js';
import { applySchema, schemaApplied } from './schema.js';
const database = createDatabase(loadConfig());
try {
  if (await transaction(database, schemaApplied)) console.log('Collaboration schema already present; skipping initialization.');
  else {
    await transaction(database, applySchema);
    console.log('Created the current collaboration schema.');
  }
} catch { console.error('Schema check failed; check database reachability and whether the schema is valid.'); process.exitCode = 1; }
finally { await database.end(); }
```

注意：`schemaApplied`/`applySchema` 来自 Step 1 的 `schema.ts`；`ensure-schema.ts` 与 `initialize.ts` 共用 `db/schema.sql`，schema.sql 仍是唯一建库定义。实现注记：`rowCount` 在 pg 类型中为 `number | null`，需写 `(…rowCount ?? 0) > 0` 才能通过 typecheck；fresh `pnpm install`（pnpm 11 `strictDepBuilds`）需要 `pnpm-workspace.yaml` 增加 `allowBuilds: { esbuild: true }` 审批 esbuild 构建脚本（tsx 的传递依赖）。

- [ ] **Step 3: 写 Dockerfile**

创建 `apps/collaboration-api/Dockerfile`：

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/collaboration-api/package.json apps/collaboration-api/
COPY apps/desktop-distribution/package.json apps/desktop-distribution/
COPY packages/asset-domain/package.json packages/asset-domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/studio-plugin/package.json packages/studio-plugin/
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/apps/collaboration-api
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/collaboration-api/node_modules /app/apps/collaboration-api/node_modules
COPY --from=deps /app/packages/asset-domain/node_modules /app/packages/asset-domain/node_modules
COPY --from=deps /app/packages/contracts/node_modules /app/packages/contracts/node_modules
COPY --from=deps /app/packages/studio-plugin/node_modules /app/packages/studio-plugin/node_modules
COPY packages/asset-domain /app/packages/asset-domain
COPY packages/contracts /app/packages/contracts
COPY tsconfig.base.json /app/tsconfig.base.json
COPY pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY apps/collaboration-api /app/apps/collaboration-api
RUN chmod +x /app/apps/collaboration-api/docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/apps/collaboration-api/docker-entrypoint.sh"]
```

- [ ] **Step 4: 写 `docker-entrypoint.sh` 与 `.dockerignore`**

创建 `apps/collaboration-api/docker-entrypoint.sh`：

```sh
#!/bin/sh
set -eu
cd /app/apps/collaboration-api
node --import=tsx src/persistence/ensure-schema.ts
exec node --use-env-proxy --import=tsx src/bootstrap.ts
```

创建仓库根 `.dockerignore`：

```
.git
.local
**/.env
**/.env.*
**/node_modules
**/dist
**/coverage
*.log
*.tsbuildinfo
```

（`**/.env*` 排除防止本机凭证进入镜像；`.env.example` 亦不进镜像，无影响。）

- [ ] **Step 5: 类型检查 + 提交**

Run: `cd apps/collaboration-api && pnpm exec tsc --noEmit`
Expected: 无输出。

```bash
chmod +x apps/collaboration-api/docker-entrypoint.sh
git add apps/collaboration-api/Dockerfile apps/collaboration-api/docker-entrypoint.sh apps/collaboration-api/src/persistence/schema.ts apps/collaboration-api/src/persistence/ensure-schema.ts apps/collaboration-api/src/persistence/initialize.ts .dockerignore
git commit -m "feat(collaboration-api): containerize collaboration api"
```

- [ ] **Step 6: 构建镜像**

Run: `docker build -f apps/collaboration-api/Dockerfile -t eadp-collaboration-api:local .`
Expected: 末尾输出 `naming to docker.io/library/eadp-collaboration-api:local`。
（若拉取 registry 失败：本机出站走代理，重试时加 `--build-arg HTTP_PROXY=http://100.70.11.40:7897 --build-arg HTTPS_PROXY=http://100.70.11.40:7897`。）

- [ ] **Step 7: 验证 ensure-schema 幂等**

```bash
docker run --rm -d --name eadp-schema-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=eadp_studio -p 55433:5432 postgres:17
# 等待数据库就绪
for i in $(seq 1 30); do docker exec eadp-schema-test pg_isready -U postgres -d eadp_studio && break; sleep 1; done
# 第一次：应建表（镜像 ENTRYPOINT 会忽略附加命令，故用 --entrypoint node 隔离运行 ensure-schema）
docker run --rm --network host --entrypoint node -e DATABASE_URL=postgresql://postgres:test@127.0.0.1:55433/eadp_studio -e PG_SSL=disable -e GITLAB_URL=http://gitlab.test -e GITLAB_ALLOW_HTTP=true eadp-collaboration-api:local --import=tsx src/persistence/ensure-schema.ts
# 第二次：应跳过
docker run --rm --network host --entrypoint node -e DATABASE_URL=postgresql://postgres:test@127.0.0.1:55433/eadp_studio -e PG_SSL=disable -e GITLAB_URL=http://gitlab.test -e GITLAB_ALLOW_HTTP=true eadp-collaboration-api:local --import=tsx src/persistence/ensure-schema.ts
# 清理
docker stop eadp-schema-test
```

Expected: 第一次输出 `Created the current collaboration schema.`；第二次输出 `Collaboration schema already present; skipping initialization.`；退出码均为 0。另验证 14 张业务表已建：`docker exec eadp-schema-test psql -U postgres -d eadp_studio -c '\dt' | grep -c '| studio_'` 输出 14。

---

### Task 5: compose 与 `start-backend.sh` 一键启动

**Files:**
- Create: `apps/collaboration-api/compose.yml`
- Create: `start-backend.sh`（仓库根，chmod +x）

**Interfaces:**
- Consumes: Task 4 的镜像构建定义。
- Produces: compose 项目 `eadp-collaboration`（服务 `db`、`api`，卷 `eadp-pgdata`）；脚本环境变量 `EADP_API_PORT`（默认 6972）、`EADP_DB_PASSWORD`（默认 `eadp-dev-password`，仅本机）；入口 `http://127.0.0.1:${EADP_API_PORT}/health`。

- [ ] **Step 1: 写 `compose.yml`**

创建 `apps/collaboration-api/compose.yml`：

```yaml
name: eadp-collaboration
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_DB: eadp_studio
      POSTGRES_USER: eadp
      POSTGRES_PASSWORD: ${EADP_DB_PASSWORD:-eadp-dev-password}
    volumes:
      - eadp-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U eadp -d eadp_studio']
      interval: 5s
      timeout: 3s
      retries: 20

  api:
    build:
      context: ../..
      dockerfile: apps/collaboration-api/Dockerfile
    environment:
      DATABASE_URL: postgresql://eadp:${EADP_DB_PASSWORD:-eadp-dev-password}@db:5432/eadp_studio
      PG_SSL: disable
      GITLAB_URL: ${GITLAB_URL:?Set GITLAB_URL in apps/collaboration-api/.env or the environment}
      GITLAB_ALLOW_HTTP: ${GITLAB_ALLOW_HTTP:-}
      SEI_GITLAB_TOKEN: ${SEI_GITLAB_TOKEN:-}
      HTTP_PROXY: ${HTTP_PROXY:-}
      HTTPS_PROXY: ${HTTPS_PROXY:-}
      NO_PROXY: ${NO_PROXY:-},db
      HOST: 0.0.0.0
      PORT: 3001
      DESKTOP_UPDATE_MIN_VERSION: ${DESKTOP_UPDATE_MIN_VERSION:-}
      DESKTOP_UPDATE_BLOCK_TITLE: ${DESKTOP_UPDATE_BLOCK_TITLE:-}
      DESKTOP_UPDATE_BLOCK_DETAIL: ${DESKTOP_UPDATE_BLOCK_DETAIL:-}
      DESKTOP_UPDATE_APP_LINK: ${DESKTOP_UPDATE_APP_LINK:-}
    ports:
      - '${EADP_API_PORT:-6972}:3001'
    depends_on:
      db:
        condition: service_healthy

volumes:
  eadp-pgdata:
```

- [ ] **Step 2: 写 `start-backend.sh`**

创建仓库根 `start-backend.sh`：

```bash
#!/usr/bin/env bash
# One-click local startup of the collaboration backend (PostgreSQL + API) via Docker Compose.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT/apps/collaboration-api/compose.yml"
ENV_FILE="$ROOT/apps/collaboration-api/.env"
API_PORT="${EADP_API_PORT:-6972}"

command -v docker >/dev/null 2>&1 || { echo "error: docker is required but not found in PATH." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "error: the Docker Compose plugin is required (docker compose)." >&2; exit 1; }

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${GITLAB_URL:?GITLAB_URL is required. Copy apps/collaboration-api/.env.example to apps/collaboration-api/.env and fill it in.}"
export GITLAB_URL

echo "Starting collaboration backend on port ${API_PORT} ..."
docker compose -f "$COMPOSE_FILE" up -d --build

HEALTH_URL="http://127.0.0.1:${API_PORT}/health"
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  healthy=0
  if command -v curl >/dev/null 2>&1 && curl -fsS --noproxy '*' "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
  else
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' eadp-collaboration-api-1 2>/dev/null || true)
    [[ "$status" == "healthy" || "$status" == "running" ]] && healthy=1
  fi
  if [[ "$healthy" == "1" ]]; then
    echo "Collaboration API is up:"
    echo "  health:  $HEALTH_URL"
    echo "  update:  http://127.0.0.1:${API_PORT}/api/v0/check_client_update"
    echo "  logs:    docker compose -f $COMPOSE_FILE logs -f api"
    echo "  stop:    docker compose -f $COMPOSE_FILE down"
    exit 0
  fi
  sleep 2
done

echo "error: the API did not become healthy in time. Recent logs:" >&2
docker compose -f "$COMPOSE_FILE" logs --tail=50 api >&2 || true
exit 1
```

- [ ] **Step 3: 提交**

```bash
chmod +x start-backend.sh
git add apps/collaboration-api/compose.yml start-backend.sh
git commit -m "feat: add one-click backend startup script"
```

- [ ] **Step 4: 一键启动冒烟（用 6973 避开本机 systemd 服务占用的 6972）**

```bash
GITLAB_URL=http://rddgit.changhong.com GITLAB_ALLOW_HTTP=true EADP_API_PORT=6973 ./start-backend.sh
```

Expected: 脚本输出 `Collaboration API is up:` 及三条提示，退出码 0。

- [ ] **Step 5: 验证升级接口两种模式**

```bash
curl --noproxy '*' -s 'http://127.0.0.1:6973/api/v0/check_client_update?scenario=launch'
DESKTOP_UPDATE_MIN_VERSION=99.0.0 EADP_API_PORT=6973 ./start-backend.sh
curl --noproxy '*' -s -H 'x-client-version: 0.2.1-alpha.2' 'http://127.0.0.1:6973/api/v0/check_client_update?scenario=periodic'
curl --noproxy '*' -s 'http://127.0.0.1:6973/api/v0/check_client_update'
```

Expected: 第一次输出 `{"code":0,"data":{"biz_code":0,"biz_data":null}}`；改配后第二次（带版本头）输出 `{"code":40005,"data":{"show_content":{}}}`；第三次（无版本头）同样 `40005`（fail-closed）。

- [ ] **Step 6: 关停并确认幂等**

```bash
docker compose -f apps/collaboration-api/compose.yml down
GITLAB_URL=http://rddgit.changhong.com GITLAB_ALLOW_HTTP=true EADP_API_PORT=6973 ./start-backend.sh
docker compose -f apps/collaboration-api/compose.yml down -v
```

Expected: 第二次启动同样成功（数据卷保留则 schema 走 `already present` 分支；`down -v` 清卷，退出码均 0）。

---

### Task 6: 文档与交接记录

**Files:**
- Modify: `apps/collaboration-api/.env.example`（追加升级接口变量）
- Modify: `apps/collaboration-api/README.md`（追加两节）
- Create: `docs/development/handoffs/desktop-update-and-containerization.md`

**Interfaces:**
- Consumes: Task 1-5 的全部产物。

- [ ] **Step 1: 更新 `.env.example`**

在 `apps/collaboration-api/.env.example` 末尾追加：

```ini
# Optional desktop mandatory-update policy. Unset MIN_VERSION to always clear clients.
# DESKTOP_UPDATE_MIN_VERSION=1.0.0
# DESKTOP_UPDATE_BLOCK_TITLE=请升级 eadp 工作台
# DESKTOP_UPDATE_BLOCK_DETAIL=当前版本已停止使用，请安装最新版本。
# DESKTOP_UPDATE_APP_LINK=https://download.example.com/eadp
```

- [ ] **Step 2: 更新 API README**

`apps/collaboration-api/README.md` 末尾追加两节（保持文件既有中英文混排风格）：

```markdown
## 桌面强制更新检查

`GET /api/v0/check_client_update?scenario=<launch|periodic|manual|...>` 服务 DSH 桌面强制更新策略客户端。无需会话；客户端版本取自 `x-client-version` header。未配置 `DESKTOP_UPDATE_MIN_VERSION` 时永远返回放行 `{"code":0,"data":{"biz_code":0,"biz_data":null}}`；配置后低于该 semver 门槛、或版本头缺失/不可解析的客户端返回强制 `{"code":40005,"data":{"show_content":{...}}}`（fail-closed）。可选文案与 `DESKTOP_UPDATE_APP_LINK`（必须 HTTPS，且其 origin 需在该桌面构建的 `allowedPageOrigins` 内，否则客户端丢弃链接）。环境变量见 `.env.example`。

## Docker 运行与一键启动

多阶段 `Dockerfile` 以仓库根为上下文构建（含 workspace 依赖、非 root 运行、入口幂等建 schema）；`compose.yml`（postgres:17 + api，默认端口 `6972:3001`）仅用于本机一键拉起，企业形态仍是独立 PostgreSQL + 本镜像。

\`\`\`sh
./start-backend.sh            # 需要 docker 与 compose 插件；读取 apps/collaboration-api/.env
EADP_API_PORT=6973 ./start-backend.sh   # 端口被占时覆盖
\`\`\`

手动构建运行：`docker build -f apps/collaboration-api/Dockerfile -t eadp-collaboration-api:local .`，容器内默认监听 3001，`DATABASE_URL`/`PG_SSL`/`GITLAB_URL` 等配置全部走环境变量。
```

- [ ] **Step 3: 写交接记录**

创建 `docs/development/handoffs/desktop-update-and-containerization.md`，内容：变更清单（默认地址、新接口、镜像、compose、脚本）、契约来源（上游 commit d743267 `mandatory-update-policy.ts` 行号）、验证证据（粘贴 Task 1/2 测试结果、镜像构建成功输出、ensure-schema 两次输出、Task 5 两种模式 curl 输出）、边界（unsigned 构建的 electron-updater feed 仍未启用；Windows 桌面原生验收不在本轮；`desktop_app_link` 需 HTTPS origin 在桌面 manifest `allowedPageOrigins` 内才生效）。

- [ ] **Step 4: 全量检查并提交**

Run: `cd apps/collaboration-api && pnpm exec tsx --test src/ && pnpm exec tsc --noEmit && cd ../.. && node scripts/check-repository.mjs`
Expected: 测试全绿、typecheck 无输出、仓库检查通过。

```bash
git add apps/collaboration-api/.env.example apps/collaboration-api/README.md docs/development/handoffs/desktop-update-and-containerization.md
git commit -m "docs: record desktop update endpoint and container deployment"
```
