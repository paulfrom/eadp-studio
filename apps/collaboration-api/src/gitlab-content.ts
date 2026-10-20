import { createHash } from 'node:crypto';
import { canonical, DomainError, parseMaterial, parseProjectManifest, repositoryPath, requireCondition, validateMaterialMetadata } from '@eadp/asset-domain';
import { isFixedManifest, type EntityKind, type FixedReference, type MaterialMetadata, type PrepareIntegrationRequest, type ProjectManifest } from '@eadp/contracts';
import { GitLab } from './auth/gitlab.js';
import type { Actor } from './auth/session.js';

type Reader = Pick<Actor, 'gitlabUserId'>;
type Diff = { old_path: string; new_path: string; deleted_file: boolean; renamed_file: boolean; too_large?: boolean; collapsed?: boolean; diff: string };
type Compare = { compare_timeout?: boolean; compare_same_ref?: boolean; diffs: Diff[] };
export interface ProjectTemplates { defaultTemplateId: string; templates: Array<{ id: string; name: string; fixed: FixedReference }> }
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function utf8(bytes: Uint8Array, code: string): string {
  requireCondition(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) && !bytes.includes(13), code, 'Text must use UTF-8 without BOM and LF line endings', 422);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new DomainError(code, 'Text is not valid UTF-8', 422); }
}

export class GitLabContent {
  constructor(private readonly gitlab: GitLab) {}
  private async file(gitlabProjectId: number, commitSha: string, path: string): Promise<Uint8Array> {
    repositoryPath(path);
    requireCondition(/^[a-f0-9]{40}$/.test(commitSha), 'INVALID_COMMIT', 'Content reads require a fixed commit SHA', 422);
    try { return await this.gitlab.bytes(`/projects/${gitlabProjectId}/repository/files/${encodeURIComponent(path)}/raw?ref=${commitSha}&lfs=false`); }
    catch (error) {
      if (error instanceof DomainError && error.code === 'GITLAB_NOT_FOUND') throw new DomainError('FIXED_FILE_MISSING', 'Referenced file does not exist in the fixed Git commit', 422, { path, commitSha });
      throw error;
    }
  }
  private async manifest(gitlabProjectId: number, commitSha: string): Promise<ProjectManifest> {
    return parseProjectManifest(utf8(await this.file(gitlabProjectId, commitSha, 'project.assets.json'), 'INVALID_MANIFEST_ENCODING'));
  }
  async loadProjectTemplates(actor: Reader, gitlabProjectId: number, commitSha: string): Promise<ProjectTemplates> {
    await this.gitlab.authorize(actor, gitlabProjectId);
    const manifest = await this.manifest(gitlabProjectId, commitSha);
    requireCondition(manifest.gitlabProjectId === gitlabProjectId, 'PROJECT_MANIFEST_IDENTITY_MISMATCH', 'Template manifest must belong to its GitLab project', 422);
    const templates: ProjectTemplates['templates'] = [];
    for (const template of manifest.scenarioTemplates.templates) {
      const bytes = await this.file(gitlabProjectId, commitSha, template.path);
      requireCondition(utf8(bytes, 'INVALID_TEMPLATE_ENCODING').trim().length > 0, 'EMPTY_TEMPLATE', 'Scenario templates must contain Markdown text', 422);
      templates.push({ id: template.id, name: template.name, fixed: { commitSha, path: template.path, sha256: digest(bytes) } });
    }
    return { defaultTemplateId: manifest.scenarioTemplates.defaultTemplateId, templates };
  }
  async verifyTemplate(actor: Reader, gitlabProjectId: number, fixed: FixedReference, templateId?: string): Promise<void> {
    const catalog = await this.loadProjectTemplates(actor, gitlabProjectId, fixed.commitSha);
    requireCondition(catalog.templates.some(t => (!templateId || t.id === templateId) && canonical(t.fixed) === canonical(fixed)), 'TEMPLATE_REFERENCE_MISMATCH', 'Template reference must match a fixed project catalog entry', 422);
  }
  /** Reads business metadata only from the immutable material; callers may hydrate API views with it. */
  async loadMaterial(actor: Reader, gitlabProjectId: number, fixed: FixedReference): Promise<MaterialMetadata> {
    return this.verify(actor, gitlabProjectId, fixed);
  }
  async verify(actor: Reader, gitlabProjectId: number, fixed: FixedReference, identity?: { entityId: string; kind: EntityKind }): Promise<MaterialMetadata> {
    await this.gitlab.authorize(actor, gitlabProjectId);
    const bytes = await this.file(gitlabProjectId, fixed.commitSha, fixed.path);
    requireCondition(digest(bytes) === fixed.sha256, 'CONTENT_HASH_MISMATCH', 'Fixed Git material does not match the confirmed SHA-256', 422);
    const markdown = utf8(bytes, 'INVALID_MATERIAL_ENCODING');
    let metadata: MaterialMetadata;
    if (/^baseline\./.test(fixed.path)) {
      let manifest: unknown;
      try { manifest = JSON.parse(markdown); } catch { throw new DomainError('INVALID_MANIFEST', 'Baseline manifest must be valid JSON', 422); }
      requireCondition(isFixedManifest(manifest), 'INVALID_MANIFEST', 'Baseline manifest does not match the fixed manifest contract', 422);
      metadata = manifest.metadata;
      validateMaterialMetadata(metadata);
    } else metadata = parseMaterial(markdown);
    const expectedPath = metadata.kind === 'scenario' ? `场景/${metadata.entityId}.md` : metadata.kind === 'requirement' ? `需求/${metadata.entityId}.md` : metadata.kind === 'handoff' ? `handoff.${metadata.entityId}.md` : `baseline.${metadata.entityId}.json`;
    requireCondition(fixed.path === expectedPath && (!identity || (metadata.entityId === identity.entityId && metadata.kind === identity.kind)), 'INVALID_MATERIAL_PATH', 'Fixed material identity and path must match its stable entity ID and kind', 422);
    await this.verifyFiles(gitlabProjectId, fixed, metadata);
    if (metadata.kind === 'scenario') {
      await this.verifyTemplate(actor, gitlabProjectId, metadata.templateRef, metadata.templateId);
      // A historical template remains valid, but it must belong to the material history.
      if (metadata.templateRef.commitSha !== fixed.commitSha) {
        const ancestor = await this.gitlab.json<{ id: string }>(`/projects/${gitlabProjectId}/repository/merge_base?refs[]=${metadata.templateRef.commitSha}&refs[]=${fixed.commitSha}`);
        requireCondition(ancestor.id === metadata.templateRef.commitSha, 'TEMPLATE_HISTORY_MISMATCH', 'Bound template must belong to the fixed material history', 422);
      }
    }
    return metadata;
  }
  private async verifyFiles(gitlabProjectId: number, fixed: FixedReference, metadata: MaterialMetadata): Promise<void> {
    const files = new Map([...metadata.businessEvidence.flatMap(e => e.files), ...(metadata.files ?? [])].map(file => [file.path, file]));
    const content = new Map<string, Uint8Array>();
    for (const file of files.values()) {
      requireCondition(file.path !== fixed.path, 'SELF_REFERENCE', 'A material cannot include its own hash in the file manifest', 422);
      const bytes = await this.file(gitlabProjectId, fixed.commitSha, file.path);
      requireCondition(digest(bytes) === file.sha256, 'FILE_HASH_MISMATCH', 'Archived file hash differs from the fixed material reference', 422, { path: file.path });
      content.set(file.path, bytes);
    }
    for (const evidence of metadata.businessEvidence) for (const range of evidence.ranges) {
      const bytes = content.get(range.path);
      requireCondition(bytes, 'EVIDENCE_RANGE_INVALID', 'Evidence range does not refer to an archived file', 422);
      const lines = utf8(bytes, 'INVALID_EVIDENCE_ENCODING').split('\n');
      if (lines.at(-1) === '') lines.pop();
      requireCondition(range.endLine <= lines.length && lines.slice(range.startLine - 1, range.endLine).join('\n').trim().length > 0, 'EVIDENCE_RANGE_INVALID', 'Evidence range must select existing nonempty archived content', 422);
    }
  }
  async verifyCandidate(actor: Reader, gitlabProjectId: number, input: PrepareIntegrationRequest): Promise<Map<string, MaterialMetadata>> {
    await this.gitlab.authorize(actor, gitlabProjectId);
    requireCondition(input.checks.candidateSha === input.candidateSha, 'CHECK_CANDIDATE_MISMATCH', 'Check evidence must bind the exact candidate');
    const requiredChecks = input.stage === 'prototype' ? ['engineering', 'mock', 'browser', 'relations'] : input.stage === 'template' ? ['templates'] : ['materials', 'relations'];
    requireCondition(requiredChecks.every(name => input.checks.checks.some(c => c.name === name && c.passed)), 'CHECKS_REQUIRED', 'Required checks have not passed', 422, { requiredChecks });
    for (const path of input.allowedPaths) {
      repositoryPath(path);
      if (input.stage === 'prototype') requireCondition(path.startsWith('原型代码/'), 'PROTOTYPE_PATH_SCOPE', 'Prototype integration can only change prototype source files', 422);
      if (input.stage === 'template') requireCondition(path === 'project.assets.json' || /^\.template\/[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/.test(path), 'TEMPLATE_PATH_SCOPE', 'Template publication can only change the project catalog and template files', 422);
    }
    const prefix = `/projects/${gitlabProjectId}/repository`;
    const commit = await this.gitlab.json<{ id: string; parent_ids: string[] }>(`${prefix}/commits/${input.candidateSha}`);
    requireCondition(commit.id === input.candidateSha && commit.parent_ids[0] === input.expectedHead, 'CANDIDATE_BASE_MISMATCH', 'Candidate must have the recognized integration head as first parent');
    const candidate = await this.gitlab.json<Compare>(`${prefix}/compare?from=${input.expectedHead}&to=${input.candidateSha}&straight=true`);
    requireCondition(!candidate.compare_timeout && !candidate.compare_same_ref && candidate.diffs.length > 0 && candidate.diffs.every(d => !d.too_large && !d.collapsed), 'INCOMPLETE_DIFF', 'Candidate comparison must be complete and nonempty');
    requireCondition(candidate.diffs.every(d => input.allowedPaths.includes(d.new_path) && input.allowedPaths.includes(d.old_path)), 'CANDIDATE_PATH_SCOPE', 'Candidate changes paths outside the confirmed task scope');
    const source = input.sourceSha === input.candidateSha ? candidate : await this.gitlab.json<Compare>(`${prefix}/compare?from=${input.expectedHead}&to=${input.sourceSha}&straight=true`);
    requireCondition(!source.compare_timeout && source.diffs.every(d => !d.too_large && !d.collapsed), 'INCOMPLETE_DIFF', 'Task source comparison is incomplete');
    const shape = (diffs: Diff[]) => canonical(diffs.map(d => ({ old: d.old_path, path: d.new_path, deleted: d.deleted_file, renamed: d.renamed_file, diff: d.diff })).sort((a, b) => a.path.localeCompare(b.path)));
    requireCondition(shape(source.diffs) === shape(candidate.diffs), 'SOURCE_CANDIDATE_MISMATCH', 'Candidate must contain exactly the confirmed task source changes; rebase and recheck when the recognized head changes');
    const materials = new Map<string, MaterialMetadata>();
    if (input.stage === 'template') {
      await this.verifyTemplateChange(actor, gitlabProjectId, input.expectedHead, input.candidateSha, candidate.diffs);
      return materials;
    }
    const declaredPaths = new Set<string>();
    for (const confirmation of input.confirmations) {
      requireCondition(confirmation.readHash === confirmation.fixed.sha256, 'READ_HASH_MISMATCH', 'Confirmation must bind the final material hash', 422);
      if (input.stage !== 'prototype') requireCondition(confirmation.fixed.commitSha === input.candidateSha && input.allowedPaths.includes(confirmation.fixed.path), 'FIXED_CANDIDATE_MISMATCH', 'Every confirmed document must bind a candidate path');
      const metadata = await this.verify(actor, gitlabProjectId, confirmation.fixed);
      requireCondition(metadata.entityId === confirmation.entityId && !materials.has(metadata.entityId), 'CONFIRMATION_IDENTITY_MISMATCH', 'Every confirmation must identify one distinct fixed material', 422);
      if (input.stage === 'prototype') await this.verify(actor, gitlabProjectId, { ...confirmation.fixed, commitSha: input.candidateSha }, { entityId: metadata.entityId, kind: metadata.kind });
      materials.set(metadata.entityId, metadata);
      declaredPaths.add(confirmation.fixed.path);
      for (const file of [...metadata.businessEvidence.flatMap(e => e.files), ...(metadata.files ?? [])]) declaredPaths.add(file.path);
    }
    if (input.stage !== 'prototype') {
      const materialPaths = new Set(input.confirmations.map(confirmation => confirmation.fixed.path));
      requireCondition(input.allowedPaths.every(path => path !== 'project.assets.json' && !path.startsWith('.template/') && (!/^(?:场景|需求)\/|^(?:baseline|handoff)\./.test(path) || materialPaths.has(path)) && declaredPaths.has(path)), 'MATERIAL_PATH_SCOPE', 'Material integrations may only change their confirmed documents and related files outside protected project paths', 422);
    }
    return materials;
  }
  private async verifyTemplateChange(actor: Reader, gitlabProjectId: number, expectedHead: string, candidateSha: string, diffs: Diff[]): Promise<void> {
    const before = await this.manifest(gitlabProjectId, expectedHead), after = await this.manifest(gitlabProjectId, candidateSha);
    const { scenarioTemplates: oldCatalog, ...oldIdentity } = before, { scenarioTemplates: newCatalog, ...newIdentity } = after;
    requireCondition(canonical(oldIdentity) === canonical(newIdentity), 'TEMPLATE_MANIFEST_SCOPE', 'Template publication cannot change project identity or directory declarations', 422);
    requireCondition(oldCatalog.templates.every(t => newCatalog.templates.some(n => t.id === n.id && t.path === n.path)), 'TEMPLATE_DELETE_FORBIDDEN', 'Published template identities must remain in the project catalog', 422);
    requireCondition(diffs.every(d => !d.deleted_file && !d.renamed_file && (d.new_path === 'project.assets.json' || newCatalog.templates.some(t => t.path === d.new_path))), 'TEMPLATE_PATH_SCOPE', 'Template publication cannot delete templates or change files outside the catalog', 422);
    await this.loadProjectTemplates(actor, gitlabProjectId, candidateSha);
  }
  async verifyCorrection(actor: Reader, gitlabProjectId: number, expectedHead: string, correctedHead: string): Promise<void> {
    await this.gitlab.authorize(actor, gitlabProjectId);
    const prefix = `/projects/${gitlabProjectId}/repository`;
    const commit = await this.gitlab.json<{ parent_ids: string[] }>(`${prefix}/commits/${correctedHead}`);
    requireCondition(commit.parent_ids.length > 0, 'CORRECTION_REQUIRED', 'Correction must be a traceable commit');
    requireCondition(expectedHead !== correctedHead, 'CORRECTION_REQUIRED', 'Correction requires a new traceable commit');
    const ancestor = await this.gitlab.json<{ id: string }>(`${prefix}/merge_base?refs[]=${expectedHead}&refs[]=${correctedHead}`);
    requireCondition(ancestor.id === expectedHead, 'CORRECTION_ANCESTRY_MISMATCH', 'Correction must preserve recognized commit history without rewriting it');
    const comparison = await this.gitlab.json<{ compare_timeout?: boolean; diffs: unknown[] }>(`${prefix}/compare?from=${expectedHead}&to=${correctedHead}&straight=true`);
    requireCondition(!comparison.compare_timeout && comparison.diffs.length === 0, 'CORRECTION_TREE_MISMATCH', 'Corrected branch must contain exactly the previously recognized tree');
  }
}
