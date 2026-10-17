import { createHash } from 'node:crypto';
import { canonical, parseMaterial, repositoryPath, requireCondition } from '@eadp/asset-domain';
import { isFixedManifest, type FixedReference, type MaterialMetadata, type PrepareIntegrationRequest } from '@eadp/contracts';
import { GitLab } from './auth/gitlab.js';
import type { Actor } from './auth/session.js';

export class GitLabContent {
  constructor(private readonly gitlab: GitLab) {}
  async verify(actor: Actor, gitlabProjectId: number, fixed: FixedReference, metadata: MaterialMetadata): Promise<void> {
    await this.gitlab.authorize(actor, gitlabProjectId);
    repositoryPath(fixed.path);
    const expectedPath = metadata.kind === 'scenario' ? `场景/${metadata.entityId}.md` : metadata.kind === 'requirement' ? `需求/${metadata.entityId}.md` : metadata.kind === 'handoff' ? `handoff.${metadata.entityId}.md` : `baseline.${metadata.entityId}.json`;
    requireCondition(fixed.path === expectedPath, 'INVALID_MATERIAL_PATH', 'Fixed material path must match its stable entity ID and kind', 422);
    const bytes = await this.gitlab.bytes(`/projects/${gitlabProjectId}/repository/files/${encodeURIComponent(fixed.path)}/raw?ref=${fixed.commitSha}&lfs=false`);
    requireCondition(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) && !bytes.includes(13), 'INVALID_MATERIAL_ENCODING', 'Material must use UTF-8 without BOM and LF line endings', 422);
    requireCondition(createHash('sha256').update(bytes).digest('hex') === fixed.sha256, 'CONTENT_HASH_MISMATCH', 'Fixed Git material does not match the confirmed SHA-256', 422);
    let markdown: string;
    try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { requireCondition(false, 'INVALID_MATERIAL_ENCODING', 'Material is not valid UTF-8', 422); }
    let actual: MaterialMetadata;
    if (metadata.kind === 'baseline') {
      let manifest: unknown;
      try { manifest = JSON.parse(markdown!); } catch { requireCondition(false, 'INVALID_MANIFEST', 'Baseline manifest must be valid JSON', 422); }
      requireCondition(isFixedManifest(manifest), 'INVALID_MANIFEST', 'Baseline manifest does not match the fixed manifest contract', 422);
      actual = manifest.metadata;
      requireCondition(actual.coreRulesPresent && actual.acceptanceCriteriaPresent && !actual.openQuestions.some(q => q.blocking), 'CORE_UNRESOLVED', 'Baseline manifest has unresolved core criteria', 422);
    } else actual = parseMaterial(markdown!);
    requireCondition(canonical(actual) === canonical(metadata), 'METADATA_MISMATCH', 'Fixed Git material metadata differs from the submitted control metadata', 422);
  }
  async verifyCandidate(actor: Actor, gitlabProjectId: number, input: PrepareIntegrationRequest): Promise<void> {
    await this.gitlab.authorize(actor, gitlabProjectId);
    requireCondition(input.checks.candidateSha === input.candidateSha, 'CHECK_CANDIDATE_MISMATCH', 'Check evidence must bind the exact candidate');
    const requiredChecks = input.stage === 'prototype' ? ['engineering', 'mock', 'browser', 'relations'] : ['materials', 'relations'];
    requireCondition(requiredChecks.every(name => input.checks.checks.some(c => c.name === name && c.passed)), 'CHECKS_REQUIRED', 'Required checks have not passed', 422, { requiredChecks });
    for (const path of input.allowedPaths) {
      repositoryPath(path);
      if (input.stage === 'prototype') requireCondition(path.startsWith('原型代码/'), 'PROTOTYPE_PATH_SCOPE', 'Prototype integration can only change prototype source files', 422);
      if (input.stage !== 'prototype') requireCondition(/^(场景|需求)\/.+\.md$/.test(path) || path === 'project.assets.json' || /^(?:baseline\.[A-Za-z0-9_.-]+\.json|handoff\.[A-Za-z0-9_.-]+\.md)$/.test(path), 'MATERIAL_PATH_SCOPE', 'Material integration can only change controlled documents and evidence', 422);
    }
    const prefix = `/projects/${gitlabProjectId}/repository`;
    const commit = await this.gitlab.json<{ id: string; parent_ids: string[] }>(`${prefix}/commits/${input.candidateSha}`);
    requireCondition(commit.id === input.candidateSha && commit.parent_ids[0] === input.expectedHead, 'CANDIDATE_BASE_MISMATCH', 'Candidate must have the recognized integration head as first parent');
    type Diff = { old_path: string; new_path: string; deleted_file: boolean; renamed_file: boolean; too_large?: boolean; collapsed?: boolean; diff: string };
    type Compare = { compare_timeout?: boolean; compare_same_ref?: boolean; diffs: Diff[] };
    const candidate = await this.gitlab.json<Compare>(`${prefix}/compare?from=${input.expectedHead}&to=${input.candidateSha}&straight=true`);
    requireCondition(!candidate.compare_timeout && !candidate.compare_same_ref && candidate.diffs.length > 0 && candidate.diffs.every(d => !d.too_large && !d.collapsed), 'INCOMPLETE_DIFF', 'Candidate comparison must be complete and nonempty');
    requireCondition(candidate.diffs.every(d => input.allowedPaths.includes(d.new_path) && input.allowedPaths.includes(d.old_path)), 'CANDIDATE_PATH_SCOPE', 'Candidate changes paths outside the confirmed task scope');
    const source = input.sourceSha === input.candidateSha ? candidate : await this.gitlab.json<Compare>(`${prefix}/compare?from=${input.expectedHead}&to=${input.sourceSha}&straight=true`);
    requireCondition(!source.compare_timeout && source.diffs.every(d => !d.too_large && !d.collapsed), 'INCOMPLETE_DIFF', 'Task source comparison is incomplete');
    const shape = (diffs: Diff[]) => canonical(diffs.map(d => ({ old: d.old_path, path: d.new_path, deleted: d.deleted_file, renamed: d.renamed_file, diff: d.diff })).sort((a,b) => a.path.localeCompare(b.path)));
    requireCondition(shape(source.diffs) === shape(candidate.diffs), 'SOURCE_CANDIDATE_MISMATCH', 'Candidate must contain exactly the confirmed task source changes; rebase and recheck when the recognized head changes');
    for (const confirmation of input.confirmations) {
      if (input.stage === 'prototype') {
        // The requirement remains the accepted input, not a newly confirmed document.
        // Verify its fixed bytes and require the same bytes in the precise candidate.
        await this.verify(actor, gitlabProjectId, confirmation.fixed, confirmation.metadata);
        await this.verify(actor, gitlabProjectId, { ...confirmation.fixed, commitSha: input.candidateSha }, confirmation.metadata);
      } else {
        requireCondition(confirmation.fixed.commitSha === input.candidateSha && input.allowedPaths.includes(confirmation.fixed.path), 'FIXED_CANDIDATE_MISMATCH', 'Every confirmed document must bind a candidate path');
        await this.verify(actor, gitlabProjectId, confirmation.fixed, confirmation.metadata);
      }
    }
  }
  async verifyCorrection(actor: Actor, gitlabProjectId: number, expectedHead: string, correctedHead: string): Promise<void> {
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
