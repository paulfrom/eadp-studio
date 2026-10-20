import { isConfirmedMaterialMetadata, isProjectManifest, type EntityView, type MaterialMetadata, type Prerequisite, type ProjectManifest } from '@eadp/contracts';

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
  requireCondition(isConfirmedMaterialMetadata(metadata), 'INVALID_MATERIAL', 'Material metadata does not match the confirmation contract', 422);
  validateMaterialMetadata(metadata);
  return metadata;
}
/** Checks explicit business declarations without inferring quality from document headings. */
export function validateMaterialMetadata(metadata: MaterialMetadata): void {
  requireCondition(metadata.coreRulesPresent && metadata.acceptanceCriteriaPresent && !metadata.openQuestions.some(q => q.blocking), 'CORE_UNRESOLVED', 'Core business rules and acceptance criteria must be resolved', 422);
  requireCondition(!metadata.referencedAssets.some(r => r.entityId === metadata.entityId), 'SELF_REFERENCE', 'An asset manifest cannot reference itself', 422);
  if (metadata.kind === 'requirement') requireCondition(metadata.sources.length > 0, 'SCENARIO_SOURCE_REQUIRED', 'Requirements need at least one confirmed scenario version source', 422);
  const files = new Map<string, string>();
  for (const file of [...(metadata.files ?? []), ...metadata.businessEvidence.flatMap(e => e.files)]) {
    repositoryPath(file.path);
    const prior = files.get(file.path);
    requireCondition(!prior || prior === file.sha256, 'FILE_REFERENCE_CONFLICT', 'The same fixed file cannot declare different hashes', 422);
    files.set(file.path, file.sha256);
  }
  for (const evidence of metadata.businessEvidence) {
    requireCondition(evidence.files.every(file => file.path.startsWith('.eadp/evidence/')), 'EVIDENCE_PATH_SCOPE', 'Formal evidence must be archived under .eadp/evidence/', 422);
    for (const range of evidence.ranges) {
      repositoryPath(range.path);
      requireCondition(range.startLine <= range.endLine && evidence.files.some(file => file.path === range.path), 'EVIDENCE_RANGE_INVALID', 'Evidence ranges must belong to the archived files and be ordered', 422);
    }
  }
  if (metadata.kind === 'scenario') {
    repositoryPath(metadata.templateRef.path);
    requireCondition(metadata.templateRef.path === `.template/${metadata.templateId}.md`, 'TEMPLATE_IDENTITY_MISMATCH', 'The template path must match its stable template ID', 422);
  }
}
/** Validates the project-owned template catalog; the accepted Git tree remains authoritative. */
export function parseProjectManifest(text: string): ProjectManifest {
  let manifest: unknown;
  try { manifest = JSON.parse(text); } catch { throw new DomainError('INVALID_PROJECT_MANIFEST', 'Project manifest must be valid JSON', 422); }
  requireCondition(isProjectManifest(manifest), 'INVALID_PROJECT_MANIFEST', 'Project manifest does not match the project contract', 422);
  const catalog = manifest.scenarioTemplates;
  requireCondition(new Set(catalog.templates.map(t => t.id)).size === catalog.templates.length && new Set(catalog.templates.map(t => t.path)).size === catalog.templates.length, 'DUPLICATE_TEMPLATE', 'Project template identities and paths must be unique', 422);
  requireCondition(catalog.templates.some(t => t.id === catalog.defaultTemplateId), 'DEFAULT_TEMPLATE_REQUIRED', 'The default scenario template must exist in the catalog', 422);
  for (const template of catalog.templates) {
    repositoryPath(template.path);
    requireCondition(template.path === `.template/${template.id}.md`, 'TEMPLATE_IDENTITY_MISMATCH', 'Template paths must match their stable template IDs', 422);
  }
  return manifest;
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
  requireCondition(!entity.current.metadata.applicability, 'REQUIREMENT_NOT_APPLICABLE', 'The current requirement version is explicitly not applicable');
  return entity.prerequisites.map(p => {
    const prerequisite = entities.find(e => e.id === p.requirementId);
    const completion = prerequisite?.completions?.find(c => c.version === p.version);
    requireCondition(completion, 'PREREQUISITE_INCOMPLETE', 'Required prerequisite version has not been accepted as completed', 409, p);
    return { requirementId: p.requirementId, version: p.version, confirmationId: completion.confirmationId, integrationSha: completion.integrationSha };
  });
}
