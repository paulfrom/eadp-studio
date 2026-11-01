import type { Context } from '@deepseek-ai/cordis'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'

/** Exact in-process requests already authorized and persisted by the Host. */
const admitted = new WeakSet<SessionPromptRequest>()
const hostControls = new Set<string>()
export function isHostNativeControl(sessionId: string): boolean { return hostControls.has(sessionId) }
export async function cancelHostNativeSession(ctx: Context, sessionId: import('@deepseek-ai/dsh-session').SessionId): Promise<void> {
  hostControls.add(sessionId)
  try { await ctx.sessionController.cancel({ sessionId }) }
  finally { hostControls.delete(sessionId) }
}
export function isHostNativePrompt(request: SessionPromptRequest): boolean { return admitted.has(request) }
export async function deliverHostNativePrompt(ctx: Context, request: SessionPromptRequest, signal: AbortSignal = new AbortController().signal): Promise<void> {
  admitted.add(request)
  try {
    signal.throwIfAborted()
    await ctx.sessionController.prompt(request, signal)
    const agent = ctx.agents.get(request.sessionId)
    if (!agent || !await ctx.sessions.flush(agent.session)) throw new Error('原生消息持久结果待核对，原请求已保留')
  }
  finally { admitted.delete(request) }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/prompt-admission'(admission: { request: SessionPromptRequest; signal: AbortSignal; handled: boolean; pass: boolean }): Promise<void>
    'session/control-admission'(admission: { sessionId: string; action: 'updateQueue' | 'cancel'; pass: boolean; execute?: () => Promise<void> }): Promise<void>
  }
}
