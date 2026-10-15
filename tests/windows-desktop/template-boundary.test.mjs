import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createStudioToolGuard } from '../../packages/studio-plugin/src/host/adapters/platform/execution-guard.ts';
import { copyTemplate, verifyPrototypeContract, verifyTemplate } from '../../packages/studio-plugin/src/host/prototype/template.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const template = path.join(root, 'packages/studio-plugin/assets/prototype-template');
const manifestPath = `${template}.manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eadp-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'prototype');
  await copyTemplate({ templateRoot: template, manifestPath, destinationRoot: project });
  return { directory, project };
}
async function loader(project) {
  return import(pathToFileURL(path.join(project, 'config/load-routes.ts')).href);
}
async function putRoutes(project, routes) {
  await writeFile(path.join(project, 'config/routes.json'), JSON.stringify(routes));
}

test('Agent can edit route data, but cannot restore executable route configuration', async t => {
  const { project } = await fixture(t);
  const guard = createStudioToolGuard(() => ({
    readRoot: project,
    writablePaths: manifest.contract.writablePrefixes.filter(p => !p.endsWith('/')),
    writablePrefixes: manifest.contract.writablePrefixes.filter(p => p.endsWith('/')).map(p => p.slice(0, -1)),
    protectedPaths: manifest.contract.protectedPaths,
  }));
  const write = file_path => guard({ name: 'write', arguments: { file_path }, agent: { session: { header: { cwd: project } } } });
  assert.ok(write('config/router.config.ts'));
  assert.equal(write('config/routes.json'), undefined);
  assert.ok(write('config/load-routes.ts'));
});

test('route payloads are parsed as JSON and never executed in the configuration process', async t => {
  const { directory, project } = await fixture(t);
  const marker = path.join(directory, 'outside-marker');
  const { loadPrototypeRoutes } = await loader(project);
  await writeFile(path.join(project, 'config/routes.json'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'escaped'); export default [];`);
  assert.throws(() => loadPrototypeRoutes(project), /JSON/);
  await assert.rejects(access(marker));
  // A stale executable file is never imported by the maintained configuration.
  await writeFile(path.join(project, 'config/router.config.ts'), `throw new Error('stale executable loaded');`);
  await putRoutes(project, [{ path: '/demo', component: './Demo' }]);
  assert.equal(loadPrototypeRoutes(project)[0].component, './Demo');
  await putRoutes(project, [{ path: '/demo', component: './Demo', title: `writeFileSync(${JSON.stringify(marker)}, 'escaped')` }]);
  assert.match(loadPrototypeRoutes(project)[0].title, /writeFileSync/);
  await assert.rejects(access(marker));
  const config = await readFile(path.join(project, 'config/config.ts'), 'utf8');
  assert.doesNotMatch(config, /router\.config/);
  assert.match(config, /loadPrototypeRoutes/);
});

test('route schema rejects execution hooks, URI/path escapes and malformed nested values', async t => {
  const { project } = await fixture(t);
  const { loadPrototypeRoutes } = await loader(project);
  const cases = [
    {}, [], [null], [{ path: '/demo', component: './Demo', wrappers: ['node:fs'] }],
    [{ path: '/demo', component: 'node:fs' }], [{ path: '/demo', component: '../outside' }],
    [{ path: '/demo', component: '@/layouts/BlankLayout' }], [{ path: '/demo', component: './Demo!loader' }],
    [{ path: '/demo', component: './Missing' }], [{ path: '/demo', component: './Demo', routes: {} }],
    [{ path: '//host', component: './Demo' }], [{ path: '/../outside', component: './Demo' }],
    [{ path: '/%2e%2e/outside', component: './Demo' }], [{ path: '/demo', redirect: 'https://example.test' }],
    [{ path: '/demo', redirect: '/safe', component: './Demo' }], [{ path: '/demo', title: 4, component: './Demo' }],
    [{ path: '/demo', component: './Demo' }, { path: '/demo', component: './Demo' }],
    JSON.parse('[{"path":"/demo","component":"./Demo","__proto__":{}}]'),
  ];
  for (const routes of cases) {
    await putRoutes(project, routes);
    assert.throws(() => loadPrototypeRoutes(project), undefined, JSON.stringify(routes));
  }
});

test('route component real paths cannot escape pages through a directory link', async t => {
  const { directory, project } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'index.tsx'), 'export default () => null;');
  await symlink(outside, path.join(project, 'src/pages/Outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await putRoutes(project, [{ path: '/outside', component: './Outside' }]);
  const { loadPrototypeRoutes } = await loader(project);
  assert.throws(() => loadPrototypeRoutes(project), /boundary|link/);
});

test('legitimate nested routes preserve Umi routing and the bundled manifest verifies', async t => {
  const { project } = await fixture(t);
  const routes = [{ path: '/', redirect: '/demo' }, { path: '/demo', component: './Demo', title: '合成演示', routes: [{ path: '/demo/:id', component: './Demo' }] }, { path: '*', component: './404' }];
  await putRoutes(project, routes);
  const { loadPrototypeRoutes } = await loader(project);
  assert.deepEqual(loadPrototypeRoutes(project), routes);
  await verifyPrototypeContract(project, manifestPath);
  await verifyTemplate(template, manifestPath);
});
