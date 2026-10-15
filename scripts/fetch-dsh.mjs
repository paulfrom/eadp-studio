import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = async (name) => {
  try { await lstat(name); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
const lines = (bytes) => bytes.toString('utf8').split(/\r?\n/).filter(Boolean);

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--archive-only') || process.argv.length > 3) {
    throw new Error('Usage: node scripts/fetch-dsh.mjs [--archive-only]');
  }
  const archiveOnly = process.argv.includes('--archive-only');
  const { dsh } = JSON.parse(await readFile(path.join(repo, 'apps/desktop-distribution/release.lock.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(dsh.commit) || !/^[a-f0-9]{64}$/.test(dsh.archive.sha256)
    || dsh.repository !== 'https://github.com/deepseek-ai/deepseek-harness'
    || dsh.archive.url !== `https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/${dsh.commit}`
    || dsh.archive.rootDirectory !== `deepseek-harness-${dsh.commit}`
    || dsh.sourceDirectory !== '.local/upstream/dsh') {
    throw new Error('Invalid fixed source contract in release.lock.json.');
  }
  const upstream = path.join(repo, '.local/upstream');
  await mkdir(upstream, { recursive: true });
  if (await realpath(upstream) !== upstream) throw new Error('Upstream path must not redirect through a symlink.');
  const mutex = path.join(upstream, '.dsh-fetch.lock');
  try { await mkdir(mutex); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another fetch holds .local/upstream/.dsh-fetch.lock. If interrupted, inspect it before manually removing this empty lock directory.');
    throw error;
  }
  let staging;
  try {
    staging = await mkdtemp(path.join(upstream, '.dsh-fetch-'));
    const archive = path.join(upstream, `dsh-${dsh.commit}.tar.gz`);
    const tar = async (...args) => (await run('tar', args, { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
    if (!await exists(archive)) {
      console.log(`Downloading fixed source commit ${dsh.commit}...`);
      const response = await fetch(dsh.archive.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`Source download failed: HTTP ${response.status}.`);
      const temporaryArchive = path.join(staging, 'source.tar.gz');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryArchive, { flags: 'wx' }));
      const downloaded = await readFile(temporaryArchive);
      if (downloaded.length !== dsh.archive.bytes || sha256(downloaded) !== dsh.archive.sha256) {
        throw new Error('Downloaded source archive size or SHA256 differs from release.lock.json.');
      }
      await rename(temporaryArchive, archive);
    }
    if (!(await lstat(archive)).isFile()) throw new Error('Cached source archive must be a regular file.');
    const archiveBytes = await readFile(archive);
    if (archiveBytes.length !== dsh.archive.bytes || sha256(archiveBytes) !== dsh.archive.sha256) {
      throw new Error('Cached source archive size or SHA256 differs from release.lock.json; nothing will be overwritten.');
    }
    const rootName = dsh.archive.rootDirectory;
    const entries = lines(await tar('-tf', archive));
    for (const entry of entries) {
      if (!entry.startsWith(`${rootName}/`) || entry.includes('\\') || entry.includes(':')
        || entry.split('/').some((part) => part === '..' || part === '.')) {
        throw new Error(`Unsafe archive path: ${entry}`);
      }
    }
    const links = [];
    for (const entry of lines(await tar('-tvf', archive))) {
      if (entry[0] === 'l') {
        const named = entry.slice(entry.indexOf(`${rootName}/`));
        const [name, target, extra] = named.split(' -> ');
        const resolved = target && path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
        if (extra !== undefined || !entries.includes(name) || !target || path.posix.isAbsolute(target)
          || target.includes('\\') || target.includes(':') || !resolved.startsWith(`${rootName}/`)) {
          throw new Error(`Unsafe source symlink: ${name}`);
        }
        links.push({ name, target });
      } else if (entry[0] !== '-' && entry[0] !== 'd') {
        throw new Error('Archive contains an unsupported special file or hard link.');
      }
    }
    if (entries.length !== dsh.archive.entryCount || links.length !== dsh.archive.symlinkCount) {
      throw new Error('Archive entry counts differ from release.lock.json.');
    }
    for (const { name } of links) {
      if (entries.some((entry) => entry.startsWith(`${name}/`))) throw new Error(`Archive writes through a symlink: ${name}`);
    }
    for (const [name, expected] of Object.entries(dsh.verifiedFiles)) {
      if (!entries.includes(`${rootName}/${name}`) || sha256(await tar('-xOf', archive, `${rootName}/${name}`)) !== expected) {
        throw new Error(`Source archive critical-file hash mismatch: ${name}`);
      }
    }
    const pkg = JSON.parse((await tar('-xOf', archive, `${rootName}/package.json`)).toString('utf8'));
    const actualPackage = { name: pkg.name, version: pkg.version, packageManager: pkg.packageManager, nodeEngine: pkg.engines?.node, typescript: pkg.devDependencies?.typescript };
    for (const [key, value] of Object.entries(dsh.package)) {
      if (actualPackage[key] !== value) throw new Error(`Source package requirement mismatch: ${key}`);
    }
    console.log(`Verified archive SHA256, ${entries.length} entry boundaries, ${links.length} internal symlinks, critical files and package requirements.`);
    if (archiveOnly) {
      await rmdir(staging);
      staging = undefined;
      console.log(`Archive ready: ${path.relative(repo, archive)}. No source extraction or release acceptance claimed.`);
      return;
    }
    const destination = path.join(upstream, 'dsh');
    const receiptPath = path.join(upstream, 'dsh.source.json');
    if (await exists(destination)) {
      if (!(await lstat(destination)).isDirectory()) throw new Error('Existing source destination must be a real directory.');
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      if (receipt.commit !== dsh.commit || receipt.archiveSha256 !== dsh.archive.sha256) throw new Error('Existing source receipt differs from the fixed source version; refusing to overwrite.');
      for (const [name, expected] of Object.entries(dsh.verifiedFiles)) {
        if (sha256(await readFile(path.join(destination, name))) !== expected) throw new Error(`Existing source critical file changed: ${name}; refusing to overwrite.`);
      }
      await rmdir(staging);
      staging = undefined;
      console.log(`Existing source critical files verified: ${dsh.sourceDirectory}. Nothing overwritten.`);
      return;
    }
    if (await exists(receiptPath)) throw new Error('Source receipt exists without its directory; inspect manually before continuing.');
    const probeTarget = path.join(staging, 'symlink-target');
    const probeLink = path.join(staging, 'symlink-link');
    await writeFile(probeTarget, 'source-symlink-probe', { flag: 'wx' });
    try { await symlink('symlink-target', probeLink, 'file'); } catch (error) {
      throw new Error(`Source extraction requires real symbolic-link permission (${error.code}). On Windows, use an account/environment already permitted to create symlinks. Archive is verified; source destination was not published.`, { cause: error });
    }
    await unlink(probeLink);
    await unlink(probeTarget);
    const extracted = path.join(staging, rootName);
    // POSIX tar headers do not carry a symlink target's directory/file type.
    // Windows bsdtar creates directory targets as file symlinks, which fail
    // realpath/access with EPERM. Extract regular entries first, then create
    // real symlinks with Node's explicit target type on every platform.
    // Windows bsdtar otherwise decodes UTF-8 ustar names using the local code
    // page (e.g. 说明.txt becomes 璇存槑.txt on a Chinese Windows machine).
    await tar('-xf', archive, '-C', staging,
      ...(process.platform === 'win32' ? ['--options', 'hdrcharset=UTF-8'] : []),
      ...links.flatMap(({ name }) => ['--exclude', name]));
    for (const { name, target } of links) {
      const linkPath = path.join(staging, name);
      const targetPath = await realpath(path.resolve(path.dirname(linkPath), target));
      if (targetPath !== extracted && !targetPath.startsWith(`${extracted}${path.sep}`)) {
        throw new Error(`Extracted symlink target escapes source root: ${name}`);
      }
      const targetStat = await stat(targetPath);
      if (!targetStat.isDirectory() && !targetStat.isFile()) throw new Error(`Unsupported source symlink target: ${name}`);
      await symlink(target, linkPath, targetStat.isDirectory() ? 'dir' : 'file');
    }
    for (const entry of entries) {
      const actual = await realpath(path.join(staging, entry));
      if (actual !== extracted && !actual.startsWith(`${extracted}${path.sep}`)) throw new Error(`Extracted entry escapes source root: ${entry}`);
    }
    for (const [name, expected] of Object.entries(dsh.verifiedFiles)) {
      if (sha256(await readFile(path.join(extracted, name))) !== expected) throw new Error(`Extracted source critical-file hash mismatch: ${name}`);
    }
    // Only publish a complete checked tree; rename stays on the same filesystem.
    await rename(extracted, destination);
    await writeFile(receiptPath, `${JSON.stringify({ commit: dsh.commit, archiveSha256: dsh.archive.sha256, verifiedFiles: dsh.verifiedFiles }, null, 2)}\n`, { flag: 'wx' });
    await rmdir(staging);
    staging = undefined;
    console.log(`Source ready: ${dsh.sourceDirectory}. Dependency installation and release validation remain separate.`);
  } finally {
    if (staging) console.error(`Incomplete staging retained for inspection: ${path.relative(repo, staging)}. It is not the source destination.`);
    await rmdir(mutex);
  }
}

main().catch((error) => { console.error(`fetch-dsh: ${error.message}`); process.exitCode = 1; });
