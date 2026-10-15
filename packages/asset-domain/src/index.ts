import { isMaterialMetadata, type EntityView, type MaterialMetadata, type Prerequisite } from '@eadp/contracts';

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409, public readonly details?: unknown) { super(message); }
}
export function requireCondition(condition: unknown, code: string, message: string, status = 409, details?: unknown): asserts condition {
  if (!condition) throw new DomainError(code, message, status, details);
}
export function repositoryPath(path: string): string {
  requireCondition(path.length <= 400 && !path.startsWith('/') && !/[\\\x00-\x1f:*?"<>|]/u.test(path), 'INVALID_PATH', 'Invalid repository path', 400);
  const parts = path.split('/');
  requireCondition(parts.every(p => p.length > 0 && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), 'INVALID_PATH', 'Invalid repository path', 400);
  return path;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function parseMaterial(markdown: string): MaterialMetadata {
  const matches = [...markdown.matchAll(/^```eadp-metadata\n([^]*?)\n```\n/gm)];
  requireCondition(matches.length === 1, 'INVALID_MATERIAL', 'One eadp-metadata JSON block is required', 422);
  let metadata: unknown;
  try { metadata = JSON.parse(matches[0]![1]!); } catch { throw new DomainError('INVALID_MATERIAL', 'Invalid material metadata JSON', 422); }
  requireCondition(isMaterialMetadata(metadata), 'INVALID_MATERIAL', 'Material metadata does not match the contract', 422);
  requireCondition(metadata.coreRulesPresent && metadata.acceptanceCriteriaPresent && !metadata.openQuestions.some(q => q.blocking), 'CORE_UNRESOLVED', 'Core business rules and acceptance criteria must be resolved', 422);
  for (const title of ['核心业务规则', '验收条件']) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const section = markdown.match(new RegExp(`^## ${escaped}\\n([^]*?)(?=^## |$(?![^]))`, 'm'))?.[1]?.trim();
    requireCondition(section && section.length >= 2, 'CORE_UNRESOLVED', `Material requires a nonempty ${title} section`, 422);
  }
  requireCondition(!metadata.referencedAssets.some(r => r.entityId === metadata.entityId), 'SELF_REFERENCE', 'An asset manifest cannot reference itself', 422);
  return metadata;
}
export function validatePrerequisites(entityId: string, prerequisites: Prerequisite[], entities: EntityView[]): void {
  const byId = new Map(entities.map(e => [e.id, e]));
  requireCondition(new Set(prerequisites.map(p => p.requirementId)).size === prerequisites.length, 'DUPLICATE_PREREQUISITE', 'Duplicate prerequisite');
  for (const p of prerequisites) requireCondition(p.requirementId !== entityId && byId.get(p.requirementId)?.kind === 'requirement', 'INVALID_PREREQUISITE', 'Prerequisite must be another requirement in the project', 409, { requirementId: p.requirementId });
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): void {
    requireCondition(!visiting.has(id), 'DEPENDENCY_CYCLE', 'Requirement prerequisites form a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const p of id === entityId ? prerequisites : byId.get(id)?.prerequisites ?? []) visit(p.requirementId);
    visiting.delete(id); visited.add(id);
  }
  visit(entityId);
}
export function prototypeBindings(entity: EntityView, entities: EntityView[]) {
  requireCondition(entity.kind === 'requirement' && entity.current && entity.confirmationStatus === 'confirmed', 'MATERIAL_REQUIRED', 'A confirmed requirement is required before prototype production');
  return entity.prerequisites.map(p => {
    const prerequisite = entities.find(e => e.id === p.requirementId);
    requireCondition(prerequisite?.current && prerequisite.completedVersion === p.version && prerequisite.current.version === p.version && prerequisite.current.prototypeBaselineId, 'PREREQUISITE_INCOMPLETE', 'Required prerequisite version has not been accepted as completed', 409, p);
    return { requirementId: p.requirementId, version: p.version, confirmationId: prerequisite.completionConfirmationId!, integrationSha: prerequisite.completedIntegrationSha! };
  });
}
