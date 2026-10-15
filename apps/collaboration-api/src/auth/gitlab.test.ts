import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { DomainError } from '@eadp/asset-domain';
import { GitLab } from './gitlab.js';
import type { Actor } from './session.js';
import { loadConfig } from '../config.js';

const config = loadConfig({ DATABASE_URL: 'postgresql://synthetic', PG_SSL: 'disable', GITLAB_URL: 'http://gitlab.test', GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: 'synthetic-management-secret' });
const gitlab = new GitLab(config);
const actor: Actor = { id: 1, name: '测试管理员', username: 'studioAdmin', email: 'songlin.liu@changhong.com', admin: true, gitlabUserId: 42, gitlabUsername: 'bound-user', sessionHash: 'b'.repeat(64) };
const user = { id: 42, username: 'bound-user', state: 'active', email: 'songlin.liu@changhong.com' };
const project = { id: 7, name: '项目', path: 'project', path_with_namespace: 'team/project', http_url_to_repo: 'http://gitlab.test/team/project.git', namespace: { id: 2, full_path: 'team' }, visibility: 'private', default_branch: null, description: 'marker', permissions: { project_access: { access_level: 50 } } };
const member = (access_level = 30) => ({ id: 42, state: 'active', access_level, expires_at: null });
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers });
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
afterEach(() => mock.restoreAll());
function fixture(handle: (path: string, method: string, body: unknown) => Response | Promise<Response>) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, options: RequestInit) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, config.gitlabUrl); assert.equal(options.redirect, 'error');
    const headers = options.headers as Record<string, string>;
    assert.equal(headers['PRIVATE-TOKEN'], config.gitlabToken); assert.equal(headers.Authorization, undefined);
    assert.ok(!JSON.stringify(options).includes(actor.sessionHash));
    const path = parsed.pathname.replace(/^\/api\/v4/, '') + parsed.search, method = options.method ?? 'GET', body = options.body ? JSON.parse(String(options.body)) as unknown : undefined;
    calls.push({ path, method, body }); return handle(path, method, body);
  });
  return calls;
}

test('existing user binding resolves exactly one email or username and never creates an account', async () => {
  const calls = fixture(path => {
    if (path.startsWith('/users?search=')) return json([{ ...user, id: 80, email: 'different@example.test', name: user.email }, user]);
    if (path.startsWith('/users?username=')) return json([user]);
    throw new Error(`Unexpected path ${path}`);
  });
  assert.deepEqual(await gitlab.resolveUser(user.email), { id: 42, username: user.username, state: 'active', email: user.email });
  assert.equal((await gitlab.resolveUser(user.username)).id, 42);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.ok(calls[0]!.path.includes(encodeURIComponent(user.email)));
});

test('fuzzy-only, ambiguous and blocked user matches fail closed', async () => {
  for (const [candidates, expected] of [[[{ ...user, email: 'different@example.test', name: user.email }], 'GITLAB_BINDING_UNRESOLVED'], [[user, { ...user, id: 43 }], 'GITLAB_BINDING_UNRESOLVED'], [[{ ...user, state: 'blocked' }], 'GITLAB_USER_INACTIVE']] as Array<[unknown[], string]>) {
    mock.restoreAll(); fixture(() => json(candidates));
    await assert.rejects(gitlab.resolveUser(user.email), code(expected));
  }
});

test('management administrator project permissions cannot replace the bound user membership', async () => {
  const calls = fixture(path => path === '/users/42' ? json(user) : path === '/projects/7/members/all/42' ? json({}, 404) : json(project));
  await assert.rejects(gitlab.authorize(actor, 7), code('GITLAB_READ_DENIED'));
  await assert.rejects(gitlab.authorize(actor, 7, true), code('PROJECT_EDIT_DENIED'));
  assert.ok(calls.every(call => call.path !== '/projects/7'), 'Private project metadata is read only after membership is established');
});

test('read requires Reporter20, edit Developer30, and expired or awaiting memberships cannot be used', async () => {
  for (const membership of [member(10), { ...member(), expires_at: '2000-01-01' }, { ...member(), membership_state: 'awaiting' }, { ...member(), state: 'blocked' }]) {
    mock.restoreAll(); fixture(path => path === '/users/42' ? json(user) : path.includes('/members/') ? json(membership) : json(project));
    await assert.rejects(gitlab.authorize(actor, 7), code('GITLAB_READ_DENIED'));
  }
  mock.restoreAll(); fixture(path => path === '/users/42' ? json(user) : path.includes('/members/') ? json(member(20)) : json(project));
  assert.equal((await gitlab.authorize(actor, 7)).id, 7);
  await assert.rejects(gitlab.authorize(actor, 7, true), code('PROJECT_EDIT_DENIED'));
  mock.restoreAll(); fixture(path => path === '/users/42' ? json(user) : path.includes('/members/') ? json(member(30)) : json(project));
  assert.equal((await gitlab.authorize(actor, 7, true)).id, 7);
});

test('a blocked numeric binding, unknown membership role, or cross-origin repository response is rejected', async () => {
  const cases = [
    [() => json({ ...user, state: 'blocked' }), 'GITLAB_USER_INACTIVE'],
    [(path: string) => path === '/users/42' ? json(user) : json(member(100)), 'GITLAB_INVALID_RESPONSE'],
    [(path: string) => path === '/users/42' ? json(user) : path.includes('/members/') ? json(member()) : json({ ...project, http_url_to_repo: 'https://attacker.test/team/project.git' }), 'GITLAB_INVALID_RESPONSE'],
  ] as Array<[(path: string) => Response, string]>;
  for (const [handler, expected] of cases) { mock.restoreAll(); fixture(handler); await assert.rejects(gitlab.authorize(actor, 7), code(expected)); }
});

test('namespace choices use the bound user inherited role and group creation policy, independent of management access', async () => {
  fixture(path => {
    if (path === '/users/42') return json(user);
    if (path.startsWith('/groups?')) return json([1, 2, 3, 4, 5].map(id => ({ id })), 200, { 'x-next-page': '' });
    const membership = path.match(/^\/groups\/(\d+)\/members\/all\/42$/);
    if (membership) {
      const id = Number(membership[1]);
      return id === 4 ? json({}, 404) : json(id === 5 ? { ...member(40), expires_at: '2000-01-01' } : member(id === 2 ? 40 : 30));
    }
    const group = path.match(/^\/groups\/(\d+)$/);
    if (group) { const id = Number(group[1]); return json({ id, name: `Group ${id}`, full_path: `group-${id}`, project_creation_level: id === 1 ? 'developer' : 'maintainer' }); }
    throw new Error(`Unexpected path ${path}`);
  });
  assert.deepEqual(await gitlab.namespaces(actor), [{ id: 1, name: 'Group 1', fullPath: 'group-1' }, { id: 2, name: 'Group 2', fullPath: 'group-2' }]);
  await assert.rejects(gitlab.namespace(actor, 3), code('NAMESPACE_CREATE_DENIED'));
});

test('unknown namespace policy cannot silently grant project creation', async () => {
  fixture(path => path === '/users/42' ? json(user) : path.includes('/members/') ? json(member(50)) : json({ id: 2, name: 'Group', full_path: 'team' }));
  await assert.rejects(gitlab.namespace(actor, 2), code('NAMESPACE_POLICY_UNKNOWN'));
});

test('a full first listing page is followed even without pagination headers', async () => {
  const calls = fixture(path => {
    if (path === '/users/42') return json(user);
    if (path === '/groups?all_available=true&per_page=100&page=1') return json(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })));
    if (path === '/groups?all_available=true&per_page=100&page=2') return json([{ id: 101 }]);
    if (path === '/groups/101/members/all/42') return json(member(30));
    if (path === '/groups/101') return json({ id: 101, name: 'Last group', full_path: 'last', project_creation_level: 'developer' });
    if (path.includes('/members/all/42')) return json({}, 404);
    throw new Error(`Unexpected path ${path}`);
  });
  assert.deepEqual(await gitlab.namespaces(actor), [{ id: 101, name: 'Last group', fullPath: 'last' }]);
  assert.ok(calls.some(call => call.path.endsWith('page=2')));
});

test('creator assignment grants the existing numeric user Maintainer40 and an accepted assignment is not repeated', async () => {
  let assigned = false, writes = 0;
  fixture((path, method, body) => {
    if (path === '/users/42') return json(user);
    if (path === '/projects/7/members/all/42') return assigned ? json(member(40)) : json({}, 404);
    if (path === '/projects/7/members/42') return json({}, 404);
    if (path === '/projects/7/members' && method === 'POST') { assert.deepEqual(body, { user_id: 42, access_level: 40 }); assigned = true; writes++; return json(member(40)); }
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  await gitlab.grantCreator(actor, 7); await gitlab.grantCreator(actor, 7); assert.equal(writes, 1);
});

test('management errors, HTML responses, body size overflow and redirects never disclose credentials or response bodies', async () => {
  for (const [status, expected] of [[401, 'GITLAB_MANAGEMENT_DENIED'], [403, 'GITLAB_MANAGEMENT_DENIED'], [429, 'GITLAB_RATE_LIMITED'], [502, 'GITLAB_UNAVAILABLE']] as Array<[number, string]>) {
    mock.restoreAll(); fixture(() => new Response(`<html>private-body ${config.gitlabToken}</html>`, { status }));
    await assert.rejects(gitlab.json('/user'), error => { assert.ok(code(expected)(error)); assert.ok(!(error as Error).message.includes(config.gitlabToken!)); assert.ok(!(error as Error).message.includes('private-body')); return true; });
  }
  mock.restoreAll(); let canceled = false;
  fixture(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { canceled = true; } })));
  await assert.rejects(gitlab.bytes('/user', 8), code('GITLAB_RESOURCE_TOO_LARGE')); assert.ok(canceled);
  mock.restoreAll(); fixture(() => { throw new Error(`redirect ${config.gitlabToken}`); });
  await assert.rejects(gitlab.json('/user'), code('GITLAB_UNAVAILABLE'));
});

test('the backend management credential is required and Studio publication IDs are independent of GitLab IDs', async () => {
  const local = loadConfig({ DATABASE_URL: 'postgresql://synthetic', PG_SSL: 'disable', GITLAB_URL: 'http://gitlab.test', GITLAB_ALLOW_HTTP: 'true', STUDIO_PUBLISHER_USER_IDS: '1', GITLAB_PUBLISHER_USER_IDS: '42' });
  assert.deepEqual([...local.publisherIds], [1]);
  let requested = false; mock.method(globalThis, 'fetch', async () => { requested = true; return json({}); });
  await assert.rejects(new GitLab(local).json('/user'), code('GITLAB_NOT_CONFIGURED')); assert.equal(requested, false);
});
