import { DomainError, repositoryPath, requireCondition } from '@eadp/asset-domain';
import type { NamespaceView } from '@eadp/contracts';
import type { Config } from '../config.js';
import type { Actor } from './session.js';

export interface GitLabUser { id: number; username: string; state: 'active'; email?: string }
export interface GitLabProject { id: number; name: string; path: string; path_with_namespace: string; http_url_to_repo: string; default_branch: string | null; namespace: { id: number; full_path: string }; visibility: string; description: string | null; archived?: boolean }
interface Member { id: number; state: string; access_level: number; expires_at: string | null; membership_state?: string }
interface Group { id: number; name: string; full_path: string; project_creation_level: string; marked_for_deletion_on?: string | null; marked_for_deletion_at?: string | null }
const sha = /^[a-f0-9]{40}$/;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function valid(condition: unknown): asserts condition { requireCondition(condition, 'GITLAB_INVALID_RESPONSE', 'GitLab returned an invalid response', 502); }
function numericId(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
export class GitLab {
  constructor(private readonly config: Config) {}
  private async read(response: Response, maximum: number): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    requireCondition(reader, 'GITLAB_EMPTY_RESPONSE', 'GitLab returned an empty response', 502);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length;
        requireCondition(size <= maximum, 'GITLAB_RESOURCE_TOO_LARGE', 'GitLab resource exceeds the allowed size', 422);
        chunks.push(next.value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); if (error instanceof DomainError) throw error; throw new DomainError('GITLAB_UNAVAILABLE', 'GitLab content read failed or timed out', 502); }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
  }
  private async response(path: string, method = 'GET', body?: unknown): Promise<Response> {
    requireCondition(this.config.gitlabToken && !/[\r\n]/.test(this.config.gitlabToken), 'GITLAB_NOT_CONFIGURED', 'The backend GitLab management credential is not configured', 503);
    requireCondition(path.startsWith('/') && !path.startsWith('//') && !path.includes('\\'), 'INVALID_GITLAB_PATH', 'Invalid GitLab API path', 500);
    let response: Response;
    try { response = await fetch(`${this.config.gitlabUrl}/api/v4${path}`, { method, headers: { 'PRIVATE-TOKEN': this.config.gitlabToken, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new DomainError('GITLAB_UNAVAILABLE', 'GitLab request failed or timed out; its result may be unknown', 502); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404) throw new DomainError('GITLAB_NOT_FOUND', 'GitLab did not resolve the requested resource', 404);
      if (response.status === 401) throw new DomainError('GITLAB_MANAGEMENT_DENIED', 'GitLab did not authenticate the backend management credential', 503);
      if (response.status === 403) throw new DomainError('GITLAB_RESOURCE_DENIED', 'GitLab did not authorize the requested resource operation', 503);
      if (response.status === 429) throw new DomainError('GITLAB_RATE_LIMITED', 'GitLab temporarily limited requests', 503);
      if (response.status === 400 || response.status === 409 || response.status === 422) throw new DomainError('GITLAB_REQUEST_REJECTED', 'GitLab rejected the requested operation; verify its recorded result before retrying', 409);
      throw new DomainError('GITLAB_UNAVAILABLE', 'GitLab could not complete the operation; its result may be unknown', 502);
    }
    return response;
  }
  async bytes(path: string, maximum = 2 * 1024 * 1024): Promise<Uint8Array> { return this.read(await this.response(path), maximum); }
  private parse<T>(bytes: Uint8Array): T {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T; }
    catch { throw new DomainError('GITLAB_INVALID_RESPONSE', 'GitLab returned an invalid response', 502); }
  }
  async json<T>(path: string, method = 'GET', body?: unknown): Promise<T> { return this.parse<T>(await this.read(await this.response(path, method, body), 10 * 1024 * 1024)); }
  async list(path: string): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.response(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const items: unknown = this.parse(await this.read(response, 10 * 1024 * 1024)); valid(Array.isArray(items));
      result.push(...items);
      requireCondition(result.length <= 10000, 'GITLAB_LIST_INCOMPLETE', 'GitLab listing exceeded its verification budget', 422);
      const next = response.headers.get('x-next-page');
      if (next === '') return result;
      if (next !== null) { valid(next === String(page + 1)); continue; }
      // Older instances may omit pagination headers. A full page is never
      // treated as proof that the result set ended.
      if (items.length < 100) return result;
    }
    throw new DomainError('GITLAB_LIST_INCOMPLETE', 'GitLab listing completeness could not be established', 422);
  }
  private checkedUser(raw: unknown): GitLabUser {
    valid(record(raw) && numericId(raw.id) && typeof raw.username === 'string' && raw.username.length > 0);
    requireCondition(raw.state === 'active' && raw.locked !== true && raw.bot !== true, 'GITLAB_USER_INACTIVE', 'The bound GitLab user is blocked, pending or unavailable', 403);
    valid(raw.email === undefined || raw.email === null || typeof raw.email === 'string');
    return { id: raw.id, username: raw.username, state: 'active', ...(typeof raw.email === 'string' && raw.email ? { email: raw.email } : {}) };
  }
  async user(id: number): Promise<GitLabUser> {
    requireCondition(numericId(id), 'GITLAB_BINDING_REQUIRED', 'A verified numeric GitLab user binding is required', 403);
    const raw = await this.json<unknown>(`/users/${id}`), user = this.checkedUser(raw);
    valid(user.id === id); return user;
  }
  async resolveUser(lookup: string): Promise<GitLabUser> {
    const exactMatch = (raw: unknown) => record(raw) && (raw.username === lookup || raw.email === lookup || raw.public_email === lookup);
    const identity = await this.json<unknown>('/user'), authenticatedUser = this.checkedUser(identity);
    if (exactMatch(identity)) return authenticatedUser;
    const candidates = await this.list(`/users?${lookup.includes('@') ? 'search' : 'username'}=${encodeURIComponent(lookup)}`);
    const matches = candidates.filter(exactMatch);
    requireCondition(matches.length === 1, 'GITLAB_BINDING_UNRESOLVED', 'The configured existing GitLab user must resolve to exactly one exact match', 503);
    return this.checkedUser(matches[0]);
  }
  private async member(scope: 'projects' | 'groups', id: number, userId: number, inherited = true): Promise<Member | null> {
    let raw: unknown;
    try { raw = await this.json(`/${scope}/${id}/members/${inherited ? 'all/' : ''}${userId}`); }
    catch (error) { if (error instanceof DomainError && (error.code === 'GITLAB_NOT_FOUND' || (scope === 'groups' && error.code === 'GITLAB_RESOURCE_DENIED'))) return null; throw error; }
    valid(record(raw) && raw.id === userId && typeof raw.state === 'string' && [0, 5, 10, 15, 20, 30, 40, 50].includes(raw.access_level as number) && (raw.expires_at === null || typeof raw.expires_at === 'string') && (raw.membership_state === undefined || typeof raw.membership_state === 'string'));
    return raw as unknown as Member;
  }
  private active(member: Member | null, minimum: number): member is Member {
    return !!member && member.state === 'active' && (member.membership_state === undefined || member.membership_state === 'active') && member.access_level >= minimum && (member.expires_at === null || (/^\d{4}-\d{2}-\d{2}$/.test(member.expires_at) && member.expires_at > new Date().toISOString().slice(0, 10)));
  }
  private checkedProject(raw: unknown): GitLabProject {
    valid(record(raw) && numericId(raw.id) && typeof raw.name === 'string' && typeof raw.path === 'string' && typeof raw.path_with_namespace === 'string' && record(raw.namespace) && numericId(raw.namespace.id) && typeof raw.namespace.full_path === 'string' && typeof raw.visibility === 'string' && (raw.default_branch === null || typeof raw.default_branch === 'string') && (raw.description === null || typeof raw.description === 'string'));
    repositoryPath(raw.path_with_namespace); repositoryPath(raw.namespace.full_path);
    valid(raw.path_with_namespace === `${raw.namespace.full_path}/${raw.path}` && raw.http_url_to_repo === `${this.config.gitlabUrl}/${raw.path_with_namespace}.git`);
    return raw as unknown as GitLabProject;
  }
  async project(id: number | string): Promise<GitLabProject> { return this.checkedProject(await this.json(`/projects/${encodeURIComponent(id)}`)); }
  async projectAt(fullPath: string): Promise<GitLabProject | null> {
    repositoryPath(fullPath);
    try { return await this.project(fullPath); } catch (error) { if (error instanceof DomainError && error.code === 'GITLAB_NOT_FOUND') return null; throw error; }
  }
  async authorize(actor: Pick<Actor, 'gitlabUserId'>, projectId: number, edit = false): Promise<GitLabProject> {
    await this.user(actor.gitlabUserId);
    const membership = await this.member('projects', projectId, actor.gitlabUserId);
    requireCondition(this.active(membership, edit ? 30 : 20), edit ? 'PROJECT_EDIT_DENIED' : 'GITLAB_READ_DENIED', 'The bound GitLab user has no active repository membership for this operation', 403);
    const project = await this.project(projectId);
    valid(project.id === projectId);
    if (edit) requireCondition(project.archived !== true, 'PROJECT_EDIT_DENIED', 'The GitLab project is archived', 403);
    return project;
  }
  private groupPolicy(raw: unknown, id: number, accessLevel: number): NamespaceView | null {
    valid(record(raw) && raw.id === id && typeof raw.name === 'string' && typeof raw.full_path === 'string');
    repositoryPath(raw.full_path);
    const group = raw as unknown as Group;
    requireCondition(['developer', 'maintainer', 'noone'].includes(group.project_creation_level), 'NAMESPACE_POLICY_UNKNOWN', 'GitLab group project creation policy could not be established', 503);
    if (group.marked_for_deletion_on || group.marked_for_deletion_at || group.project_creation_level === 'noone') return null;
    if (accessLevel < (group.project_creation_level === 'developer' ? 30 : 40)) return null;
    return { id, name: group.name, fullPath: group.full_path };
  }
  private async group(actor: Actor, id: number): Promise<NamespaceView | null> {
    const membership = await this.member('groups', id, actor.gitlabUserId);
    if (!this.active(membership, 30)) return null;
    const raw = await this.json<unknown>(`/groups/${id}`);
    if (!this.active(membership, 30)) return null;
    return this.groupPolicy(raw, id, membership.access_level);
  }
  async namespaces(actor: Actor): Promise<NamespaceView[]> {
    await this.user(actor.gitlabUserId);
    const groups = await this.list('/groups?all_available=true'), seen = new Set<number>();
    const ids = groups.map(raw => {
      valid(record(raw) && numericId(raw.id) && !seen.has(raw.id)); seen.add(raw.id);
      return raw.id;
    });
    const namespaces: Array<NamespaceView | null> = Array.from({ length: ids.length }, () => null);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (next < ids.length) {
        const index = next++;
        const membership = await this.member('groups', ids[index]!, actor.gitlabUserId);
        if (this.active(membership, 30)) namespaces[index] = this.groupPolicy(groups[index], ids[index]!, membership.access_level);
      }
    }));
    return namespaces.filter((namespace): namespace is NamespaceView => namespace !== null);
  }
  async namespace(actor: Actor, id: number): Promise<NamespaceView> {
    await this.user(actor.gitlabUserId);
    const value = await this.group(actor, id);
    requireCondition(value, 'NAMESPACE_CREATE_DENIED', 'The bound GitLab user may not create projects in this group', 403); return value;
  }
  async createProject(name: string, path: string, namespaceId: number, marker: string): Promise<GitLabProject> {
    return this.checkedProject(await this.json('/projects', 'POST', { name, path, namespace_id: namespaceId, visibility: 'private', initialize_with_readme: false, description: marker }));
  }
  async grantCreator(actor: Actor, projectId: number): Promise<void> {
    await this.user(actor.gitlabUserId);
    const effective = await this.member('projects', projectId, actor.gitlabUserId);
    if (this.active(effective, 40)) return;
    const direct = await this.member('projects', projectId, actor.gitlabUserId, false);
    await this.json(`/projects/${projectId}/members${direct ? `/${actor.gitlabUserId}` : ''}`, direct ? 'PUT' : 'POST', { ...(direct ? {} : { user_id: actor.gitlabUserId }), access_level: 40 });
    const granted = await this.member('projects', projectId, actor.gitlabUserId);
    requireCondition(this.active(granted, 40), 'PROJECT_CREATOR_ASSIGNMENT_PENDING', 'GitLab creator membership has not been verified; retry the same project request', 503);
  }
  async branchHead(actor: Actor, projectId: number, branch: string): Promise<string> {
    await this.authorize(actor, projectId);
    const value = await this.json<{ commit?: { id?: string } } | null>(`/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`);
    valid(value && typeof value.commit?.id === 'string' && sha.test(value.commit.id)); return value.commit.id;
  }
}
