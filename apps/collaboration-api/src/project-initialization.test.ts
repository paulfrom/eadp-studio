import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import { DomainError } from '@eadp/asset-domain';
import type { ProjectView } from '@eadp/contracts';
import { GitLab } from './auth/gitlab.js';
import type { Actor } from './auth/session.js';
import { loadConfig } from './config.js';
import { verifyProjectInitialization } from './project-initialization.js';

const config = loadConfig({ DATABASE_URL: 'postgresql://synthetic', PG_SSL: 'disable', GITLAB_URL: 'http://gitlab.test', GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: 'synthetic-private-management-token' });
const gitlab = new GitLab(config), rootSha = 'a'.repeat(40);
const actor: Actor = { id: 1, name: '测试管理员', username: 'studioAdmin', email: 'songlin.liu@changhong.com', admin: true, gitlabUserId: 42, gitlabUsername: 'bound-user', sessionHash: 'b'.repeat(64) };
const project: ProjectView = { id: 'server-project', gitlabProjectId: 7, repositoryUrl: 'http://gitlab.test/team/project.git', stableBranch: 'main', name: '项目', namespaceId: 2, namespacePath: 'team', initializationStatus: 'pending', revision: 0, recognizedHead: null, categories: [] };
const remote = { id: 7, name: '项目', path: 'project', path_with_namespace: 'team/project', http_url_to_repo: project.repositoryUrl, namespace: { id: 2, full_path: 'team' }, visibility: 'private', default_branch: null, description: 'marker' };
const manifest = { schemaVersion: 1, projectId: project.id, gitlabProjectId: 7, repositoryUrl: project.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认场景模板', path: '.template/default.md' }] } };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const json = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => mock.restoreAll());
function fixture(options: { body?: Buffer; root?: boolean; missingDirectory?: boolean; manifestMode?: string; wrongHead?: boolean; corruptBlob?: boolean; denied?: boolean; missingTemplates?: boolean; missingTemplate?: boolean } = {}) {
  const body = options.body ?? Buffer.from(`${JSON.stringify(manifest)}\n`), blob = createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
  const calls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, request: RequestInit) => {
    assert.equal((request.headers as Record<string, string>)['PRIVATE-TOKEN'], config.gitlabToken);
    const parsed = new URL(String(url)), path = parsed.pathname.replace(/^\/api\/v4/, '') + parsed.search; calls.push(path);
    if (path === '/users/42') return json({ id: 42, username: 'bound-user', state: 'active' });
    if (path === '/projects/7/members/all/42') return options.denied ? new Response('{}', { status: 404 }) : json({ id: 42, state: 'active', access_level: 40, expires_at: null });
    if (path === '/projects/7') return json(remote);
    if (path === '/projects/7/repository/branches/main') return json({ commit: { id: options.wrongHead ? 'c'.repeat(40) : rootSha } });
    if (path === `/projects/7/repository/commits/${rootSha}`) return json({ id: rootSha, parent_ids: options.root === false ? ['d'.repeat(40)] : [] });
    if (path === `/projects/7/repository/tree?ref=${rootSha}&per_page=100&page=1`) return json([
      ...manifest.directories.filter(directory => !options.missingDirectory || directory !== '需求').map(name => ({ name, path: name, id: 'd'.repeat(40), mode: '040000', type: 'tree' })),
      ...options.missingTemplates ? [] : [{ name: '.template', path: '.template', id: 'e'.repeat(40), mode: '040000', type: 'tree' }],
      { name: 'project.assets.json', path: 'project.assets.json', id: blob, mode: options.manifestMode ?? '100644', type: 'blob' },
    ]);
    if (path === `/projects/7/repository/blobs/${blob}/raw`) return new Response(Buffer.from(options.corruptBlob ? 'different private bytes' : body));
    if (parsed.pathname.includes('/repository/files/') && decodeURIComponent(parsed.pathname).endsWith('/project.assets.json/raw')) return new Response(Buffer.from(body));
    if (parsed.pathname.includes('/repository/files/') && decodeURIComponent(parsed.pathname).endsWith('/.template/default.md/raw')) return options.missingTemplate ? new Response('{}', { status: 404 }) : new Response('# 默认模板\n\n## 业务范围\n');
    throw new Error(`Unexpected path ${path}`);
  });
  return calls;
}

test('initialization verifies the exact pushed root commit, regular manifest blob bytes and all versioned business directories', async () => {
  const calls = fixture(); await verifyProjectInitialization(gitlab, actor, project, rootSha);
  assert.equal(calls.filter(path => path === '/projects/7/repository/branches/main').length, 2);
  assert.ok(calls.some(path => path.endsWith('/raw')));
});

test('a different stable head or a non-root commit cannot initialize the project', async () => {
  fixture({ wrongHead: true }); await assert.rejects(verifyProjectInitialization(gitlab, actor, project, rootSha), code('INITIALIZATION_HEAD_MISMATCH'));
  mock.restoreAll(); fixture({ root: false }); await assert.rejects(verifyProjectInitialization(gitlab, actor, project, rootSha), code('INITIALIZATION_ROOT_COMMIT_REQUIRED'));
});

test('a missing directory, symlink manifest or substituted blob bytes block initialization', async () => {
  for (const [options, expected] of [[{ missingDirectory: true }, 'INITIALIZATION_DIRECTORIES_REQUIRED'], [{ manifestMode: '120000' }, 'INITIALIZATION_MANIFEST_REQUIRED'], [{ corruptBlob: true }, 'INITIALIZATION_MANIFEST_MISMATCH']] as Array<[Parameters<typeof fixture>[0], string]>) {
    mock.restoreAll(); fixture(options); await assert.rejects(verifyProjectInitialization(gitlab, actor, project, rootSha), code(expected));
  }
});

test('manifest identity, encoding, line endings and directory contract are validated against exact raw bytes', async () => {
  const samples: Array<[Buffer, string]> = [
    [Buffer.from(JSON.stringify({ ...manifest, projectId: 'forged' })), 'INITIALIZATION_MANIFEST_MISMATCH'],
    [Buffer.from(JSON.stringify({ ...manifest, repositoryUrl: 'https://attacker.test/repo.git' })), 'INITIALIZATION_MANIFEST_MISMATCH'],
    [Buffer.from(JSON.stringify({ ...manifest, directories: ['场景', '需求'] })), 'INITIALIZATION_MANIFEST_INVALID'],
    // The three-directory layout stays readable for accepted projects, but a new initialization must still declare all four.
    [Buffer.from(JSON.stringify({ ...manifest, directories: ['场景', '需求', '原型代码'] })), 'INITIALIZATION_MANIFEST_MISMATCH'],
    [Buffer.from('\ufeff{}'), 'INVALID_MANIFEST_ENCODING'],
    [Buffer.from('{}\r\n'), 'INVALID_MANIFEST_ENCODING'],
    [Buffer.from([0xff]), 'INITIALIZATION_MANIFEST_INVALID'],
  ];
  for (const [body, expected] of samples) { mock.restoreAll(); fixture({ body }); await assert.rejects(verifyProjectInitialization(gitlab, actor, project, rootSha), code(expected)); }
});

test('no initialization body is read when the bound user lacks repository authorization', async () => {
  const calls = fixture({ denied: true });
  await assert.rejects(verifyProjectInitialization(gitlab, actor, project, rootSha), code('PROJECT_EDIT_DENIED'));
  assert.ok(calls.every(path => !path.includes('/repository/')));
});

test('initialization requires a versioned template directory and readable default template bytes', async () => {
  fixture({ missingTemplates: true });
  await assert.rejects(verifyProjectInitialization(gitlab, actor, project, rootSha), code('INITIALIZATION_TEMPLATES_REQUIRED'));
  mock.restoreAll(); fixture({ missingTemplate: true });
  await assert.rejects(verifyProjectInitialization(gitlab, actor, project, rootSha), code('FIXED_FILE_MISSING'));
});

test('a new initialization must declare the scenario template catalog even when .template exists', async () => {
  const { scenarioTemplates: _catalog, ...withoutCatalog } = manifest;
  fixture({ body: Buffer.from(`${JSON.stringify(withoutCatalog)}\n`) });
  await assert.rejects(verifyProjectInitialization(gitlab, actor, project, rootSha), code('INITIALIZATION_TEMPLATES_REQUIRED'));
});
