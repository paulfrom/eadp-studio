import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const commit = 'a'.repeat(40);
const root = `deepseek-harness-${commit}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A POSIX tar fixture preserves the missing directory/file distinction in its
// symlink headers, as in the real GitHub source archive.
function archiveEntry(name, type, content = '') {
  const header = Buffer.alloc(512);
  const data = type === '0' ? Buffer.from(content) : Buffer.alloc(0);
  header.write(`${root}/${name}`, 0, 100);
  header.write('0000755\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  header.write('00000000000\0', 136, 12);
  header.fill(32, 148, 156);
  header.write(type, 156, 1);
  if (type === '2') header.write(content, 157, 100);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}

async function fixture(t, directoryTarget = '../.agents/skills') {
  const temporaryRoot = await realpath(tmpdir());
  const repo = await mkdtemp(path.join(temporaryRoot, 'dsh-source-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(repo)), temporaryRoot);
    assert.ok(path.basename(repo).startsWith('dsh-source-test-'));
    assert.equal(await realpath(repo), repo);
    await rm(repo, { recursive: true, force: true });
  });
  await mkdir(path.join(repo, 'scripts'), { recursive: true });
  await mkdir(path.join(repo, 'apps/desktop-distribution'), { recursive: true });
  await mkdir(path.join(repo, '.local/upstream'), { recursive: true });
  await copyFile(new URL('../../scripts/fetch-dsh.mjs', import.meta.url), path.join(repo, 'scripts/fetch-dsh.mjs'));
  const pkg = JSON.stringify({ name: '@test/dsh', version: '1.0.0' });
  const members = [
    ['', '5'], ['package.json', '0', pkg], ['AGENTS.md', '0', 'rules'],
    ['.agents/', '5'], ['.agents/skills/', '5'], ['.agents/skills/SKILL.md', '0', 'skill'],
    ['.claude/', '5'], ['.claude/skills', '2', directoryTarget], ['CLAUDE.md', '2', 'AGENTS.md'],
    ['说明.txt', '0', '中文 source filename'],
  ];
  const archive = gzipSync(Buffer.concat([...members.map((args) => archiveEntry(...args)), Buffer.alloc(1024)]));
  await writeFile(path.join(repo, `.local/upstream/dsh-${commit}.tar.gz`), archive);
  await writeFile(path.join(repo, 'apps/desktop-distribution/release.lock.json'), JSON.stringify({ dsh: {
    repository: 'https://github.com/deepseek-ai/deepseek-harness', commit, sourceDirectory: '.local/upstream/dsh',
    archive: { url: `https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/${commit}`,
      sha256: hash(archive), bytes: archive.length, rootDirectory: root, entryCount: members.length, symlinkCount: 2 },
    package: { name: '@test/dsh', version: '1.0.0' }, verifiedFiles: { 'package.json': hash(pkg) },
  } }));
  const run = () => spawnSync(process.execPath, [path.join(repo, 'scripts/fetch-dsh.mjs')], { encoding: 'utf8', timeout: 20_000 });
  return { repo, run, source: path.join(repo, '.local/upstream/dsh') };
}

test('source extraction preserves UTF-8 names and real directory/file symlinks', async (t) => {
  const { run, source } = await fixture(t);
  const result = run();
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  for (const name of ['.claude/skills', 'CLAUDE.md']) assert.ok((await lstat(path.join(source, name))).isSymbolicLink());
  assert.equal(await readlink(path.join(source, '.claude/skills')), path.join('..', '.agents', 'skills'));
  assert.equal(await readlink(path.join(source, 'CLAUDE.md')), 'AGENTS.md');
  assert.equal(await realpath(path.join(source, '.claude/skills')), path.join(source, '.agents/skills'));
  assert.equal(await readFile(path.join(source, '.claude/skills/SKILL.md'), 'utf8'), 'skill');
  assert.equal(await readFile(path.join(source, 'CLAUDE.md'), 'utf8'), 'rules');
  assert.equal(await readFile(path.join(source, '说明.txt'), 'utf8'), '中文 source filename');
  assert.equal(run().status, 0, 'verified existing source remains reusable');
});

test('source symlink escaping the fixed root is rejected before publication', async (t) => {
  const { run, source } = await fixture(t, '../../outside');
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsafe source symlink/);
  await assert.rejects(lstat(source), { code: 'ENOENT' });
});

test('missing symlink target cannot publish incomplete source', async (t) => {
  const { run, source } = await fixture(t, '../missing');
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  await assert.rejects(lstat(source), { code: 'ENOENT' });
});
