import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonical, PROTOTYPE_MERGE_POLICY, repositoryPath, requireCondition } from '@eadp/asset-domain';

interface PrototypePolicy { protectedPaths: string[]; writablePrefixes: string[] }

/** The same bundled manifest defines the desktop template and server write policy. */
export async function prototypePolicy(): Promise<PrototypePolicy & { hash: string }> {
  const path = new URL('../../../packages/studio-plugin/assets/prototype-template.manifest.json', import.meta.url);
  const manifest: unknown = JSON.parse(await readFile(path, 'utf8'));
  const contract = (manifest as { contract?: Partial<PrototypePolicy> }).contract;
  requireCondition(contract && Array.isArray(contract.protectedPaths) && Array.isArray(contract.writablePrefixes) &&
    contract.protectedPaths.every(value => typeof value === 'string' && value.length > 0) &&
    contract.writablePrefixes.every(value => typeof value === 'string' && value.length > 0),
  'PROTOTYPE_POLICY_UNAVAILABLE', 'Bundled prototype policy is unavailable', 503);
  const policy = { protectedPaths: contract.protectedPaths, writablePrefixes: contract.writablePrefixes };
  return { ...policy, hash: createHash('sha256').update(canonical({ ...policy, mergePolicy: PROTOTYPE_MERGE_POLICY })).digest('hex') };
}

/** Reject any scope that is outside the bundled writable policy or intersects protected paths. */
export function validatePrototypePolicy(policy: PrototypePolicy & { hash: string }, paths: readonly string[], hash: string): void {
  requireCondition(hash === policy.hash, 'TASK_POLICY_CHANGED', 'Prototype template policy has changed', 409);
  requireCondition(paths.length > 0 && new Set(paths).size === paths.length, 'PROTOTYPE_PATH_SCOPE', 'Prototype scope must contain distinct paths', 422);
  for (const value of paths) {
    const prefix = value.endsWith('/'), clean = prefix ? value.slice(0, -1) : value;
    const valid = clean && !clean.startsWith('/') && !clean.includes('\\') && !clean.includes('\0') && !clean.includes(':') &&
      clean.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
    const allowed = policy.writablePrefixes.some(item => item.endsWith('/') ? value.startsWith(item) : !prefix && value === item);
    const protectedPath = policy.protectedPaths.some(item => clean === item || clean.startsWith(`${item}/`) || (prefix && item.startsWith(value)));
    requireCondition(valid && allowed && !protectedPath, 'PROTOTYPE_PATH_SCOPE', 'Prototype scope exceeds the bundled writable policy', 422);
  }
}

/** Check a full repository path against the persisted task-relative write scope. */
export function withinPrototypeScope(path: string, scope: readonly string[]): boolean {
  try { repositoryPath(path); } catch { return false; }
  if (path.split('/').some(segment => segment.toLowerCase() === '.git')) return false;
  const relative = path.startsWith('原型代码/') ? path.slice('原型代码/'.length) : '';
  return !!relative && scope.some(item => item.endsWith('/') ? relative.startsWith(item) : relative === item);
}
