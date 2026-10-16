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
const manager = { id: 90, username: 'management-user', state: 'active', email: 'manager@example.test' };
const project = { id: 7, name: '项目', path: 'project', path_with_namespace: 'team/project', http_url_to_repo: 'http://gitlab.test/team/project.git', namespace: { id: 2, full_path: 'team' }, visibility: 'private', default_branch: null, description: 'marker', permissions: { project_access: { access_level: 50 } } };
const member = (access_level = 30) => ({ id: 42, state: 'active', access_level, expires_at: null });
const namespaceGroup = (id: number, project_creation_level = 'maintainer') => ({ id, name: `Group ${id}`, full_path: `group-${id}`, project_creation_level });
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
    if (path === '/user') return json(manager);
    if (path.startsWith('/users?search=')) return json([{ ...user, id: 80, email: 'different@example.test', name: user.email }, user]);
    if (path.startsWith('/users?username=')) return json([user]);
    throw new Error(`Unexpected path ${path}`);
  });
  assert.deepEqual(await gitlab.resolveUser(user.email), { id: 42, username: user.username, state: 'active', email: user.email });
  assert.equal((await gitlab.resolveUser(user.username)).id, 42);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.ok(calls.some(call => call.path.includes(encodeURIComponent(user.email))));
});

test('the authenticated token identity resolves exact email, username or public email without directory visibility', async () => {
  const calls = fixture(path => {
    assert.equal(path, '/user', 'An exact authenticated identity must not depend on directory email visibility');
    return json({ ...user, public_email: 'public@example.test' });
  });
  for (const lookup of [user.email, user.username, 'public@example.test']) {
    assert.deepEqual(await gitlab.resolveUser(lookup), user);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('a similar token username never proves an email binding and inactive token identities cannot bind', async () => {
  const calls = fixture(path => path === '/user' ? json({ ...user, username: 'songlin.liu', email: 'different@example.test' }) : json([]));
  await assert.rejects(gitlab.resolveUser(user.email), code('GITLAB_BINDING_UNRESOLVED'));
  assert.ok(calls.some(call => call.path.startsWith('/users?search=')));
  for (const invalid of [{ ...user, state: 'blocked' }, { ...user, locked: true }, { ...user, bot: true }]) {
    mock.restoreAll();
    const deniedCalls = fixture(() => json(invalid));
    await assert.rejects(gitlab.resolveUser(user.email), code('GITLAB_USER_INACTIVE'));
    assert.deepEqual(deniedCalls.map(call => call.path), ['/user']);
  }
});

test('an unavailable authenticated identity cannot be replaced by a directory result', async () => {
  const calls = fixture(path => path === '/user' ? json({}, 403) : json([user]));
  await assert.rejects(gitlab.resolveUser(user.email), code('GITLAB_RESOURCE_DENIED'));
  assert.deepEqual(calls.map(call => call.path), ['/user']);
});

test('fuzzy-only, ambiguous and blocked user matches fail closed', async () => {
  for (const [candidates, expected] of [[[{ ...user, email: 'different@example.test', name: user.email }], 'GITLAB_BINDING_UNRESOLVED'], [[user, { ...user, id: 43 }], 'GITLAB_BINDING_UNRESOLVED'], [[{ ...user, state: 'blocked' }], 'GITLAB_USER_INACTIVE']] as Array<[unknown[], string]>) {
    mock.restoreAll(); fixture(path => path === '/user' ? json(manager) : json(candidates));
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
    if (path.startsWith('/groups?')) return json([1, 2, 3, 4, 5].map(id => namespaceGroup(id, id === 1 ? 'developer' : 'maintainer')), 200, { 'x-next-page': '' });
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

test('a forbidden group membership is excluded without hiding other authorized namespaces or permitting creation', async () => {
  const calls = fixture(path => {
    if (path === '/users/42') return json(user);
    if (path.startsWith('/groups?')) return json([namespaceGroup(1), { ...namespaceGroup(2), name: 'Allowed', full_path: 'allowed' }]);
    if (path === '/groups/1/members/all/42') return json({ message: '403 Forbidden' }, 403);
    if (path === '/groups/2/members/all/42') return json(member(40));
    if (path === '/groups/2') return json({ id: 2, name: 'Allowed', full_path: 'allowed', project_creation_level: 'maintainer' });
    throw new Error(`Unexpected path ${path}`);
  });
  assert.deepEqual(await gitlab.namespaces(actor), [{ id: 2, name: 'Allowed', fullPath: 'allowed' }]);
  await assert.rejects(gitlab.namespace(actor, 1), error => code('NAMESPACE_CREATE_DENIED')(error) && (error as DomainError).status === 403);
  assert.ok(calls.every(call => call.method === 'GET' && call.path !== '/groups/1'));
});

test('group membership credential failure, throttling and outages still stop namespace discovery', async () => {
  for (const [status, expected] of [[401, 'GITLAB_MANAGEMENT_DENIED'], [429, 'GITLAB_RATE_LIMITED'], [503, 'GITLAB_UNAVAILABLE']] as Array<[number, string]>) {
    mock.restoreAll();
    fixture(path => path === '/users/42' ? json(user) : path.startsWith('/groups?') ? json([namespaceGroup(1), namespaceGroup(2)]) : path === '/groups/1/members/all/42' ? json(member(40)) : json({}, status));
    await assert.rejects(gitlab.namespaces(actor), code(expected));
  }
});

test('namespace discovery checks at most eight memberships concurrently without group detail reads and preserves list order', async () => {
  let active = 0, maximum = 0;
  const completed: number[] = [];
  fixture(async path => {
    if (path === '/users/42') return json(user);
    if (path.startsWith('/groups?')) return json(Array.from({ length: 16 }, (_, index) => namespaceGroup(index + 1)));
    const membership = path.match(/^\/groups\/(\d+)\/members\/all\/42$/);
    if (membership) {
      const id = Number(membership[1]); active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, id === 1 ? 40 : 1));
      active--; completed.push(id);
      return id === 2 ? json({}, 404) : json(member(40));
    }
    throw new Error(`Unexpected path ${path}`);
  });
  const result = await gitlab.namespaces(actor);
  assert.equal(maximum, 8);
  assert.notEqual(completed[0], 1, 'Responses intentionally complete out of list order');
  assert.deepEqual(result.map(namespace => namespace.id), [1, ...Array.from({ length: 14 }, (_, index) => index + 3)]);
});

test('all group IDs are validated before any membership requests start', async () => {
  for (const groups of [[{ id: 1 }, { id: 1 }], [{ id: 1 }, { id: '2' }], [{ id: 1 }, { id: -2 }]]) {
    mock.restoreAll();
    const calls = fixture(path => path === '/users/42' ? json(user) : path.startsWith('/groups?') ? json(groups) : json(member(40)));
    await assert.rejects(gitlab.namespaces(actor), code('GITLAB_INVALID_RESPONSE'));
    assert.ok(calls.every(call => !call.path.includes('/members/')));
  }
});

test('namespace listing requires complete known policy fields and never fetches a replacement group detail', async () => {
  const { project_creation_level: _policy, ...missingPolicy } = namespaceGroup(2);
  for (const [group, expected] of [[missingPolicy, 'NAMESPACE_POLICY_UNKNOWN'], [namespaceGroup(2, 'unknown'), 'NAMESPACE_POLICY_UNKNOWN'], [{ ...namespaceGroup(2), name: undefined }, 'GITLAB_INVALID_RESPONSE']] as Array<[unknown, string]>) {
    mock.restoreAll();
    const calls = fixture(path => path === '/users/42' ? json(user) : path.startsWith('/groups?') ? json([namespaceGroup(1), group]) : path.includes('/members/') ? json(member(40)) : json(namespaceGroup(2)));
    await assert.rejects(gitlab.namespaces(actor), code(expected));
    assert.ok(calls.every(call => !/^\/groups\/\d+$/.test(call.path)));
  }
  mock.restoreAll();
  fixture(path => path === '/users/42' ? json(user) : path.startsWith('/groups?') ? json([namespaceGroup(1, 'noone'), { ...namespaceGroup(2), marked_for_deletion_on: '2026-10-15' }, namespaceGroup(3)]) : json(member(40)));
  assert.deepEqual((await gitlab.namespaces(actor)).map(namespace => namespace.id), [3]);
});

test('specific namespace authorization rechecks current membership and group policy after discovery', async () => {
  let accessLevel = 30, policy = 'developer', members = 0, details = 0;
  fixture(path => {
    if (path === '/users/42') return json(user);
    if (path.startsWith('/groups?')) return json([namespaceGroup(1, 'developer')]);
    if (path === '/groups/1/members/all/42') { members++; return json(member(accessLevel)); }
    if (path === '/groups/1') { details++; return json(namespaceGroup(1, policy)); }
    throw new Error(`Unexpected path ${path}`);
  });
  assert.deepEqual((await gitlab.namespaces(actor)).map(namespace => namespace.id), [1]);
  assert.equal(details, 0);
  policy = 'maintainer';
  await assert.rejects(gitlab.namespace(actor, 1), code('NAMESPACE_CREATE_DENIED'));
  assert.equal(details, 1); assert.equal(members, 2);
  policy = 'developer'; accessLevel = 20;
  await assert.rejects(gitlab.namespace(actor, 1), code('NAMESPACE_CREATE_DENIED'));
  assert.equal(details, 1); assert.equal(members, 3);
});

test('forbidden group listings, group policies and project memberships are never treated as usable authority', async () => {
  fixture(path => path === '/users/42' ? json(user) : json({}, 403));
  await assert.rejects(gitlab.namespaces(actor), code('GITLAB_RESOURCE_DENIED'));
  await assert.rejects(gitlab.authorize(actor, 7), code('GITLAB_RESOURCE_DENIED'));
  mock.restoreAll();
  fixture(path => path === '/users/42' ? json(user) : path.includes('/members/') ? json(member(40)) : json({}, 403));
  await assert.rejects(gitlab.namespace(actor, 1), code('GITLAB_RESOURCE_DENIED'));
});

test('a full first listing page is followed even without pagination headers', async () => {
  const calls = fixture(path => {
    if (path === '/users/42') return json(user);
    if (path === '/groups?all_available=true&per_page=100&page=1') return json(Array.from({ length: 100 }, (_, i) => namespaceGroup(i + 1)));
    if (path === '/groups?all_available=true&per_page=100&page=2') return json([{ ...namespaceGroup(101, 'developer'), name: 'Last group', full_path: 'last' }]);
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
  for (const [status, expected] of [[401, 'GITLAB_MANAGEMENT_DENIED'], [403, 'GITLAB_RESOURCE_DENIED'], [429, 'GITLAB_RATE_LIMITED'], [502, 'GITLAB_UNAVAILABLE']] as Array<[number, string]>) {
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
