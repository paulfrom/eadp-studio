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
function pluginHooks() {
  const compiler = { hooks: { normalModuleFactory: hook(), contextModuleFactory: hook() } };
  new PrototypeResourceFencePlugin().apply(compiler);
  const normal = { hooks: { beforeResolve: hook(), afterResolve: hook() } };
  const context = { hooks: { afterResolve: hook() } };
  compiler.hooks.normalModuleFactory.call(normal);
  compiler.hooks.contextModuleFactory.call(context);
  return [request => normal.hooks.beforeResolve.call({ request }), resource => normal.hooks.afterResolve.call({ createData: { resource } }), resource => context.hooks.afterResolve.call({ resource })];
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
