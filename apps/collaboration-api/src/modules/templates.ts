import { requireCondition } from '@eadp/asset-domain';
import type { BindTemplateRequest, EntityView, ProjectView } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { GitLab } from '../auth/gitlab.js';
import type { GitLabContent } from '../gitlab-content.js';
import type { Transaction } from '../persistence/database.js';
import { audit, saveEntity } from '../persistence/repository.js';
import { assertOccupation } from './occupations.js';

/** Historical templates are selectable only from the project's accepted Git history. */
export async function verifyBinding(gitlab: GitLab, content: GitLabContent, actor: Actor, project: ProjectView, kind: 'scenario' | 'requirement', input: BindTemplateRequest) {
  requireCondition(project.recognizedHead, 'PROJECT_NOT_INITIALIZED', 'Initialize the project before selecting a template');
  const ancestor = await gitlab.json<{ id: string }>(`/projects/${project.gitlabProjectId}/repository/merge_base?refs[]=${input.templateRef.commitSha}&refs[]=${project.recognizedHead}`);
  requireCondition(ancestor.id === input.templateRef.commitSha, 'TEMPLATE_HISTORY_MISMATCH', 'Select a template from the accepted project history');
  await content.verifyTemplate(actor, project.gitlabProjectId, kind, input.templateRef, input.templateId);
}

export async function bind(c: Transaction, projectId: string, value: EntityView, actor: Actor, input: BindTemplateRequest) {
  const occupation = assertOccupation(value, input.token, actor);
  requireCondition((value.kind === 'scenario' || value.kind === 'requirement') && !value.builtinKey && occupation.purpose === 'design', 'TEMPLATE_BINDING_REQUIRES_DESIGN', 'Template binding requires an owned material design task');
  requireCondition(!(await c.query("SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared' AND occupation_id=$2", [projectId, occupation.occupationId])).rowCount,
    'INTEGRATION_PENDING', 'Reconcile the prepared confirmation before changing its template');
  requireCondition(!(await c.query("SELECT id FROM studio_repair_tasks WHERE project_id=$1 AND entity_id=$2 AND status IN ('active','paused')", [projectId, value.id])).rowCount,
    'REPAIR_ALREADY_ACTIVE', 'Terminate the current repair authorization before changing its template');
  value.templateId = input.templateId; value.templateRef = input.templateRef;
  value.revision++; occupation.expectedRevision = value.revision;
  await saveEntity(c, projectId, value);
  await audit(c, projectId, actor, 'material.template-bound', { entityId: value.id, templateId: input.templateId, templateRef: input.templateRef });
  return value;
}
