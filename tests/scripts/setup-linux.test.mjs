import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Command stubs exercise orchestration only, including on Git Bash. They do not
// validate a native Linux dependency install, network access or DSH extraction.
const source = fileURLToPath(new URL('../../scripts/setup-linux.sh', import.meta.url));
const preflightCode = readFileSync(source, 'utf8').match(/node --input-type=module -e '\n([\s\S]*?)\n' /)?.[1];
assert.ok(preflightCode, 'The version preflight must be available for real Node validation');
const bash = process.env.BASH_EXECUTABLE ?? '/bin/bash';
const inheritedEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => name.toLowerCase() !== 'path'));
const shellPath = (value) => process.platform === 'win32'
  ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
  : value;

function run(args = [], settings = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'Linux setup '));
  try {
    const repo = path.join(temporary, 'repo with spaces');
    const bin = path.join(temporary, 'bin');
    const elsewhere = path.join(temporary, 'other cwd');
    const log = path.join(temporary, 'calls.log');
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    mkdirSync(bin);
    mkdirSync(elsewhere);
    copyFileSync(source, path.join(repo, 'scripts/setup-linux.sh'));
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      engines: { node: '>=22', pnpm: '11.x' },
    }));
    // Execute the actual inline preflight with Node directly. The Bash stub
    // forwards its outcome, avoiding MSYS/native Windows stdio interactions.
    const preflight = spawnSync(process.execPath,
      ['--input-type=module', '-e',
        `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(settings.node ?? process.versions.node)} });\n${preflightCode}`,
        path.join(repo, 'package.json')],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (preflight.error) throw preflight.error;
    const stubs = new Map();
    const stub = (name, body) => stubs.set(name, `${name}() {\n${body}\n}\n`);
    stub('dirname', 'value="${@: -1}"; printf "%s\\n" "${value%/*}"');
    stub('uname', 'printf "%s\\n" "$TEST_SYSTEM"');
    for (const tool of ['bash', 'git', 'tar']) stub(tool, 'return 0');
    stub('node', `if [[ "$1" == --input-type=module ]]; then
  printf '%s' "$PREFLIGHT_OUTPUT"
  printf '%s' "$PREFLIGHT_ERROR" >&2
  return "$PREFLIGHT_STATUS"
fi
printf 'node|%s|%s\\n' "$PWD" "$*" >> "$CALL_LOG"
if [[ "$1" == scripts/check-repository.mjs ]]; then return "$CHECK_STATUS"; fi
return "$FETCH_STATUS"`);
    stub('pnpm', `if [[ "$1" == --version ]]; then printf '%s\\n' "$PNPM_VERSION"; return 0; fi
printf 'pnpm|%s|%s\\n' "$PWD" "$*" >> "$CALL_LOG"
return "$INSTALL_STATUS"`);
    if (settings.missingTool) stubs.delete(settings.missingTool);
    const stubFile = path.join(bin, 'commands.sh');
    writeFileSync(stubFile, [...stubs.values()].join('\n'));
    // Git Bash initializes PATH on startup. Set the isolated command directory
    // after startup as well, before launching the script under test.
    const result = spawnSync(bash, ['-c', 'export PATH="$1"; shift; source "$1"; shift; script="$1"; shift; source "$script" "$@"',
      'setup-test', shellPath(bin), shellPath(stubFile), shellPath(path.join(repo, 'scripts/setup-linux.sh')), ...args], {
      cwd: elsewhere,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...inheritedEnv,
        // Isolate every command from tools installed on the test host.
        PATH: shellPath(bin),
        PREFLIGHT_OUTPUT: preflight.stdout,
        PREFLIGHT_ERROR: preflight.stderr,
        PREFLIGHT_STATUS: String(preflight.status),
        CALL_LOG: shellPath(log),
        TEST_SYSTEM: settings.system ?? 'Linux',
        PNPM_VERSION: settings.pnpm ?? '11.28.5',
        CHECK_STATUS: String(settings.checkStatus ?? 0),
        INSTALL_STATUS: String(settings.installStatus ?? 0),
        FETCH_STATUS: String(settings.fetchStatus ?? 0),
      },
    });
    if (result.error) throw new Error(`${result.error.message}\n${result.stderr}`, { cause: result.error });
    let calls = [];
    try { calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { ...result, calls, repo: shellPath(repo) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('help and invalid arguments perform no preparation', () => {
  const help = run(['--help'], { system: 'MINGW64_NT' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  assert.deepEqual(help.calls, []);
  for (const args of [['--unknown'], ['--archive-only', '--unknown']]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(result.calls, []);
  }
});

test('non-Linux and missing commands stop before preparation', () => {
  const nonLinux = run([], { system: 'MINGW64_NT' });
  assert.equal(nonLinux.status, 1);
  assert.match(nonLinux.stderr, /requires Linux/);
  assert.deepEqual(nonLinux.calls, []);
  const missing = run([], { missingTool: 'pnpm' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Required tool is missing.*pnpm/);
  assert.deepEqual(missing.calls, []);
});

test('unsupported Node and pnpm majors stop before preparation', () => {
  const node = run([], { node: '21.99.0' });
  assert.equal(node.status, 1);
  assert.match(node.stderr, /Node >=22 required; actual 21\.99\.0/);
  assert.deepEqual(node.calls, []);
  for (const version of ['10.30.0', '12.0.0']) {
    const pnpm = run([], { pnpm: version });
    assert.equal(pnpm.status, 1);
    assert.match(pnpm.stderr, /pnpm 11\.x required; actual/);
    assert.deepEqual(pnpm.calls, []);
  }
});

test('Node 22 and newer and pnpm 11 minor versions pass preflight', () => {
  for (const [node, pnpm] of [
    ['22.0.0', '11.0.0'],
    ['22.22.3', '11.5.1'],
    ['24.0.0', '11.28.5'],
  ]) {
    const result = run([], { node, pnpm });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 3);
  }
});

test('success uses the script root across spaces and a different cwd', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    `node|${result.repo}|scripts/check-repository.mjs`,
    `pnpm|${result.repo}|install --frozen-lockfile --ignore-scripts`,
    `node|${result.repo}|scripts/fetch-dsh.mjs`,
  ]);
});

test('archive-only is forwarded only to source fetching', () => {
  const result = run(['--archive-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 3);
  assert.equal(result.calls[2], `node|${result.repo}|scripts/fetch-dsh.mjs --archive-only`);
});

for (const [stage, settings, count, status] of [
  ['repository check', { checkStatus: 7 }, 1, 7],
  ['frozen install', { installStatus: 8 }, 2, 8],
  ['source fetch', { fetchStatus: 9 }, 3, 9],
]) {
  test(`${stage} failure stops immediately and preserves its status`, () => {
    const result = run([], settings);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.calls.length, count);
  });
}
