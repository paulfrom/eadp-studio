/**
 * Materialize the fixed DSH source recorded in release.lock.json.
 *
 * The pinned commit is decided in the lock itself (dsh.commit/dsh.tag); this
 * script takes no version argument. After the lock's commit/tag change — for
 * an upstream upgrade, edit both fields to the new release — run it to: validate
 * the tag against the pinned repository, obtain the commit archive, recompute
 * every derived archive fact (SHA-256, byte size, entry and symlink counts,
 * critical-file hashes, package requirements), rewrite those lock sections,
 * replace the machine-local cache, and re-run scripts/fetch-dsh.mjs as the
 * authoritative verification and extraction. Build-time acceptance claims are
 * reset on every materialization: dependency installation, native builds, and
 * distribution must be re-evidenced separately. When the local source already
 * matches the lock this script is a no-op.
 *
 * Usage: node scripts/dependency-update.mjs
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const lockPath = path.join(repo, 'apps/desktop-distribution/release.lock.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lines = (bytes) => bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
const platformLabel = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : process.platform;

async function main() {
  if (process.argv.length !== 2) {
    throw new Error('Usage: node scripts/dependency-update.mjs\nThe fixed commit comes from release.lock.json (dsh.commit/dsh.tag); no version argument is accepted.');
  }
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const { dsh } = lock;
  if (!/^[a-f0-9]{40}$/.test(dsh.commit)) {
    throw new Error(`release.lock.json dsh.commit must be a full 40-hex commit; found "${dsh.commit}".`);
  }
  const commit = dsh.commit;
  const repoPath = dsh.repository.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const archiveUrl = `https://codeload.github.com/${repoPath}/tar.gz/${commit}`;
  const rootDirectory = `${repoPath.split('/')[1]}-${commit}`;
  const upstream = path.join(repo, '.local/upstream');
  const receiptPath = path.join(upstream, 'dsh.source.json');
  const sourceDirectory = path.join(upstream, 'dsh');

  // The recorded tag must name this commit on the pinned repository.
  if (typeof dsh.tag === 'string' && dsh.tag !== commit) {
    const matched = lines((await run('git', ['ls-remote', dsh.repository, `refs/tags/${dsh.tag}`, `refs/tags/${dsh.tag}^{}`], { maxBuffer: 8 * 1024 * 1024 })).stdout);
    const peeled = matched.find((line) => line.endsWith('^{}'));
    const direct = matched.find((line) => !line.endsWith('^{}'));
    const resolved = (peeled ?? direct)?.slice(0, 40);
    if (resolved === undefined) {
      throw new Error(`release.lock.json dsh.tag "${dsh.tag}" is not a tag of ${dsh.repository}.`);
    }
    if (resolved !== commit) {
      throw new Error(`release.lock.json dsh.tag "${dsh.tag}" resolves to ${resolved}, which differs from dsh.commit ${commit}.`);
    }
  }

  // Nothing to do when the published source already matches the lock.
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.commit === commit && receipt.archiveSha256 === dsh.archive.sha256) {
      for (const [name, expected] of Object.entries(dsh.verifiedFiles)) {
        if (sha256(await readFile(path.join(sourceDirectory, name))) !== expected) {
          throw new Error(`Extracted source critical file changed: ${name}; refusing to treat the local source as materialized.`);
        }
      }
      console.log(`${commit} (${dsh.tag}) is already materialized in .local/upstream/dsh; nothing to update.`);
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(upstream, { recursive: true });
  const canonicalArchive = path.join(upstream, `dsh-${commit}.tar.gz`);
  const staging = await mkdtemp(path.join(upstream, '.dependency-update-'));
  let stagedArchive;
  try {
    let archive = canonicalArchive;
    if (await lstat(canonicalArchive).then((stats) => stats.isFile(), () => false)) {
      console.log(`Reusing cached archive ${path.relative(repo, canonicalArchive)}.`);
    } else {
      stagedArchive = path.join(staging, 'source.tar.gz');
      console.log(`Downloading ${archiveUrl} ...`);
      const response = await fetch(archiveUrl, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`Source download failed: HTTP ${response.status}.`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(stagedArchive, { flags: 'wx' }));
      archive = stagedArchive;
    }
    const bytes = (await stat(archive)).size;
    const hash = sha256(await readFile(archive));
    const tar = async (...args) => (await run('tar', args, { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
    const entries = lines(await tar('-tf', archive));
    if (entries.length === 0) throw new Error('Source archive lists no entries.');
    let symlinkCount = 0;
    for (const entry of lines(await tar('-tvf', archive))) {
      if (entry[0] === 'l') symlinkCount += 1;
    }
    const verifiedFiles = {};
    for (const name of Object.keys(dsh.verifiedFiles)) {
      verifiedFiles[name] = sha256(await tar('-xOf', archive, `${rootDirectory}/${name}`));
    }
    const manifest = JSON.parse((await tar('-xOf', archive, `${rootDirectory}/package.json`)).toString('utf8'));
    const facts = {
      name: manifest.name, version: manifest.version, packageManager: manifest.packageManager,
      nodeEngine: manifest.engines?.node, typescript: manifest.devDependencies?.typescript,
    };
    const packageFacts = {};
    for (const key of Object.keys(dsh.package)) {
      if (facts[key] === undefined) throw new Error(`Source package fact unavailable: ${key}`);
      packageFacts[key] = facts[key];
    }

    const probeTarget = path.join(staging, 'symlink-target');
    const probeLink = path.join(staging, 'symlink-link');
    await writeFile(probeTarget, 'source-symlink-probe', { flag: 'wx' });
    try {
      await symlink('symlink-target', probeLink, 'file');
    } catch (error) {
      throw new Error(`Source extraction requires real symbolic-link permission (${error.code}). On Windows, use an account/environment already permitted to create symlinks.`);
    }
    await unlink(probeLink);
    await unlink(probeTarget);

    // dsh.commit/dsh.tag are the decision; every other dsh fact is derived here.
    const nextLock = {
      ...lock,
      status: 'source-update-pending',
      dsh: {
        ...dsh,
        archive: { url: archiveUrl, sha256: hash, bytes, rootDirectory, entryCount: entries.length, symlinkCount },
        package: packageFacts,
        verifiedFiles,
      },
      acceptance: {
        sourceArchiveVerified: false,
        fullSourceExtractionVerified: false,
        fullSourceExtractionPlatforms: [],
        targetReleasePocVerified: false,
        dependencyInstallVerified: false,
        nativeBuildVerified: false,
        distributionVerified: false,
        releaseReady: false,
      },
    };
    await writeFile(lockPath, `${JSON.stringify(nextLock, null, 2)}\n`);

    // Swap the machine-local cache; fetch-dsh refuses to overwrite mismatched state.
    await rm(sourceDirectory, { recursive: true, force: true });
    await rm(receiptPath, { force: true });
    for (const cached of await readdir(upstream)) {
      if (/^dsh-[a-f0-9]{40}\.tar\.gz$/.test(cached) && cached !== path.basename(canonicalArchive)) {
        await rm(path.join(upstream, cached), { force: true });
      }
    }
    if (stagedArchive) await rename(stagedArchive, canonicalArchive);

    const fetched = spawnSync(process.execPath, [path.join(repo, 'scripts/fetch-dsh.mjs')], { stdio: 'inherit' });
    if (fetched.status !== 0) {
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      throw new Error(`fetch-dsh rejected the fixed source recorded in the lock; release.lock.json was restored. Inspect .local/upstream before retrying.`);
    }

    // The old build tree was assembled from the previous source; never reuse it.
    await rm(path.join(repo, '.local/build/dsh'), { recursive: true, force: true });
    await rm(path.join(repo, '.local/build/packed-studio'), { recursive: true, force: true });
    const verified = JSON.parse(await readFile(lockPath, 'utf8'));
    verified.acceptance = {
      sourceArchiveVerified: true,
      fullSourceExtractionVerified: true,
      fullSourceExtractionPlatforms: [platformLabel],
      targetReleasePocVerified: false,
      dependencyInstallVerified: false,
      nativeBuildVerified: false,
      distributionVerified: false,
      releaseReady: false,
    };
    verified.status = 'source-archive-extraction-verified';
    await writeFile(lockPath, `${JSON.stringify(verified, null, 2)}\n`);
    console.log(`Fixed source materialized: ${commit} (${dsh.tag}).`);
    console.log('The stale build tree was removed. Re-run node apps/desktop-distribution/build/prepare-studio-plugin.mjs and the focused regressions before claiming assembly acceptance.');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(`dependency-update: ${error.message}`); process.exitCode = 1; });
