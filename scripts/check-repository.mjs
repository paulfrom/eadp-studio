import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = 'packages/eadp-prototype/assets/prototype-template';
const templateRoot = resolve(root, templatePath);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  const product = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const minimumNode = /^>=(\d+)$/.exec(product.engines?.node ?? '');
  if (!minimumNode) throw new Error('package.json engines.node must declare a minimum major version');
  if (Number(process.versions.node.split('.')[0]) < Number(minimumNode[1])) {
    throw new Error(`Node ${product.engines.node} required; actual ${process.versions.node}`);
  }
  const origin = git('remote', 'get-url', 'origin').trim();
  if (origin !== 'git@github.com:paulfrom/eadp-studio.git') throw new Error('Unexpected origin');
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
  if (!tracked.length) throw new Error('Stage repository files before verifying the tracked snapshot');
  for (const path of tracked) {
    if (path.startsWith('.local/') || path.includes('/node_modules/') ||
        /(^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith('/.env.example') && path !== '.env.example' ||
        /\.(pem|key|pfx|p12)$/i.test(path)) {
      throw new Error(`Machine-local or credential file tracked: ${path}`);
    }
  }
  const manifest = JSON.parse(await readFile(resolve(root, `${templatePath}.manifest.json`), 'utf8'));
  const entries = [...manifest.files, ...manifest.addedFiles];
  const expected = new Set();
  for (const entry of entries) {
    const target = resolve(templateRoot, entry.path);
    const rel = relative(templateRoot, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || entry.path.includes('\\')) {
      throw new Error(`Invalid template manifest path: ${entry.path}`);
    }
    if (expected.has(entry.path)) throw new Error(`Duplicate template manifest path: ${entry.path}`);
    expected.add(entry.path);
    if (!(await lstat(target)).isFile()) throw new Error(`Template entry is not a regular file: ${entry.path}`);
    if (sha256(await readFile(target)) !== entry.sha256) throw new Error(`Template hash mismatch: ${entry.path}`);
    if (!tracked.includes(`${templatePath}/${entry.path}`)) throw new Error(`Template file absent from Git: ${entry.path}`);
  }
  for (const path of tracked.filter((path) => path.startsWith(`${templatePath}/`))) {
    if (!expected.has(path.slice(templatePath.length + 1))) throw new Error(`Template file absent from manifest: ${path}`);
  }
  const knowledgePath = 'packages/eadp-knowledge/resources/builtin';
  const knowledgeRoot = resolve(root, knowledgePath);
  const knowledge = JSON.parse(await readFile(resolve(knowledgeRoot, 'manifest.json'), 'utf8'));
  if (knowledge.schemaVersion !== 1 || knowledge.packId !== 'builtin' || typeof knowledge.version !== 'string' || !knowledge.version || !Array.isArray(knowledge.documents)) throw new Error('Invalid built-in knowledge manifest');
  const knowledgeFiles = new Set(['manifest.json', 'SOURCES.md']);
  const knowledgeIds = new Set();
  for (const card of knowledge.documents) {
    if (typeof card.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(card.id) || knowledgeIds.has(card.id) || typeof card.path !== 'string' || !/^cards\/[a-z0-9][a-z0-9_-]*\.md$/.test(card.path) || knowledgeFiles.has(card.path)) throw new Error('Invalid or duplicate built-in knowledge entry');
    if (![card.title, card.source, card.scope].every(value => typeof value === 'string' && value.trim()) || !Array.isArray(card.tags) || !card.tags.every(tag => typeof tag === 'string')) throw new Error('Missing knowledge provenance or scope');
    knowledgeIds.add(card.id); knowledgeFiles.add(card.path);
    const target = resolve(knowledgeRoot, card.path);
    if (!(await lstat(target)).isFile() || sha256(await readFile(target)) !== card.sha256) throw new Error(`Knowledge hash mismatch: ${card.path}`);
  }
  if (!(await readFile(resolve(knowledgeRoot, 'SOURCES.md'), 'utf8')).trim()) throw new Error('Knowledge sources must be documented');
  for (const file of knowledgeFiles) if (!tracked.includes(`${knowledgePath}/${file}`)) throw new Error(`Knowledge file absent from Git: ${file}`);
  for (const file of tracked.filter(file => file.startsWith(`${knowledgePath}/`))) if (!knowledgeFiles.has(file.slice(knowledgePath.length + 1))) throw new Error(`Knowledge file absent from manifest: ${file}`);
  const example = `${templatePath}/.env.example`;
  if (git('check-attr', 'eol', '--', example).trim() !== `${example}: eol: lf`) throw new Error('Template text must use LF');
  git('check-ignore', '--', '.local/probe');
  console.log(`Knowledge verified: ${knowledgeIds.size} built-in cards with source/scope and matching hashes.`);
  console.log(`Repository verified: ${tracked.length} tracked files; ${entries.length} template hashes match.`);
  console.log(`Template releaseReady=${manifest.acceptance.releaseReady}; desktop and runtime behavior remain unverified.`);
} catch (error) {
  console.error(`Repository verification failed: ${error.message}`);
  process.exitCode = 1;
}
