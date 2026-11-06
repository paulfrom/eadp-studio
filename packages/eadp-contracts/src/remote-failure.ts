/** Shared failure inspection for Host Remote services translating errors onto the Typert transport. */
export function isRemoteCancellation(error: unknown): boolean {
  const failure = error as { name?: string; code?: string } | undefined
  return failure?.name === 'AbortError' || failure?.code === 'FS_ABORTED'
}

/** Extracts a human-readable message, keeping the service fallback when the failure carries none. */
export function failureMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: string } | undefined)?.message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

/** Translates a native failure code through a service-specific table with a domain fallback code. */
export function mapFailureCode<C extends string>(error: unknown, table: Record<string, C>, fallback: C): C {
  const code = (error as { code?: string } | undefined)?.code
  return (code !== undefined && table[code]) || fallback
}
