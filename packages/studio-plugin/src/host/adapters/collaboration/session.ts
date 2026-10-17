import type { LoginResponse, StudioIdentity } from '@eadp/contracts'
import type { SecretStore } from '../platform/credentials.js'
import { CollaborationError, collaborationJson, collaborationOrigin } from './client.ts'

interface SavedSession { origin: string; token: string; expiresAt: string; userId: number }
const KEY = 'collaboration-session'
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
class LoginFailure extends Error {}
const loginFailures: Readonly<Record<string, string>> = {
  ACCOUNT_NOT_INITIALIZED: '协同账号尚未初始化，请联系管理员。',
  ACCOUNT_INVALID: '协同账号配置异常，请联系管理员。',
  GITLAB_BINDING_REQUIRED: '协同账号尚未完成 GitLab 身份绑定，请联系管理员。',
  GITLAB_BINDING_UNRESOLVED: '协同账号的 GitLab 身份无法唯一确定，请联系管理员。',
  GITLAB_NOT_CONFIGURED: '协同后端尚未配置 GitLab 访问凭据，请联系管理员。',
  GITLAB_MANAGEMENT_DENIED: '协同后端的 GitLab 访问凭据无效，请联系管理员。',
  GITLAB_RESOURCE_DENIED: '协同后端没有所需的 GitLab 访问权限，请联系管理员。',
  GITLAB_UNAVAILABLE: '协同后端暂时无法访问 GitLab，请稍后重试。',
  GITLAB_RATE_LIMITED: 'GitLab 请求受限，请稍后重试。',
  GITLAB_INVALID_RESPONSE: 'GitLab 返回无效响应，请联系管理员。',
  GITLAB_EMPTY_RESPONSE: 'GitLab 返回空响应，请联系管理员。',
  SERVICE_UNAVAILABLE: '协同后端暂时无法完成登录，请检查服务状态。',
}
async function loginHttpFailure(response: Response, origin: string): Promise<LoginFailure> {
  const context = `（HTTP ${response.status}；服务：${origin}）`
  if (response.status === 401) { await response.body?.cancel(); return new LoginFailure(`用户名或密码错误。${context}`) }
  // Treat upstream bodies as untrusted: only known codes choose local messages.
  const value = await collaborationJson(response).catch(() => undefined) as { error?: { code?: unknown } } | undefined
  const code = value?.error?.code
  const message = typeof code === 'string' && Object.hasOwn(loginFailures, code) ? loginFailures[code] : '协同登录失败，请检查服务地址和状态。'
  return new LoginFailure(`${message}${context}`)
}
function identity(value: unknown): StudioIdentity {
  if (!value || typeof value !== 'object') throw new Error('协同身份响应无效。')
  const record = value as StudioIdentity, user = record.user
  if (!user || !positiveId(user.id) || typeof user.username !== 'string' || !user.username || typeof user.name !== 'string' || !user.name || typeof user.email !== 'string' || !user.email.includes('@') || typeof user.admin !== 'boolean' || !positiveId(user.gitlabUserId) || typeof user.gitlabUsername !== 'string' || !user.gitlabUsername || (user.gitlabEmail !== undefined && (typeof user.gitlabEmail !== 'string' || !user.gitlabEmail.includes('@'))) || typeof record.gitlabOrigin !== 'string' || collaborationOrigin(record.gitlabOrigin) !== record.gitlabOrigin) throw new Error('协同身份或 GitLab 实例响应无效。')
  return { user: { id: user.id, username: user.username, name: user.name, email: user.email, admin: user.admin, gitlabUserId: user.gitlabUserId, gitlabUsername: user.gitlabUsername, ...(user.gitlabEmail ? { gitlabEmail: user.gitlabEmail } : {}) }, gitlabOrigin: record.gitlabOrigin }
}

/** Passwords are sent once to the fixed backend; only its expiring session reaches safeStorage. */
export class CollaborationSession {
  private readonly origin: string
  private generation = 0
  private writes: Promise<unknown> = Promise.resolve()
  private loginController: AbortController | undefined
  constructor(baseUrl: string, private readonly credentials: SecretStore, private readonly request: typeof fetch) { this.origin = collaborationOrigin(baseUrl) }
  async login(username: string, password: string): Promise<StudioIdentity> {
    if (!username.trim() || username.length > 100 || !password || password.length > 200) throw new Error('请输入有效的协同用户名和密码。')
    this.loginController?.abort()
    const generation = ++this.generation, controller = new AbortController()
    this.loginController = controller
    let phase: 'request' | 'response' | 'storage' = 'request'
    let status: number | undefined
    try {
      const response = await this.request(`${this.origin}/v1/auth/login`, { method: 'POST', body: JSON.stringify({ username: username.trim(), password }), headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]), redirect: 'error' })
      status = response.status; phase = 'response'
      if (!response.ok) throw await loginHttpFailure(response, this.origin)
      const result = await collaborationJson(response) as LoginResponse
      const profile = identity(result)
      if (typeof result.token !== 'string' || !/^studio_[A-Za-z0-9_-]{43}$/.test(result.token) || typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) throw new Error('协同登录会话响应无效。')
      phase = 'storage'
      await this.mutate(async () => {
        if (generation !== this.generation) throw new Error('协同登录已取消。')
        await this.credentials.write(KEY, { origin: this.origin, token: result.token, expiresAt: result.expiresAt, userId: profile.user.id } satisfies SavedSession)
      })
      if (generation !== this.generation) throw new Error('协同登录已取消。')
      return profile
    } catch (error) {
      if (generation !== this.generation) throw new Error('协同登录已取消。')
      if (error instanceof LoginFailure) throw error
      const context = `（${status === undefined ? '' : `HTTP ${status}；`}服务：${this.origin}）`
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`协同登录请求超时，请检查网络与服务状态。${context}`)
      if (phase === 'storage') throw new Error(`协同登录会话无法保存，请检查本机安全凭据存储。${context}`)
      if (phase === 'response') throw new Error(`协同登录响应无效，请检查服务状态。${context}`)
      throw new Error(`协同登录请求未完成，请检查网络后重试。${context}`)
    } finally { if (this.loginController === controller) this.loginController = undefined }
  }
  async getAccessToken(): Promise<string> {
    const generation = this.generation, session = await this.saved()
    if (generation !== this.generation || !session) throw new CollaborationError('LOGIN_REQUIRED', '请先登录协同工作台。', 401)
    if (Date.parse(session.expiresAt) <= Date.now()) { await this.invalidate(); throw new CollaborationError('LOGIN_REQUIRED', '协同登录已过期，请重新登录。', 401) }
    return session.token
  }
  async current(): Promise<StudioIdentity | undefined> {
    const session = await this.saved()
    if (!session) return undefined
    if (Date.parse(session.expiresAt) <= Date.now()) { await this.invalidate(); return undefined }
    const generation = this.generation
    let response: Response
    try { response = await this.request(`${this.origin}/v1/me`, { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(20_000), redirect: 'error' }) }
    catch { throw new Error('协同身份暂时无法核对，请检查网络。') }
    if (response.status === 401) { await response.body?.cancel(); if (generation === this.generation) await this.invalidate(); return undefined }
    if (!response.ok) { await response.body?.cancel(); throw new Error('协同身份核对失败。') }
    const profile = identity(await collaborationJson(response))
    if (generation !== this.generation) return undefined
    if (profile.user.id !== session.userId) { await this.invalidate(); throw new Error('协同会话身份不一致，请重新登录。') }
    return profile
  }
  async logout(): Promise<void> {
    this.cancel()
    const generation = this.generation
    const session = await this.saved().catch(() => undefined)
    if (generation !== this.generation) return
    await this.mutate(() => this.credentials.delete(KEY))
    let revoked = !session
    try {
      if (session) {
        const response = await this.request(`${this.origin}/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(20_000), redirect: 'error' })
        revoked = response.ok || response.status === 401; await response.body?.cancel()
      }
    } catch { /* The local credential is removed even when revocation cannot be confirmed. */ }
    if (!revoked) throw new Error('本机协同登录已清除；后台会话撤销结果未知，请稍后核对。')
  }
  async invalidate(): Promise<void> { this.cancel(); await this.mutate(() => this.credentials.delete(KEY)) }
  async invalidateToken(token: string): Promise<void> { const generation = this.generation, current = await this.saved(); if (generation === this.generation && current?.token === token) await this.invalidate() }
  dispose(): void { this.cancel() }
  private cancel(): void { ++this.generation; this.loginController?.abort(); this.loginController = undefined }
  private mutate(action: () => Promise<void>): Promise<void> { const result = this.writes.then(action); this.writes = result.catch(() => undefined); return result }
  private async saved(): Promise<SavedSession | undefined> {
    await this.writes
    const value = await this.credentials.read(KEY) as SavedSession | undefined
    if (!value) return undefined
    if (value.origin !== this.origin || typeof value.token !== 'string' || !/^studio_[A-Za-z0-9_-]{43}$/.test(value.token) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || !positiveId(value.userId)) throw new Error('本机协同会话无效，请退出后重新登录。')
    return value
  }
}
