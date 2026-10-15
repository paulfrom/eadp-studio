import { DomainError, requireCondition } from '@eadp/asset-domain';
import type { Config } from '../config.js';
export interface Actor { id: number; username: string; token: string; admin: boolean }
export interface GitLabProject { id: number; name: string; http_url_to_repo: string; ssh_url_to_repo: string; default_branch: string; permissions?: { project_access?: { access_level: number }; group_access?: { access_level: number } } }
export class GitLab {
  constructor(private readonly config: Config) {}
  private async response(token: string, path: string): Promise<Response> {
    let response: Response;
    try { response = await fetch(`${this.config.gitlabUrl}/api/v4${path}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new DomainError('GITLAB_UNAVAILABLE', 'GitLab request failed or timed out', 502); }
    if (!response.ok) { await response.body?.cancel(); throw new DomainError(response.status === 401 ? 'UNAUTHENTICATED' : 'GITLAB_READ_DENIED', 'GitLab did not authorize or resolve the requested resource', response.status === 401 ? 401 : 403); }
    return response;
  }
  async bytes(token: string, path: string, maximum = 2 * 1024 * 1024): Promise<Uint8Array> {
    const response = await this.response(token, path);
    const reader = response.body?.getReader();
    requireCondition(reader, 'GITLAB_EMPTY_RESPONSE', 'GitLab returned an empty response', 502);
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length;
        requireCondition(size <= maximum, 'GITLAB_RESOURCE_TOO_LARGE', 'GitLab resource exceeds the allowed size', 422);
        chunks.push(next.value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); if (error instanceof DomainError) throw error; throw new DomainError('GITLAB_UNAVAILABLE', 'GitLab content read failed', 502); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  async json<T>(token: string, path: string): Promise<T> {
    const bytes = await this.bytes(token, path, 10 * 1024 * 1024);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T; }
    catch { throw new DomainError('GITLAB_INVALID_RESPONSE', 'GitLab returned an invalid response', 502); }
  }
  async authenticate(authorization: string | undefined): Promise<Actor> {
    requireCondition(typeof authorization === 'string' && authorization.startsWith('Bearer ') && authorization.length <= 4096, 'UNAUTHENTICATED', 'A GitLab OAuth Bearer token is required', 401);
    const token = authorization.slice(7);
    const user = await this.json<{ id: number; username: string; state: string }>(token, '/user');
    requireCondition(Number.isSafeInteger(user.id) && user.id > 0 && user.state === 'active', 'UNAUTHENTICATED', 'An active GitLab identity is required', 401);
    return { id: user.id, username: user.username, token, admin: this.config.adminIds.has(user.id) };
  }
  async authorize(actor: Actor, projectId: number, edit = false): Promise<GitLabProject> {
    const project = await this.json<GitLabProject>(actor.token, `/projects/${projectId}`);
    requireCondition(project.id === projectId, 'PROJECT_MISMATCH', 'GitLab project identity mismatch', 403);
    if (edit) requireCondition(Math.max(project.permissions?.project_access?.access_level ?? 0, project.permissions?.group_access?.access_level ?? 0) >= 30, 'PROJECT_EDIT_DENIED', 'GitLab Developer or higher project membership is required', 403);
    return project;
  }
  async branchHead(actor: Actor, projectId: number, branch: string): Promise<string> {
    const value = await this.json<{ commit: { id: string } }>(actor.token, `/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`);
    requireCondition(/^[a-f0-9]{40}$/.test(value.commit?.id), 'GITLAB_INVALID_RESPONSE', 'GitLab returned an invalid branch head', 502);
    return value.commit.id;
  }
}
