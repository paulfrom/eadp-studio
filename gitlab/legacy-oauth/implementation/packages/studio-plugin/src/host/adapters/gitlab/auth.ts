import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { SecretStore } from '../platform/credentials.js'

interface OAuthGrant { accessToken: string; refreshToken?: string; expiresAt: number; origin: string; clientId: string }
export interface GitLabAuthOptions {
  baseUrl: string; clientId: string; redirectUri: string; credentials: SecretStore
  openExternal?: (url: string) => Promise<void>
}
export interface AuthStatus { configured: boolean; authenticated: boolean; pending: boolean; error?: string; callbackUrl: string }
const KEY = 'gitlab-oauth'

/** Public-client authorization code + S256 PKCE, fixed loopback callback, no client secret. */
export class GitLabAuth {
  private readonly origin: string
  private readonly callback: URL
  private server: Server | undefined
  private pending = false
  private lastError: string | undefined
  private refresh: Promise<string> | undefined
  private generation = 0
  constructor(private readonly options: GitLabAuthOptions) {
    const base = new URL(options.baseUrl)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('GitLab 实例地址无效。')
    this.origin = base.origin
    this.callback = new URL(options.redirectUri)
    if (this.callback.protocol !== 'http:' || this.callback.hostname !== '127.0.0.1' || !this.callback.port || this.callback.username || this.callback.password || this.callback.search || this.callback.hash || this.callback.pathname !== '/oauth/gitlab/callback') throw new Error('GitLab 回调必须使用已注册的固定 loopback 地址及 /oauth/gitlab/callback。')
  }
  async status(): Promise<AuthStatus> {
    const grant = await this.grant()
    return { configured: !!this.options.clientId, authenticated: !!grant && (!!grant.refreshToken || grant.expiresAt > Date.now()), pending: this.pending, ...(this.lastError ? { error: this.lastError } : {}), callbackUrl: this.callback.href }
  }
  async begin(): Promise<{ url: string; callbackUrl: string }> {
    if (!this.options.clientId) throw new Error('GitLab OAuth 应用尚未配置。')
    if (this.pending) throw new Error('GitLab 授权正在进行。')
    this.lastError = undefined
    const generation = ++this.generation
    const verifier = randomBytes(48).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    let consumed = false
    const server = createServer((request, response) => {
      const received = new URL(request.url ?? '/', this.callback.origin)
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      if (request.method !== 'GET' || request.headers.host !== this.callback.host || received.pathname !== this.callback.pathname) { response.writeHead(404).end(); return }
      const supplied = received.searchParams.get('state') ?? ''
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(state)) || consumed) { response.writeHead(400).end('授权回调无效。'); return }
      consumed = true
      void (async () => {
        try {
          const code = received.searchParams.get('code')
          if (!code || received.searchParams.has('error')) throw new Error('GitLab 未授予授权。')
          const grant = await this.exchange({ grant_type: 'authorization_code', code, redirect_uri: this.callback.href, code_verifier: verifier })
          if (generation !== this.generation) throw new Error('授权操作已取消。')
          await this.options.credentials.write(KEY, grant)
          response.writeHead(200).end('GitLab 授权完成，可以返回工作台。')
        } catch { this.lastError = 'GitLab 授权未完成，请检查应用、回调和实例的 PKCE 支持。'; response.writeHead(400).end(this.lastError) }
        finally { if (generation === this.generation) this.closeCallback() }
      })()
    })
    server.requestTimeout = 10_000
    this.server = server
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(this.callback.port), '127.0.0.1', () => { server.off('error', reject); resolve() }) }).catch(() => { this.closeCallback(); throw new Error('GitLab 回调端口不可用。') })
    this.pending = true
    const timeout = setTimeout(() => { if (generation === this.generation) { this.lastError = 'GitLab 授权已超时。'; this.closeCallback() } }, 180_000)
    timeout.unref()
    server.once('close', () => clearTimeout(timeout))
    const url = new URL('/oauth/authorize', this.origin)
    url.search = new URLSearchParams({ client_id: this.options.clientId, redirect_uri: this.callback.href, response_type: 'code', state, scope: 'api', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString()
    try { await this.options.openExternal?.(url.href) } catch { this.closeCallback(); throw new Error('无法打开 GitLab 授权页面。') }
    return { url: url.href, callbackUrl: this.callback.href }
  }
  async getAccessToken(): Promise<string> {
    const grant = await this.grant()
    if (!grant) throw new Error('请先授权 GitLab。')
    if (grant.expiresAt > Date.now() + 60_000) return grant.accessToken
    if (!grant.refreshToken) throw new Error('GitLab 授权已过期。')
    const generation = this.generation
    return this.refresh ??= this.exchange({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }).then(async next => {
      if (generation !== this.generation) throw new Error('GitLab 授权操作已变化，请重新查询。')
      await this.options.credentials.write(KEY, next)
      return next.accessToken
    }).finally(() => { this.refresh = undefined })
  }
  async logout(): Promise<void> {
    this.closeCallback()
    const grant = await this.grant()
    if (grant) {
      const response = await fetch(new URL('/oauth/revoke', this.origin), { method: 'POST', body: new URLSearchParams({ client_id: this.options.clientId, token: grant.accessToken }), signal: AbortSignal.timeout(15_000), redirect: 'error' }).catch(() => undefined)
      if (response && !response.ok) throw new Error('GitLab 撤销授权失败，请重试。')
    }
    await this.options.credentials.delete(KEY)
  }
  dispose(): void { this.closeCallback() }
  private closeCallback(): void { ++this.generation; this.server?.close(); this.server?.closeIdleConnections(); this.server = undefined; this.pending = false }
  private async grant(): Promise<OAuthGrant | undefined> {
    const value = await this.options.credentials.read(KEY) as OAuthGrant | undefined
    if (!value) return undefined
    if (value.origin !== this.origin || value.clientId !== this.options.clientId || typeof value.accessToken !== 'string' || !value.accessToken || !Number.isFinite(value.expiresAt)) throw new Error('保存的 GitLab 授权不匹配当前实例。')
    return value
  }
  private async exchange(fields: Record<string, string>): Promise<OAuthGrant> {
    const response = await fetch(new URL('/oauth/token', this.origin), { method: 'POST', body: new URLSearchParams({ ...fields, client_id: this.options.clientId }), signal: AbortSignal.timeout(20_000), redirect: 'error' })
    if (!response.ok) throw new Error('GitLab 授权交换失败。')
    const token = await response.json() as Record<string, unknown>
    if (typeof token.access_token !== 'string' || !token.access_token || typeof token.expires_in !== 'number' || token.expires_in <= 0 || (token.refresh_token !== undefined && typeof token.refresh_token !== 'string')) throw new Error('GitLab 授权响应无效。')
    return { accessToken: token.access_token, ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}), expiresAt: Date.now() + token.expires_in * 1000, origin: this.origin, clientId: this.options.clientId }
  }
}
