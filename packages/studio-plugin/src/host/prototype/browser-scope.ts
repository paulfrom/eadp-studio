import { canonical } from '@eadp/asset-domain'

/** A validation target is either a fenced task or an accepted immutable baseline. */
export type PrototypeBrowserTarget =
  | { kind: 'task'; prototypeTaskId: string; taskGeneration: number }
  | { kind: 'baseline'; baselineId: string; commitSha: string }

export interface PrototypeBrowserScope {
  accountId: number; projectId: string; sessionId: string; validationRunId: string
  target: PrototypeBrowserTarget; previewId: string; previewGeneration: number; buildHash: string; origin: string
}

export type PrototypeBrowserAction = 'open' | 'click' | 'fill' | 'select' | 'key' | 'wait' | 'assert' | 'snapshot' | 'screenshot' | 'diagnostics' | 'trace'
const actions = new Set<string>(['open', 'click', 'fill', 'select', 'key', 'wait', 'assert', 'snapshot', 'screenshot', 'diagnostics', 'trace'])
const sha256 = /^[a-f0-9]{64}$/
const sha = /^[a-f0-9]{40}$/
const identity = (value: string): boolean => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value)

function validateScope(input: PrototypeBrowserScope): void {
  if (!Number.isSafeInteger(input.accountId) || input.accountId < 1 || !Number.isSafeInteger(input.previewGeneration) || input.previewGeneration < 1 ||
    ![input.projectId, input.sessionId, input.validationRunId, input.previewId].every(identity) || !sha256.test(input.buildHash)) throw new Error('浏览器验证身份无效')
  if (input.target.kind === 'task') {
    if (!identity(input.target.prototypeTaskId) || !Number.isSafeInteger(input.target.taskGeneration) || input.target.taskGeneration < 1) throw new Error('浏览器事项身份无效')
  } else if (input.target.kind === 'baseline') {
    if (!identity(input.target.baselineId) || !sha.test(input.target.commitSha)) throw new Error('浏览器基线身份无效')
  } else throw new Error('浏览器目标无效')
  let url: URL
  try { url = new URL(input.origin) } catch { throw new Error('预览地址无效') }
  const port = Number(url.port)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1024 || port > 65535 ||
    url.origin !== input.origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('浏览器只能访问当前受管预览地址')
}

/** Resolve an application route without letting the caller choose another origin. */
export function prototypeBrowserRoute(scope: PrototypeBrowserScope, route: string): string {
  validateScope(scope)
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[\\\0\r\n]/.test(route)) throw new Error('原型路由无效')
  const url = new URL(route, scope.origin)
  if (url.origin !== scope.origin || url.username || url.password) throw new Error('原型路由超出当前预览')
  return url.href
}

/** A provider must run this for every network request, including redirect targets. */
export function allowPrototypeBrowserRequest(scope: PrototypeBrowserScope, request: { url: string; resourceType: string; isMainFrame: boolean }): boolean {
  try {
    validateScope(scope)
    const url = new URL(request.url)
    if (url.origin !== scope.origin || url.protocol !== 'http:' || url.username || url.password) return false
    if (['websocket', 'eventsource', 'serviceworker'].includes(request.resourceType.toLowerCase())) return false
    if (request.resourceType === 'document' && !request.isMainFrame) return false
    return true
  } catch { return false }
}

/**
 * One in-memory capability for a single validation run. The provider supplies
 * the current Host-owned identity and a close operation for its process tree.
 * A restored session cannot reuse this instance.
 */
export class PrototypeBrowserRun {
  private readonly expected: PrototypeBrowserScope
  private readonly controller = new AbortController()
  private tail: Promise<void> = Promise.resolve()
  private closing?: Promise<void>
  constructor(scope: PrototypeBrowserScope, private readonly current: () => Promise<PrototypeBrowserScope | undefined>, private readonly stop: () => Promise<void>) {
    validateScope(scope)
    this.expected = structuredClone(scope)
  }
  /** Serializes actions and rechecks the Host-owned identity immediately before each operation. */
  run<T>(action: PrototypeBrowserAction, signal: AbortSignal, work: (scope: Readonly<PrototypeBrowserScope>, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!actions.has(action) || this.closing) return Promise.reject(new Error('浏览器验证操作不可用'))
    const combined = AbortSignal.any([signal, this.controller.signal])
    const result = this.tail.then(async () => {
      combined.throwIfAborted()
      const observed = await this.current()
      combined.throwIfAborted()
      if (!observed || canonical(observed) !== canonical(this.expected)) {
        this.controller.abort(new Error('预览或验证身份已变化'))
        void this.close().catch(() => {})
        throw new Error('预览或验证身份已变化，原浏览器能力已失效')
      }
      const value = await work(structuredClone(this.expected), combined)
      combined.throwIfAborted()
      const after = await this.current()
      combined.throwIfAborted()
      if (!after || canonical(after) !== canonical(this.expected)) {
        this.controller.abort(new Error('预览或验证身份已变化'))
        void this.close().catch(() => {})
        throw new Error('预览或验证身份已变化，浏览器结果不能复用')
      }
      return value
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
  /** Stop new work, interrupt the owned resource, and wait for its existing actions to settle. */
  close(): Promise<void> {
    if (!this.closing) this.closing = Promise.resolve().then(async () => {
      this.controller.abort(new Error('原型浏览器验证已关闭'))
      try { await this.stop() } finally { await this.tail }
    })
    return this.closing
  }
}
