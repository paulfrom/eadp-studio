import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Throws the remote error or returns the value; the only client-side transport rule. */
export function unwrapRemoteResult<T>(reply: RemoteResult<T>): T {
  if (!reply.ok) throw reply.error
  return reply.value
}
