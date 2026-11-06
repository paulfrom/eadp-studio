/** Serializes async mutations per key; a failed mutation never blocks the next one. */
export class MutationQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(action)
    this.tails.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.tails.get(key) === operation) this.tails.delete(key)
    }
  }

  /** Waits until every mutation queued at call time has settled. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.tails.values()])
  }
}
