export function collaborationOrigin(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('协同服务地址无效。')
  return url.origin
}
/** Fixed diagnostics for upstream GitLab failures; the backend text is English and carries no retry guidance. */
const gitlabFailures: Readonly<Record<string, string>> = {
  GITLAB_BINDING_REQUIRED: '协同账号尚未完成 GitLab 身份绑定，请联系管理员。',
  GITLAB_BINDING_UNRESOLVED: '协同账号的 GitLab 身份无法唯一确定，请联系管理员。',
  GITLAB_NOT_CONFIGURED: '协同后端尚未配置 GitLab 访问凭据，请联系管理员。',
  GITLAB_MANAGEMENT_DENIED: '协同后端的 GitLab 访问凭据无效，请联系管理员。',
  GITLAB_RESOURCE_DENIED: '协同后端没有所需的 GitLab 访问权限，请联系管理员。',
  GITLAB_UNAVAILABLE: '协同后端暂时无法访问 GitLab，请稍后重试。',
  GITLAB_RATE_LIMITED: 'GitLab 请求受限，请稍后重试。',
  GITLAB_INVALID_RESPONSE: 'GitLab 返回无效响应，请联系管理员。',
  GITLAB_EMPTY_RESPONSE: 'GitLab 返回空响应，请联系管理员。',
}
/** Upstream bodies are untrusted: only known codes choose a local message. */
export function collaborationFailureMessage(code: string, fallback: string): string {
  return Object.hasOwn(gitlabFailures, code) ? gitlabFailures[code]! : fallback
}
export async function collaborationJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > 2_097_152 || !response.body) { await response.body?.cancel(); throw new Error('协同响应无效。') }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break
      size += result.value.byteLength
      if (size > 2_097_152) { await reader.cancel(); throw new Error('协同响应超过大小限制。') }
      chunks.push(result.value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new Error('协同响应无法解析。') }
}
/** Only Host carries the collaboration session. Git uses the machine user's separate credentials. */
export class CollaborationClient {
  private readonly origin: string
  constructor(baseUrl: string, private readonly accessToken: () => Promise<string>, private readonly unauthorized: ((token: string) => Promise<void>) | undefined, private readonly requestHttp: typeof fetch) { this.origin = collaborationOrigin(baseUrl) }
  /** The backend bounds each GitLab call, not the whole request; provisioning legitimately chains several. */
  async request<T>(method: 'GET' | 'POST' | 'PUT', route: string, body?: object, timeoutMs = 60_000): Promise<T> {
    if (!route.startsWith('/v1/') || route.includes('\\') || route.split('/').some(part => part === '..' || part === '.')) throw new Error('协同操作路径无效')
    const token = await this.accessToken()
    const response = await this.requestHttp(`${this.origin}${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (response.status === 401) { await response.body?.cancel(); await this.unauthorized?.(token); throw new CollaborationError('LOGIN_REQUIRED', '协同登录已过期，请重新登录。', 401) }
    const value = await collaborationJson(response) as { error?: { code: string; message: string } }
    if (!response.ok) {
      const code = value.error?.code ?? 'UNAVAILABLE'
      throw new CollaborationError(code, collaborationFailureMessage(code, value.error?.message ?? '协同服务暂不可用'), response.status)
    }
    return value as T
  }
}
export class CollaborationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message) }
}
