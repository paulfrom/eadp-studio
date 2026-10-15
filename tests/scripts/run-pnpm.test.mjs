import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runPnpm } from '../../apps/desktop-distribution/build/run-pnpm.mjs'

test('assembly pnpm operations preserve arguments and a cwd with shell characters', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'studio 中文 & %PATH% ! (build) '))
  const originalPath = process.env.PATH
  try {
    const capture = path.join(directory, 'capture.mjs')
    writeFileSync(capture, `import { writeFileSync } from 'node:fs';
writeFileSync('captured.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), ci: process.env.CI }));
`)
    const shim = path.join(directory, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    writeFileSync(shim, process.platform === 'win32'
      ? `@"${process.execPath}" "%~dp0capture.mjs" %*\r\n`
      : `#!${process.execPath}\nimport './capture.mjs'\n`)
    if (process.platform !== 'win32') chmodSync(shim, 0o755)
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ''}`
    for (const [operation, args] of [
      ['install', ['install', '--no-frozen-lockfile']],
      ['libraries', ['exec', 'tsx', 'scripts/compile-referenced-projects.ts', 'libraries']],
      ['desktop', ['run', 'build:desktop']],
      ['pack', ['pack', '--pack-destination', '../../../../packed-studio']],
    ]) {
      runPnpm(operation, directory)
      assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'captured.json'), 'utf8')), {
        args, cwd: directory, ci: 'true',
      })
    }
    assert.throws(() => runPnpm('install & echo injected', directory), /Unknown pnpm operation/)
    assert.throws(() => runPnpm('client', directory), /Unknown pnpm operation/)
    writeFileSync(capture, 'process.exit(19)\n')
    assert.throws(() => runPnpm('install', directory), /exited with 19/)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    // Only remove the exact directory returned by mkdtemp under the OS temp root.
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    rmSync(directory, { recursive: true, force: true })
  }
})
