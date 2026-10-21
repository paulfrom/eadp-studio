/**
 * Bound one awaited step. Both halves need it: the Host bounds composition
 * before it can answer any command, and the Client bounds every Remote round
 * trip. A stalled dependency must surface as a failure the user can act on,
 * never as a promise that stays pending while the UI shows an older state.
 * @param work - the awaited step; it keeps running after the deadline, because
 *   neither half can cancel compiled-in work across the process or wire boundary.
 * @param deadlineMs - longest wait before the deadline failure.
 * @param message - user-facing failure text the deadline produces.
 * @returns the value of `work` when it settles first.
 */
export async function within<T>(work: Promise<T>, deadlineMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(message)) }, deadlineMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}
