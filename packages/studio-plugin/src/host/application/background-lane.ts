/** Keys remembered as completed before the lane forgets the oldest ones. */
const REMEMBERED = 512

/**
 * One serialized lane for work no command reply waits for: Git synchronization
 * (clone, fetch of a fixed commit, push) and the preparation that depends on it.
 *
 * The lane exists so neither the projection the surfaces render nor a
 * collaboration request waits for the network: a command records the pending
 * work and answers, the lane performs it, and the surfaces observe the record.
 * Identical work shares one key, so repeated projection reads cannot start a
 * second clone or commit fetch, and work that already completed in this process
 * is not repeated. A key that failed is not remembered, so the next read tries
 * again once the network recovers.
 */
export class BackgroundLane {
  private lane: Promise<unknown> = Promise.resolve()
  private readonly queued = new Map<string, Promise<void>>()
  private readonly done = new Set<string>()
  /**
   * Queue one piece of background work.
   * @param key - identity of the work; identical keys run once.
   * @param work - the work to perform on the lane.
   */
  schedule(key: string, work: () => Promise<void>): void {
    if (this.queued.has(key) || this.done.has(key)) return
    const started = this.lane.then(work).then(() => { this.remember(key) })
    this.queued.set(key, started)
    const settled = (): void => { this.queued.delete(key) }
    this.lane = started.then(settled, settled)
    void started.catch(() => undefined)
  }
  /**
   * Await every queued piece of work; teardown and tests observe the lane settle
   * here. Work may queue more work while settling (a project resume queues the
   * commit it needs), so the lane is followed until it stops growing.
   */
  async settle(): Promise<void> {
    let current = this.lane
    await current
    while (this.lane !== current) { current = this.lane; await current }
  }
  /** Queue work that has no identity to de-duplicate by, such as one file-change reaction. */
  append(work: () => Promise<void>): void {
    const started = this.lane.then(work)
    this.lane = started.catch(() => undefined)
    void started.catch(() => undefined)
  }
  private remember(key: string): void {
    this.done.add(key)
    if (this.done.size > REMEMBERED) this.done.delete(this.done.values().next().value!)
  }
}
