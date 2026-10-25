import { createHash } from 'node:crypto';
import { canonical, generalScenarioDocument, parseProjectManifest, requireCondition } from '@eadp/asset-domain';
import type { FixedReference, ProjectView } from '@eadp/contracts';
import type { GitLab } from './auth/gitlab.js';
import type { Actor } from './auth/session.js';
import { GitLabContent } from './gitlab-content.js';
const directories = ['场景', '需求', '交接', '原型代码'];
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export async function verifyProjectInitialization(gitlab: GitLab, actor: Actor, project: ProjectView, commitSha: string): Promise<{ generalFixed: FixedReference }> {
  await gitlab.authorize(actor, project.gitlabProjectId, true);
  requireCondition(await gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === commitSha, 'INITIALIZATION_HEAD_MISMATCH', 'The stable branch has not reached the exact initialization commit', 409);
  const prefix = `/projects/${project.gitlabProjectId}/repository`;
  const commit = await gitlab.json<unknown>(`${prefix}/commits/${commitSha}`);
  requireCondition(record(commit) && commit.id === commitSha && Array.isArray(commit.parent_ids) && commit.parent_ids.length === 0, 'INITIALIZATION_ROOT_COMMIT_REQUIRED', 'Initialization requires the first root commit of the empty project', 422);
  const entries = await gitlab.list(`${prefix}/tree?ref=${commitSha}`), byName = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    requireCondition(record(entry) && typeof entry.name === 'string' && entry.path === entry.name && !byName.has(entry.name), 'INITIALIZATION_TREE_INVALID', 'The initialization root tree is incomplete or invalid', 422);
    byName.set(entry.name, entry);
  }
  for (const directory of directories) {
    const entry = byName.get(directory);
    requireCondition(entry?.type === 'tree' && entry.mode === '040000' && typeof entry.id === 'string' && /^[a-f0-9]{40}$/.test(entry.id), 'INITIALIZATION_DIRECTORIES_REQUIRED', 'Initialization requires the versioned business directories', 422);
  }
  requireCondition(byName.get('.template')?.type === 'tree', 'INITIALIZATION_TEMPLATES_REQUIRED', 'Initialization requires versioned project scenario templates', 422);
  const manifestEntry = byName.get('project.assets.json');
  requireCondition(manifestEntry?.type === 'blob' && ['100644', '100755'].includes(manifestEntry.mode as string) && typeof manifestEntry.id === 'string' && /^[a-f0-9]{40}$/.test(manifestEntry.id), 'INITIALIZATION_MANIFEST_REQUIRED', 'Initialization requires a regular project manifest blob', 422);
  const bytes = await gitlab.bytes(`${prefix}/blobs/${manifestEntry.id}/raw`, 256 * 1024);
  requireCondition(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === manifestEntry.id, 'INITIALIZATION_MANIFEST_MISMATCH', 'Initialization manifest bytes differ from the fixed Git blob', 422);
  requireCondition(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) && !bytes.includes(13), 'INVALID_MANIFEST_ENCODING', 'Project manifest must use UTF-8 without BOM and LF line endings', 422);
  let manifest: ReturnType<typeof parseProjectManifest>;
  try { manifest = parseProjectManifest(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { requireCondition(false, 'INITIALIZATION_MANIFEST_INVALID', 'Project manifest is not valid UTF-8 JSON', 422); }
  requireCondition(record(manifest) && manifest.schemaVersion === 1 && manifest.projectId === project.id && manifest.gitlabProjectId === project.gitlabProjectId && manifest.repositoryUrl === project.repositoryUrl && manifest.stableBranch === project.stableBranch && canonical(manifest.directories) === canonical(directories), 'INITIALIZATION_MANIFEST_MISMATCH', 'Project manifest identity or directory contract differs from its registered project', 422);
  // 新的初始化必须声明 `.template/` 下随项目版本化的场景与需求模板目录。
  requireCondition(manifest.scenarioTemplates && manifest.requirementTemplates, 'INITIALIZATION_TEMPLATES_REQUIRED', 'Initialization must declare the project scenario and requirement template catalogs', 422);
  await new GitLabContent(gitlab).loadProjectTemplates(actor, project.gitlabProjectId, commitSha);
  const scenarioEntries = await gitlab.list(`${prefix}/tree?ref=${commitSha}&path=${encodeURIComponent('场景')}`);
  const generalEntry = scenarioEntries.find((entry): entry is Record<string, unknown> => record(entry) && entry.name === '通用场景.md' && entry.type === 'blob');
  requireCondition(generalEntry && typeof generalEntry.id === 'string' && /^[a-f0-9]{40}$/.test(generalEntry.id), 'GENERAL_SCENARIO_REQUIRED', 'Initialization requires the provisioned general scenario document', 422);
  const generalBytes = await gitlab.bytes(`${prefix}/blobs/${generalEntry.id}/raw`, 64 * 1024);
  requireCondition(createHash('sha1').update(`blob ${generalBytes.length}\0`).update(generalBytes).digest('hex') === generalEntry.id, 'GENERAL_SCENARIO_MISMATCH', 'General scenario bytes differ from the fixed Git blob', 422);
  requireCondition(!(generalBytes[0] === 0xef && generalBytes[1] === 0xbb && generalBytes[2] === 0xbf) && !generalBytes.includes(13), 'GENERAL_SCENARIO_MISMATCH', 'General scenario must use UTF-8 without BOM and LF line endings', 422);
  requireCondition(project.generalScenario, 'GENERAL_SCENARIO_UNRESERVED', 'The project has no reserved general scenario identity', 409);
  const generalText = new TextDecoder('utf-8', { fatal: true }).decode(generalBytes);
  requireCondition(generalText === generalScenarioDocument(project.generalScenario.entityId), 'GENERAL_SCENARIO_MISMATCH', 'General scenario content does not match the reserved identity and provisioned document', 422);
  requireCondition(await gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === commitSha, 'INITIALIZATION_HEAD_MISMATCH', 'The stable branch changed during initialization verification', 409);
  return { generalFixed: { commitSha, path: '场景/通用场景.md', sha256: createHash('sha256').update(generalBytes).digest('hex') } };
}
