import { Agent, fetch as directFetch } from 'undici'
import { collaborationOrigin } from './client.ts'

/** Collaboration uses its configured enterprise route; model traffic keeps the Host proxy policy. */
export class CollaborationTransport {
  private readonly origin: string
  private readonly dispatcher: Agent
  private readonly lifetime = new AbortController()
  private disposal: Promise<void> | undefined
  constructor(baseUrl: string) { this.origin = collaborationOrigin(baseUrl); this.dispatcher = new Agent() }
  readonly request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== this.origin || url.username || url.password) throw new Error('协同请求必须使用已配置的服务地址。')
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const request = new Request(input, {
      ...init, redirect: 'error',
      signal: AbortSignal.any([this.lifetime.signal, signal ?? AbortSignal.timeout(20_000)]),
    })
    // Fetch and Agent come from the same HTTP implementation, including on Node 22.
    return directFetch(request.url, {
      method: request.method, headers: Object.fromEntries(request.headers), body: request.body,
      redirect: 'error', signal: request.signal, dispatcher: this.dispatcher, duplex: 'half',
    }) as Promise<Response>
  }
  dispose(): Promise<void> {
    this.lifetime.abort()
    return this.disposal ??= this.dispatcher.destroy()
  }
}
