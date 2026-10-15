import type { GitLabAuth } from './auth.js'

export interface GitLabProject { id: number; name: string; path: string; repositoryUrl: string; defaultBranch: string; canPush: boolean }
/** One GitLab repository per Studio project. No browser token or generic URL fetch. */
export class GitLabClient {
  private readonly origin: string
  constructor(baseUrl: string, private readonly auth: GitLabAuth) { this.origin = new URL(baseUrl).origin }
  async project(repositoryUrl: string): Promise<GitLabProject> {
    const repository = new URL(repositoryUrl)
    if (repository.origin !== this.origin || repository.username || repository.password || repository.search || repository.hash || !/\.git$/.test(repository.pathname)) throw new Error('项目必须使用已配置 GitLab 实例的单一 HTTPS/HTTP .git 地址。')
    const projectPath = decodeURIComponent(repository.pathname.slice(1, -4))
    if (!projectPath || projectPath.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error('GitLab 仓库路径无效。')
    const response = await fetch(`${this.origin}/api/v4/projects/${encodeURIComponent(projectPath)}`, { headers: { Authorization: `Bearer ${await this.auth.getAccessToken()}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(response.status === 403 || response.status === 404 ? '没有读取该 GitLab 项目的权限。' : 'GitLab 项目查询失败。')
    const value = await response.json() as { id?: unknown; name?: unknown; path_with_namespace?: unknown; http_url_to_repo?: unknown; default_branch?: unknown; permissions?: { project_access?: { access_level?: number }; group_access?: { access_level?: number } } }
    if (typeof value.id !== 'number' || typeof value.name !== 'string' || typeof value.path_with_namespace !== 'string' || typeof value.http_url_to_repo !== 'string' || typeof value.default_branch !== 'string' || value.http_url_to_repo !== repositoryUrl) throw new Error('GitLab 项目元数据与仓库地址不一致。')
    const level = Math.max(value.permissions?.project_access?.access_level ?? 0, value.permissions?.group_access?.access_level ?? 0)
    return { id: value.id, name: value.name, path: value.path_with_namespace, repositoryUrl, defaultBranch: value.default_branch, canPush: level >= 30 }
  }
}
