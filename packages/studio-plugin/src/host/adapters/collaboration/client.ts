export function collaborationOrigin(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('协同服务地址无效。')
  return url.origin
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
  async request<T>(method: 'GET' | 'POST' | 'PUT', route: string, body?: object): Promise<T> {
    if (!route.startsWith('/v1/') || route.includes('\\') || route.split('/').some(part => part === '..' || part === '.')) throw new Error('协同操作路径无效')
    const token = await this.accessToken()
    const response = await this.requestHttp(`${this.origin}${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (response.status === 401) { await response.body?.cancel(); await this.unauthorized?.(token); throw new CollaborationError('LOGIN_REQUIRED', '协同登录已过期，请重新登录。', 401) }
    const value = await collaborationJson(response) as { error?: { code: string; message: string } }
    if (!response.ok) throw new CollaborationError(value.error?.code ?? 'UNAVAILABLE', value.error?.message ?? '协同服务暂不可用', response.status)
    return value as T
  }
}
export class CollaborationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message) }
}
