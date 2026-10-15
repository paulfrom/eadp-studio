import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PrototypeResourceFencePlugin } from '../../packages/studio-plugin/assets/prototype-template/config/resource-fence.js';

function hook() {
  let callback;
  return { tap(_name, value) { callback = value; }, call(value) { return callback(value); } };
}
function pluginHooks(rules = []) {
  const compiler = { options: { module: { rules } }, hooks: { normalModuleFactory: hook(), contextModuleFactory: hook() } };
  new PrototypeResourceFencePlugin().apply(compiler);
  const normal = { hooks: { beforeResolve: hook(), afterResolve: hook() } };
  const context = { hooks: { afterResolve: hook() } };
  compiler.hooks.normalModuleFactory.call(normal);
  compiler.hooks.contextModuleFactory.call(context);
  return [(request, extra = {}) => normal.hooks.beforeResolve.call({ request, ...extra }), resource => normal.hooks.afterResolve.call({ createData: { resource } }), resource => context.hooks.afterResolve.call({ resource })];
}

test('actual Webpack hooks allow native drive paths and still enforce resolved source boundaries', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eadp-fence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  await mkdir(project);
  const inside = path.join(project, 'page.tsx');
  const outside = path.join(directory, 'outside.tsx');
  await writeFile(inside, 'export default () => null;');
  await writeFile(outside, 'export default () => null;');
  const previous = process.cwd();
  let hooks;
  try { process.chdir(project); hooks = pluginHooks(); } finally { process.chdir(previous); }
  for (const invoke of hooks) {
    assert.doesNotThrow(() => invoke(inside));
    assert.doesNotThrow(() => invoke(inside.replaceAll('\\', '/')));
    assert.throws(() => invoke(outside), /source boundary/);
  }
});

test('actual hooks distinguish UNC paths and check their resolved project boundary', { skip: process.platform !== 'win32' }, () => {
  // Replace only OS realpath lookup: this fixture never connects to a network share.
  const original = realpathSync.native;
  const root = '\\\\eadp-fixture\\share\\project';
  const inside = `${root}\\src\\page.tsx`;
  const outside = '\\\\eadp-fixture\\other\\page.tsx';
  const lookups = [];
  realpathSync.native = value => {
    lookups.push(value);
    return value === process.cwd() ? root : value;
  };
  try {
    for (const invoke of pluginHooks()) {
      assert.doesNotThrow(() => invoke(inside));
      assert.throws(() => invoke(outside), /source boundary/);
    }
    assert.ok(lookups.includes(inside));
    assert.ok(lookups.includes(outside));
  } finally { realpathSync.native = original; }
});

test('every resource hook continues rejecting executable and network URI schemes', () => {
  for (const invoke of pluginHooks()) {
    for (const value of ['node:fs', 'file:///C:/outside.tsx', 'http://example.test/file.js', 'https://example.test/file.js', 'data:text/javascript,alert(1)', 'C:relative.tsx']) {
      assert.throws(() => invoke(value), /scheme is not allowed/, value);
    }
  }
});

test('internal loaderImport cannot select task loaders or spoof an ordinary source import', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eadp-internal-loader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const page = path.join(directory, 'page.less');
  const trusted = path.join(directory, 'configured-loader.cjs');
  const untrusted = path.join(directory, 'task-loader.cjs');
  await Promise.all([writeFile(page, '.page {}'), writeFile(trusted, 'module.exports = source => source;'), writeFile(untrusted, 'throw new Error("must never execute");')]);
  const previous = process.cwd();
  let beforeResolve;
  try { process.chdir(directory); [beforeResolve] = pluginHooks([{ oneOf: [{ use: [{ loader: trusted }] }] }]); } finally { process.chdir(previous); }
  const request = loader => page + '.webpack[javascript/auto]!=!!!' + loader + '??ruleSet[1].rules[0].oneOf[0].use[0]!' + page;
  const internal = { dependencyType: 'loaderImport', contextInfo: { issuer: page } };
  assert.doesNotThrow(() => beforeResolve(request(trusted), internal));
  assert.throws(() => beforeResolve(request(untrusted), internal), /inline loader/);
  assert.throws(() => beforeResolve(request(trusted), { ...internal, dependencyType: 'esm' }), /inline loader/);
  assert.throws(() => beforeResolve(request(trusted), { ...internal, contextInfo: { issuer: path.join(directory, 'other.less') } }), /inline loader/);
});
