import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DomainError, requireCondition } from '@eadp/asset-domain';
import type { PrototypeIntegrationRequest } from '@eadp/contracts';
import type { GitLab } from './auth/gitlab.js';
import { withinPrototypeScope } from './prototype-policy.js';

type TreeEntry = { id: string; name: string; type: 'tree' | 'blob' | 'commit'; path: string; mode: string };
type Tree = { root: TreeEntry[]; entries: TreeEntry[]; prototypeId: string };
const SHA = /^[a-f0-9]{40}$/;
const MAX_OBJECTS = 3000, MAX_BYTES = 64 * 1024 * 1024, MAX_BLOB = 2 * 1024 * 1024, TIMEOUT_MS = 90_000;
// The verifier is a separate unprivileged process; these are per-process limits,
// in addition to the object and overall elapsed-time budgets.
const GIT_CPU_SECONDS = 25, GIT_ADDRESS_BYTES = 512 * 1024 * 1024, GIT_FILE_BYTES = 128 * 1024 * 1024;
const ROOT = '原型代码';
let active = 0;

/** Runs only fixed Git commands in an isolated object database with bounded output and time. */
async function git(directory: string, deadline: number, args: string[], input?: Uint8Array): Promise<string> {
  const remaining = deadline - Date.now();
  requireCondition(remaining > 0, 'MERGE_VERIFIER_UNAVAILABLE', 'Prototype merge verification timed out', 503);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/prlimit', [`--cpu=${GIT_CPU_SECONDS}`, `--as=${GIT_ADDRESS_BYTES}`, `--fsize=${GIT_FILE_BYTES}`, '--', '/usr/local/bin/git', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory, env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Studio', GIT_AUTHOR_EMAIL: 'studio@localhost', GIT_COMMITTER_NAME: 'Studio', GIT_COMMITTER_EMAIL: 'studio@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), remaining);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 64 * 1024) { overflow = true; child.kill('SIGKILL'); } });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new DomainError('MERGE_VERIFIER_UNAVAILABLE', 'Prototype merge verifier is unavailable', 503)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || overflow) reject(new DomainError(!overflow && code === 1 && args[0] === 'merge-tree' ? 'MERGE_CONFLICT' : 'MERGE_VERIFIER_UNAVAILABLE', 'Prototype merge verification did not complete cleanly', !overflow && code === 1 && args[0] === 'merge-tree' ? 409 : 503));
      else resolve(output.trim());
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function entry(value: unknown): TreeEntry {
  const item = value as Partial<TreeEntry>;
  requireCondition(item && typeof item.id === 'string' && SHA.test(item.id) && typeof item.name === 'string' && typeof item.path === 'string' && typeof item.mode === 'string' &&
    (item.type === 'tree' || item.type === 'blob' || item.type === 'commit') && item.name.length > 0 && !item.name.includes('/') && !item.name.includes('\0') && !item.name.includes('\n') && item.name !== '.' && item.name !== '..' &&
    (item.type === 'tree' ? item.mode === '040000' : item.type === 'commit' ? item.mode === '160000' : ['100644', '100755', '120000'].includes(item.mode)),
  'CANDIDATE_TREE_MISMATCH', 'Prototype tree contains an invalid object', 409);
  return item as TreeEntry;
}

async function loadTree(gitlab: GitLab, projectId: number, sha: string, deadline: number): Promise<Tree> {
  const budget = { maxItems: MAX_OBJECTS, maxBytes: 3 * 1024 * 1024, deadline };
  const endpoint = `/projects/${projectId}/repository/tree`, root = (await gitlab.list(`${endpoint}?ref=${sha}`, budget)).map(entry);
  requireCondition(root.every(value => value.path === value.name) && new Set(root.map(value => value.path)).size === root.length, 'CANDIDATE_TREE_MISMATCH', 'Project tree listing is invalid', 409);
  const prototype = root.find(value => value.path === ROOT && value.name === ROOT && value.type === 'tree');
  requireCondition(prototype && root.filter(value => value.path === ROOT).length === 1, 'CANDIDATE_TREE_MISMATCH', 'Prototype tree is missing', 409);
  const entries = (await gitlab.list(`${endpoint}?ref=${sha}&path=${encodeURIComponent(ROOT)}&recursive=true`, budget)).map(entry);
  requireCondition(entries.length <= MAX_OBJECTS && new Set(entries.map(value => value.path)).size === entries.length && entries.every(value => (value.type === 'tree' || value.type === 'blob' && value.mode !== '120000') && value.path.startsWith(`${ROOT}/`) && value.path.slice(ROOT.length + 1).split('/').every(part => part && part !== '.' && part !== '..') && value.path.split('/').at(-1) === value.name), 'CANDIDATE_TREE_MISMATCH', 'Prototype tree listing is incomplete or invalid', 409);
  const directories = new Set([ROOT, ...entries.filter(value => value.type === 'tree').map(value => value.path)]);
  requireCondition(entries.every(value => directories.has(value.path.slice(0, value.path.lastIndexOf('/')))), 'CANDIDATE_TREE_MISMATCH', 'Prototype tree is missing an ancestor', 409);
  return { root, entries, prototypeId: prototype.id };
}

function otherRoot(tree: Tree): string {
  return JSON.stringify(tree.root.filter(item => item.path !== ROOT).map(item => [item.path, item.type, item.mode, item.id]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
}
function changed(from: Tree, to: Tree): string[] {
  const files = (tree: Tree) => new Map(tree.entries.filter(item => item.type === 'blob').map(item => [item.path, `${item.mode}:${item.id}`]));
  const left = files(from), right = files(to);
  return [...new Set([...left.keys(), ...right.keys()])].filter(name => left.get(name) !== right.get(name));
}
function assertPaths(input: PrototypeIntegrationRequest, from: Tree, to: Tree): void {
  const paths = changed(from, to);
  requireCondition(paths.length > 0 && paths.every(value => input.allowedPaths.includes(value)), 'CANDIDATE_PATH_SCOPE', 'Prototype changes must be within the declared fixed paths', 422);
}

/** Reconstruct a subtree from individually verified Git blobs and trees. */
async function materialize(gitlab: GitLab, projectId: number, tree: Tree, directory: string, deadline: number, budget: { bytes: number; objects: number }, blobs: Set<string>): Promise<string> {
  const blobEntries = tree.entries.filter(item => item.type === 'blob');
  for (const blob of blobEntries) {
    if (blobs.has(blob.id)) continue;
    requireCondition(++budget.objects <= MAX_OBJECTS && Date.now() < deadline, 'MERGE_VERIFIER_UNAVAILABLE', 'Prototype object budget exceeded', 503);
    const bytes = await gitlab.bytes(`/projects/${projectId}/repository/blobs/${blob.id}/raw`, MAX_BLOB);
    budget.bytes += bytes.byteLength;
    requireCondition(budget.bytes <= MAX_BYTES, 'MERGE_VERIFIER_UNAVAILABLE', 'Prototype byte budget exceeded', 503);
    const digest = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
    requireCondition(digest === blob.id, 'CANDIDATE_TREE_MISMATCH', 'Git blob identity does not match its contents', 409);
    requireCondition(await git(directory, deadline, ['hash-object', '-w', '--stdin'], bytes) === blob.id, 'CANDIDATE_TREE_MISMATCH', 'Git blob reconstruction failed', 409);
    blobs.add(blob.id);
  }
  const directories = [ROOT, ...tree.entries.filter(item => item.type === 'tree').map(item => item.path)].sort((a, b) => b.split('/').length - a.split('/').length);
  const results = new Map<string, string>();
  for (const folder of directories) {
    requireCondition(++budget.objects <= MAX_OBJECTS && Date.now() < deadline, 'MERGE_VERIFIER_UNAVAILABLE', 'Prototype tree budget exceeded', 503);
    const children = tree.entries.filter(item => item.path.startsWith(`${folder}/`) && !item.path.slice(folder.length + 1).includes('/'));
    const records = children.map(item => {
      const object = item.type === 'tree' ? results.get(item.path) : item.id;
      requireCondition(object && (item.type !== 'tree' || object === item.id), 'CANDIDATE_TREE_MISMATCH', 'Git tree identity does not match its contents', 409);
      return `${item.mode} ${item.type} ${object}\t${item.name}\0`;
    }).join('');
    results.set(folder, await git(directory, deadline, ['mktree', '-z'], Buffer.from(records)));
  }
  const result = results.get(ROOT)!;
  requireCondition(result === tree.prototypeId, 'CANDIDATE_TREE_MISMATCH', 'Prototype subtree identity does not match its contents', 409);
  return result;
}

/** Merge synthetic subtree commits with the verified common ancestor. */
async function mergeSubtrees(directory: string, deadline: number, baseTree: string, headTree: string, sourceTree: string): Promise<string> {
  const ancestor = await git(directory, deadline, ['commit-tree', baseTree], Buffer.from('base\n'));
  const headCommit = await git(directory, deadline, ['commit-tree', headTree, '-p', ancestor], Buffer.from('head\n'));
  const sourceCommit = await git(directory, deadline, ['commit-tree', sourceTree, '-p', ancestor], Buffer.from('source\n'));
  return git(directory, deadline, ['merge-tree', '--write-tree', headCommit, sourceCommit]);
}

/** Verify source scope and an actual subtree conflict before changing a task's source base. */
export async function verifyPrototypeConflict(gitlab: GitLab, projectId: number, input: { sourceBaseHead: string; sourceSha: string; newBaseHead: string; writeScope: readonly string[] }): Promise<string> {
  requireCondition(active < 2, 'MERGE_VERIFIER_UNAVAILABLE', 'Prototype merge verifier is busy', 503);
  active++;
  let directory: string | undefined;
  try {
    const deadline = Date.now() + TIMEOUT_MS;
    const mergeBaseSha = await gitlab.mergeBase(projectId, input.newBaseHead, input.sourceSha);
    const [base, sourceBase, head, source] = await Promise.all([mergeBaseSha, input.sourceBaseHead, input.newBaseHead, input.sourceSha].map(sha => loadTree(gitlab, projectId, sha, deadline)));
    requireCondition(otherRoot(sourceBase!) === otherRoot(source!) && otherRoot(base!) === otherRoot(source!), 'CANDIDATE_PATH_SCOPE', 'Prototype source cannot modify other project trees', 422);
    const paths = changed(sourceBase!, source!);
    requireCondition(paths.length > 0 && paths.every(value => withinPrototypeScope(value, input.writeScope)), 'PROTOTYPE_PATH_SCOPE', 'Prototype source changes must remain in the task write scope', 422);
    directory = await mkdtemp(path.join(os.tmpdir(), 'studio-prototype-conflict-'));
    requireCondition(await git(directory, deadline, ['--version']) === 'git version 2.56.0', 'MERGE_VERIFIER_UNAVAILABLE', 'The pinned Git merge verifier is unavailable', 503);
    await git(directory, deadline, ['init', '--bare', '--quiet']);
    const budget = { bytes: 0, objects: 0 }, blobs = new Set<string>();
    const baseTree = await materialize(gitlab, projectId, base!, directory, deadline, budget, blobs);
    await materialize(gitlab, projectId, sourceBase!, directory, deadline, budget, blobs);
    const headTree = await materialize(gitlab, projectId, head!, directory, deadline, budget, blobs);
    const sourceTree = await materialize(gitlab, projectId, source!, directory, deadline, budget, blobs);
    try { await mergeSubtrees(directory, deadline, baseTree, headTree, sourceTree); }
    catch (error) {
      if (error instanceof DomainError && error.code === 'MERGE_CONFLICT') return mergeBaseSha;
      throw error;
    }
    throw new DomainError('MERGE_NOT_CONFLICTED', 'The original source merges cleanly and cannot use the conflict-base route', 409);
  } finally { try { if (directory) await rm(directory, { recursive: true, force: true }); } finally { active--; } }
}

/** Verify the real subtree and, for concurrent changes, recompute the three-way merge independently. */
export async function verifyPrototypeMerge(gitlab: GitLab, projectId: number, input: PrototypeIntegrationRequest): Promise<void> {
  requireCondition(active < 2, 'MERGE_VERIFIER_UNAVAILABLE', 'Prototype merge verifier is busy', 503);
  active++;
  let directory: string | undefined;
  try {
    const deadline = Date.now() + TIMEOUT_MS;
    const baseSha = input.derivation.kind === 'clean-merge' ? await gitlab.mergeBase(projectId, input.expectedHead, input.sourceSha) : input.sourceBaseHead;
    if (input.derivation.kind === 'clean-merge') requireCondition(baseSha === input.derivation.mergeBaseSha, 'SOURCE_CANDIDATE_MISMATCH', 'Prototype merge base does not match Git history', 409);
    const [base, sourceBase, head, source, candidate] = await Promise.all([baseSha, input.sourceBaseHead, input.expectedHead, input.sourceSha, input.candidateSha].map(sha => loadTree(gitlab, projectId, sha, deadline)));
    requireCondition(otherRoot(sourceBase!) === otherRoot(source!) && otherRoot(head!) === otherRoot(candidate!) && (input.derivation.kind !== 'clean-merge' || otherRoot(base!) === otherRoot(source!)), 'CANDIDATE_PATH_SCOPE', 'Prototype changes cannot modify other project trees', 422);
    assertPaths(input, sourceBase!, source!); assertPaths(input, head!, candidate!);
    directory = await mkdtemp(path.join(os.tmpdir(), 'studio-prototype-merge-'));
    const version = await git(directory, deadline, ['--version']);
    requireCondition(version === 'git version 2.56.0', 'MERGE_VERIFIER_UNAVAILABLE', 'The pinned Git merge verifier is unavailable', 503);
    await git(directory, deadline, ['init', '--bare', '--quiet']);
    const budget = { bytes: 0, objects: 0 }, blobs = new Set<string>();
    const baseTree = await materialize(gitlab, projectId, base!, directory, deadline, budget, blobs);
    await materialize(gitlab, projectId, sourceBase!, directory, deadline, budget, blobs);
    const headTree = await materialize(gitlab, projectId, head!, directory, deadline, budget, blobs);
    const sourceTree = await materialize(gitlab, projectId, source!, directory, deadline, budget, blobs);
    const candidateTree = await materialize(gitlab, projectId, candidate!, directory, deadline, budget, blobs);
    if (input.derivation.kind === 'author-confirmed') requireCondition(candidateTree === sourceTree, 'CANDIDATE_TREE_MISMATCH', 'Direct candidate differs from the confirmed source', 409);
    else {
      const merged = await mergeSubtrees(directory, deadline, baseTree, headTree, sourceTree);
      requireCondition(SHA.test(merged) && merged === candidateTree, 'CANDIDATE_TREE_MISMATCH', 'Candidate subtree does not match the independently computed merge', 409);
    }
  } finally { try { if (directory) await rm(directory, { recursive: true, force: true }); } finally { active--; } }
}
