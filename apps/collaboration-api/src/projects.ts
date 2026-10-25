import { randomUUID } from 'node:crypto';
import { DomainError, GENERAL_SCENARIO_SUMMARY, GENERAL_SCENARIO_TITLE, repositoryPath, requireCondition } from '@eadp/asset-domain';
import type { CreateProjectRequest, InitializeProjectRequest, ProjectView } from '@eadp/contracts';
import type { GitLab, GitLabProject } from './auth/gitlab.js';
import type { Actor } from './auth/session.js';
import { transaction, transactionOn, type Database } from './persistence/database.js';
import * as repository from './persistence/repository.js';
import { verifyProjectInitialization } from './project-initialization.js';

interface Creation {
  key: string; request_hash: string; project_id: string; namespace_id: string;
  namespace_path: string; path: string; name: string; marker: string;
  state: 'reserved' | 'creating' | 'created' | 'assigned' | 'ready'; gitlab_project_id: string | null;
}
export class Projects {
  constructor(private readonly database: Database, private readonly gitlab: GitLab) {}
  private async creation(actor: Actor, key: string): Promise<Creation | undefined> {
    return (await this.database.query<Creation>('SELECT *,id AS project_id FROM studio_projects WHERE creator_id=$1 AND key=$2', [actor.id, key])).rows[0];
  }
  private matches(creation: Creation, input: CreateProjectRequest) {
    requireCondition(creation.request_hash === repository.requestHash(input), 'IDEMPOTENCY_CONFLICT', 'This project creation key already belongs to another request', 409);
  }
  private owned(remote: GitLabProject, creation: Creation) {
    requireCondition(remote.namespace.id === Number(creation.namespace_id) && remote.namespace.full_path === creation.namespace_path && remote.path === creation.path && remote.description === creation.marker && remote.visibility === 'private', 'PROJECT_PATH_OCCUPIED', 'The requested GitLab path belongs to a different or unverifiable project', 409);
    if (creation.gitlab_project_id !== null) requireCondition(remote.id === Number(creation.gitlab_project_id), 'PROJECT_IDENTITY_CHANGED', 'The created GitLab repository identity changed', 409);
  }
  create(actor: Actor, input: CreateProjectRequest): Promise<ProjectView> {
    return repository.withContext({ actor }, () => this.createProject(actor, input));
  }
  private async createProject(actor: Actor, input: CreateProjectRequest): Promise<ProjectView> {
    repositoryPath(input.path);
    let creation = await this.creation(actor, input.idempotencyKey);
    if (creation) this.matches(creation, input);
    else {
      const namespace = await this.gitlab.namespace(actor, input.namespaceId);
      const id = randomUUID(), marker = `eadp-studio:${randomUUID()}`;
      await this.database.query('INSERT INTO studio_projects(creator_id,key,request_hash,id,namespace_id,namespace_path,path,name,marker,state,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,\'reserved\',$10,$11,$1,$10,$11) ON CONFLICT(creator_id,key) DO NOTHING', [actor.id, input.idempotencyKey, repository.requestHash(input), id, namespace.id, namespace.fullPath, input.path, input.name, marker, actor.username, actor.name]);
      creation = await this.creation(actor, input.idempotencyKey);
      requireCondition(creation, 'PROJECT_CREATION_UNKNOWN', 'The project request has not been recorded; query or retry the same key', 503); this.matches(creation, input);
    }
    // Session advisory locks are released if the process/connection dies. No
    // database transaction spans HTTP, and retries do not depend on lease TTLs.
    const connection = await this.database.connect(), lockKey = `studio-project-create:${creation.project_id}`;
    let held = false;
    try {
      const acquired = await connection.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [lockKey]);
      requireCondition(acquired.rows[0]?.acquired, 'PROJECT_CREATION_IN_PROGRESS', 'The same project request is still running; retry its original key', 503, { projectId: creation.project_id });
      held = true;
      creation = (await connection.query<Creation>('SELECT *,id AS project_id FROM studio_projects WHERE creator_id=$1 AND key=$2', [actor.id, input.idempotencyKey])).rows[0];
      requireCondition(creation, 'PROJECT_CREATION_UNKNOWN', 'The recorded project request is unavailable', 503);
      if (creation.state === 'assigned' || creation.state === 'ready') {
        const project = await repository.project(connection, creation.project_id);
        const remote = await this.gitlab.authorize(actor, project.gitlabProjectId, true);
        requireCondition(remote.http_url_to_repo === project.repositoryUrl, 'PROJECT_REPOSITORY_CHANGED', 'The created GitLab repository path changed', 409); return project;
      }
      let remote: GitLabProject;
      if (creation.gitlab_project_id !== null) {
        remote = await this.gitlab.project(Number(creation.gitlab_project_id)); this.owned(remote, creation);
      } else {
        // A fixed path and a persisted marker distinguish a lost create
        // response from an unrelated repository with the same name.
        const existing = await this.gitlab.projectAt(`${creation.namespace_path}/${creation.path}`);
        if (existing) { this.owned(existing, creation); remote = existing; }
        else {
          // Revalidate the user's own create authority immediately before the
          // management request. The management token's admin role is irrelevant.
          const namespace = await this.gitlab.namespace(actor, Number(creation.namespace_id));
          requireCondition(namespace.fullPath === creation.namespace_path, 'NAMESPACE_IDENTITY_CHANGED', 'The selected GitLab namespace path changed', 409);
          await connection.query('UPDATE studio_projects SET state=\'creating\',last_editor_id=$1,last_editor_account=$3,last_editor_name=$4 WHERE creator_id=$1 AND key=$2', [actor.id, input.idempotencyKey, actor.username, actor.name]);
          try { remote = await this.gitlab.createProject(creation.name, creation.path, Number(creation.namespace_id), creation.marker); }
          catch (error) {
            // The POST may have succeeded despite a timeout or a conflict. A
            // failed lookup keeps the durable request pending for the same key.
            const resolved = await this.gitlab.projectAt(`${creation.namespace_path}/${creation.path}`).catch(() => null);
            if (!resolved) throw new DomainError('PROJECT_CREATION_UNKNOWN', 'GitLab project creation is not verified; retry the original request key', 503, { projectId: creation.project_id });
            this.owned(resolved, creation); remote = resolved;
          }
          this.owned(remote, creation);
        }
      }
      const pending: ProjectView = { id: creation.project_id, gitlabProjectId: remote.id, repositoryUrl: remote.http_url_to_repo, stableBranch: 'main', name: creation.name, namespaceId: Number(creation.namespace_id), namespacePath: creation.namespace_path, initializationStatus: 'pending', recognizedHead: null, revision: 0 };
      await transactionOn(connection, async () => {
        const c = connection;
        const locked = (await c.query<Creation>('SELECT *,id AS project_id FROM studio_projects WHERE creator_id=$1 AND key=$2 FOR UPDATE', [actor.id, input.idempotencyKey])).rows[0];
        requireCondition(locked, 'PROJECT_CREATION_UNKNOWN', 'The recorded project request is unavailable', 503);
        requireCondition(locked.gitlab_project_id === null || Number(locked.gitlab_project_id) === remote.id, 'PROJECT_IDENTITY_CHANGED', 'The recorded GitLab project identity changed', 409);
        await c.query('UPDATE studio_projects SET state=\'created\',gitlab_project_id=$3,repository_url=$4,last_editor_id=$1,last_editor_account=$5,last_editor_name=$6 WHERE creator_id=$1 AND key=$2', [actor.id, input.idempotencyKey, remote.id, remote.http_url_to_repo, actor.username, actor.name]);
      });
      // Grant failure leaves the project pending and the creation record at
      // 'created'. A retry checks the same repository and membership first.
      const namespace = await this.gitlab.namespace(actor, Number(creation.namespace_id));
      requireCondition(namespace.fullPath === creation.namespace_path, 'NAMESPACE_IDENTITY_CHANGED', 'The selected GitLab namespace path changed', 409);
      await this.gitlab.grantCreator(actor, remote.id);
      await transactionOn(connection, async () => {
        const c = connection;
        await c.query('UPDATE studio_projects SET state=\'assigned\',last_editor_id=$1,last_editor_account=$4,last_editor_name=$5 WHERE creator_id=$1 AND key=$2 AND gitlab_project_id=$3', [actor.id, input.idempotencyKey, remote.id, actor.username, actor.name]);
        // 通用场景身份随项目分配事务预留，占用项目内第一个场景编号 SC-0001
        await c.query("INSERT INTO studio_project_counters(project_id,kind) VALUES($1,'scenario') ON CONFLICT(project_id,kind) DO NOTHING", [pending.id]);
        const reserved = await c.query<{ sequence: string }>("UPDATE studio_project_counters SET next_sequence=next_sequence+1 WHERE project_id=$1 AND kind='scenario' RETURNING next_sequence-1 AS sequence", [pending.id]);
        const sequence = Number(reserved.rows[0]!.sequence);
        await c.query(`INSERT INTO studio_entity_numbers(project_id,kind,sequence,code,operation_key,entity_id,request_hash,creator_id,creator_account,creator_name) VALUES($1,'scenario',$2,$3,'general-scenario',$4,$5,$6,$7,$8) ON CONFLICT(project_id,operation_key) DO NOTHING`,
          [pending.id, sequence, `SC-${String(sequence).padStart(4, '0')}`, randomUUID(), repository.requestHash({ generalScenario: pending.id }), actor.id, actor.username, actor.name]);
        await repository.audit(c, pending.id, actor, 'project.created', { gitlabProjectId: remote.id, namespaceId: pending.namespaceId });
      });
      return await repository.project(connection, pending.id);
    } finally {
      let broken = false;
      try { if (held) await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]); }
      catch { broken = true; }
      connection.release(broken);
    }
  }
  initialize(actor: Actor, projectId: string, input: InitializeProjectRequest): Promise<ProjectView> {
    return repository.withContext({ actor }, () => this.initializeProject(actor, projectId, input));
  }
  private async initializeProject(actor: Actor, projectId: string, input: InitializeProjectRequest): Promise<ProjectView> {
    const project = await transaction(this.database, c => repository.project(c, projectId));
    const remote = await this.gitlab.authorize(actor, project.gitlabProjectId, true);
    requireCondition(remote.http_url_to_repo === project.repositoryUrl && remote.namespace.id === project.namespaceId && remote.namespace.full_path === project.namespacePath, 'PROJECT_REPOSITORY_CHANGED', 'The created GitLab repository path changed', 409);
    const assignment = (await this.database.query<{ state: string }>('SELECT state FROM studio_projects WHERE id=$1', [projectId])).rows[0];
    requireCondition(assignment?.state === 'assigned' || assignment?.state === 'ready', 'PROJECT_CREATOR_ASSIGNMENT_PENDING', 'Finish the original project creation request before initialization', 409);
    const previous = await transaction(this.database, c => repository.previous(c, projectId, actor, 'project.initialize', input));
    if (previous.found) {
      requireCondition(project.initializationStatus === 'ready' && project.recognizedHead === input.commitSha, 'PROJECT_INITIALIZATION_CHANGED', 'The initialized project has advanced; query the current project state', 409);
      requireCondition(await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === project.recognizedHead, 'INITIALIZATION_HEAD_MISMATCH', 'The initialized stable branch head changed', 409); return project;
    }
    requireCondition(project.initializationStatus === 'pending' && project.recognizedHead === null, 'PROJECT_ALREADY_INITIALIZED', 'The project is already initialized', 409);
    const { generalFixed } = await verifyProjectInitialization(this.gitlab, actor, project, input.commitSha);
    return transaction(this.database, async c => {
      const current = await repository.project(c, projectId, true), replay = await repository.previous(c, projectId, actor, 'project.initialize', input);
      if (replay.found) return replay.result as ProjectView;
      requireCondition(current.initializationStatus === 'pending' && current.recognizedHead === null, 'PROJECT_ALREADY_INITIALIZED', 'The project is already initialized', 409);
      const reserved = current.generalScenario;
      requireCondition(reserved, 'GENERAL_SCENARIO_UNRESERVED', 'The project has no reserved general scenario identity', 409);
      const initializationId = randomUUID(), confirmationId = randomUUID();
      await c.query(`INSERT INTO studio_project_initializations(id,project_id,operation_key,request_hash,commit_sha,creator_id,creator_account,creator_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [initializationId, projectId, input.idempotencyKey, repository.requestHash(input), input.commitSha, actor.id, actor.username, actor.name]);
      const sequence = Number((await c.query<{ sequence: string }>('SELECT sequence FROM studio_entity_numbers WHERE project_id=$1 AND entity_id=$2', [projectId, reserved.entityId])).rows[0]!.sequence);
      // 实体与确认记录互相引用：先写实体，写确认，再回填 current_confirmation_id（外键均非延迟）
      await c.query(`INSERT INTO studio_entities(project_id,id,kind,builtin_key,sequence,code,title,summary,revision,generation,material_version,confirmation_status,task_status,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name) VALUES($1,$2,'scenario','general',$3,$4,$5,$6,1,0,1,'confirmed','idle',$7,$8,$9,$7,$8,$9)`,
        [projectId, reserved.entityId, sequence, reserved.code, GENERAL_SCENARIO_TITLE, GENERAL_SCENARIO_SUMMARY, actor.id, actor.username, actor.name]);
      await c.query(`INSERT INTO studio_confirmations(id,project_id,entity_id,version,stage,revision,title,summary,commit_sha,path,sha256,acceptance_kind,initialization_id,source_count) VALUES($1,$2,$3,1,'material',1,$4,$5,$6,$7,$8,'system-provisioned',$9,0)`,
        [confirmationId, projectId, reserved.entityId, GENERAL_SCENARIO_TITLE, GENERAL_SCENARIO_SUMMARY, generalFixed.commitSha, generalFixed.path, generalFixed.sha256, initializationId]);
      await c.query('UPDATE studio_entities SET current_confirmation_id=$3 WHERE project_id=$1 AND id=$2', [projectId, reserved.entityId, confirmationId]);
      current.initializationStatus = 'ready'; current.recognizedHead = input.commitSha; current.revision++;
      await repository.saveProject(c, current);
      await repository.remember(c, projectId, actor, 'project.initialize', input, current);
      return current;
    });
  }
}
