import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

test('ordinary Node imports the real Desktop HostProcess and Electron helpers without loading Electron APIs', async () => {
  const repo = path.resolve(import.meta.dirname, '../..')
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' })
  assert.equal(common.status, 0)
  const prepared = path.join(path.dirname(common.stdout.trim()), '.local/build/dsh')
  const fixture = await mkdtemp(path.join(prepared, 'apps/desktop/.studio-node-import-'))
  try {
    for (const filename of ['host-process.ts', 'node-environment.ts']) await cp(path.join(prepared, 'apps/desktop/src', filename), path.join(fixture, filename))
    for (const filename of ['studio-browser-check.ts', 'studio-secret-store.ts', 'studio-prototype-bridge.ts', 'studio-prototype-view.ts']) await cp(path.join(repo, 'apps/desktop-distribution/build', filename), path.join(fixture, filename))
    const script = `
      import assert from 'node:assert/strict';
      assert.equal(process.versions.electron, undefined);
      const host = await import(${JSON.stringify(pathToFileURL(path.join(fixture, 'host-process.ts')).href)});
      const preview = await import(${JSON.stringify(pathToFileURL(path.join(fixture, 'studio-browser-check.ts')).href)});
      const secrets = await import(${JSON.stringify(pathToFileURL(path.join(fixture, 'studio-secret-store.ts')).href)});
      assert.equal(typeof host.DesktopHostProcess, 'function');
      const responses = [];
      const child = { connected: true, send(value, callback) { responses.push(value); callback(); } };
      await preview.handleStudioPreviewCheck(child, { type: 'studio-preview-check', requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', url: 'http://127.0.0.1:32123/' });
      await secrets.handleStudioSecretRequest(child, { type: 'studio-secret-request', requestId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', action: 'read', key: 'collaboration-session' });
      assert.equal(responses.length, 2);
      assert.deepEqual(responses.map(value => value.ok), [false, false]);
      console.log('ordinary-node-host-import-and-handler-rejection: passed');
    `
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: prepared, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /ordinary-node-host-import-and-handler-rejection: passed/)
  } finally { await rm(fixture, { recursive: true, force: true }) }
})
