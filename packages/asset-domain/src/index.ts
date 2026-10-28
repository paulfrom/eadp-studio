import { isConfirmedMaterialMetadata, isProjectManifest, type BuiltinScenarioMetadata, type EntityView, type MaterialMetadata, type Prerequisite, type ProjectManifest } from '@eadp/contracts';

/** Version of the fixed Git strategy used for prototype subtree merges. */
export const PROTOTYPE_MERGE_POLICY = 'git-2.56.0-ort-subtree-v1';

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
/** Material kinds that live as versioned Markdown in the user's project. */
export type MaterialKind = 'scenario' | 'requirement' | 'handoff';
const materialDirectories: Record<MaterialKind, string> = { scenario: '场景', requirement: '需求', handoff: '交接' };
const reservedFileNames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const materialNameLimit = 60;
const forbiddenNameCharacters = /[\\/\x00-\x1f:*?"<>|]/gu;
export function materialDirectoryOf(kind: MaterialKind): string { return materialDirectories[kind]; }
/**
 * Derives the readable file-name stem of a material from its business title.
 * Only characters a file system cannot hold are replaced; the result stays far
 * below the repository path limit and is never a directory or reserved name.
 */
export function materialStem(title: string): string {
  const cleaned = title.normalize('NFC').replace(forbiddenNameCharacters, '_').replace(/\s+/gu, ' ').replace(/^[\s.]+|[\s.]+$/gu, '');
  const stem = [...cleaned].slice(0, materialNameLimit).join('').replace(/[\s.]+$/gu, '');
  return reservedFileNames.test(stem) ? `${stem}_` : stem || '未命名';
}
/** Relative Markdown path for a material title; `suffix` disambiguates same-title materials. */
export function materialPathOf(kind: MaterialKind, title: string, suffix = 1): string {
  const stem = materialStem(title);
  return `${materialDirectories[kind]}/${suffix === 1 ? stem : `${stem}-${suffix}`}.md`;
}
/** Whether a path is a Markdown material file inside its kind's directory. */
export function isMaterialPath(kind: MaterialKind, file: string): boolean {
  const prefix = `${materialDirectories[kind]}/`, name = file.slice(prefix.length);
  return file.startsWith(prefix) && name.endsWith('.md') && name.length > 3 && !name.includes('/');
}
/** Whether a committed path still follows the title rule of its material kind. */
export function isMaterialPathOf(kind: MaterialKind, file: string, title: string): boolean {
  if (!isMaterialPath(kind, file)) return false;
  const name = file.slice(materialDirectories[kind].length + 1, -3), stem = materialStem(title).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${stem}(?:-(?:[2-9]|[1-9][0-9]+))?$`, 'u').test(name);
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
  if (metadata.kind === 'scenario') {
    requireCondition(metadata.flowComplete && !metadata.openQuestions.some(q => q.blocking), 'FLOW_UNRESOLVED', 'Scenario business flow must be complete with no unresolved flow gaps', 422);
  } else {
    requireCondition(metadata.coreRulesPresent && metadata.acceptanceCriteriaPresent && !metadata.openQuestions.some(q => q.blocking), 'CORE_UNRESOLVED', 'Core business rules and acceptance criteria must be resolved', 422);
  }
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
  if (metadata.kind === 'scenario' || metadata.kind === 'requirement') {
    repositoryPath(metadata.templateRef.path);
    requireCondition(metadata.templateRef.path === `.template/${metadata.templateId}.md`, 'TEMPLATE_IDENTITY_MISMATCH', 'The template path must match its stable template ID', 422);
  }
}
/** Validates the project-owned template catalog; the accepted Git tree remains authoritative. */
export function parseProjectManifest(text: string): ProjectManifest {
  let manifest: unknown;
  try { manifest = JSON.parse(text); } catch { throw new DomainError('INVALID_PROJECT_MANIFEST', 'Project manifest must be valid JSON', 422); }
  requireCondition(isProjectManifest(manifest), 'INVALID_PROJECT_MANIFEST', 'Project manifest does not match the project contract', 422);
  for (const catalog of [manifest.scenarioTemplates, manifest.requirementTemplates]) {
    requireCondition(new Set(catalog.templates.map(t => t.id)).size === catalog.templates.length && new Set(catalog.templates.map(t => t.path)).size === catalog.templates.length, 'DUPLICATE_TEMPLATE', 'Project template identities and paths must be unique', 422);
    requireCondition(catalog.templates.some(t => t.id === catalog.defaultTemplateId), 'DEFAULT_TEMPLATE_REQUIRED', 'The default template must exist in its catalog', 422);
    for (const template of catalog.templates) {
      repositoryPath(template.path);
      requireCondition(template.path === `.template/${template.id}.md`, 'TEMPLATE_IDENTITY_MISMATCH', 'Template paths must match their stable template IDs', 422);
    }
  }
  const all = [...manifest.scenarioTemplates.templates, ...manifest.requirementTemplates.templates];
  requireCondition(new Set(all.map(t => t.id)).size === all.length, 'DUPLICATE_TEMPLATE', 'Template identities must be unique across scenario and requirement catalogs', 422);
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
export const GENERAL_SCENARIO_TITLE = '通用场景';
export const GENERAL_SCENARIO_SUMMARY = '项目内置通用场景，用于关联暂不归属具体业务场景的需求。';
const GENERAL_SCENARIO_BODY = `# 通用场景

本场景由项目固定内置，用于关联暂不归属其他具体业务场景的需求，无须用户先新增、编辑或确认场景。

## 适用范围

用户可以直接选择本场景创建需求。需求的目标、范围、角色、流程、字段、规则、异常和验收条件，由该需求自身材料描述。

## 业务依据

本说明只提供需求的场景归属，不提供具体业务规则，也不代替需求自身的正式依据和确认。

## 需求管理

关联需求独立整理、修订和确认。新建需求无须先补充本场景的内容；需求中应直接说明自身的业务目标、规则和验收条件。
`;
/** Controlled metadata for the system-provisioned general scenario. */
export function generalScenarioMetadata(entityId: string): BuiltinScenarioMetadata {
  return { entityId, kind: 'scenario', title: GENERAL_SCENARIO_TITLE, summary: GENERAL_SCENARIO_SUMMARY, scenarioIds: [], prerequisites: [], sources: [], referencedAssets: [], businessEvidence: [], openQuestions: [], flowComplete: false };
}
/** The exact document bytes the Host writes into the initialization commit; the backend rebuilds and byte-compares it. */
export function generalScenarioDocument(entityId: string): string {
  return `${GENERAL_SCENARIO_BODY}\n\`\`\`eadp-metadata\n${JSON.stringify(generalScenarioMetadata(entityId), null, 2)}\n\`\`\`\n`;
}
/** Strict fixed read for system-provisioned acceptance; never a fallback after ordinary parsing fails. */
export function parseBuiltinScenario(markdown: string, entityId: string): BuiltinScenarioMetadata {
  requireCondition(markdown === generalScenarioDocument(entityId), 'INVALID_BUILTIN_SCENARIO', 'Built-in general scenario content does not match the provisioned document', 422);
  return generalScenarioMetadata(entityId);
}
