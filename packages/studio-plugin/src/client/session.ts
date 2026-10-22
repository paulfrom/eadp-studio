/** One plugin-lifetime Studio session: the shared projection store plus every command that writes it. */

import type { ProjectProgress, StudioCommand, StudioReply } from '../shared/studio.ts'
import { emptyStudioState } from './state.ts'
import { createStudioProjectionStore, type StudioProjectionStore } from './store.ts'

/** Commands the surfaces invoke instead of owning projection state of their own. */
export interface StudioSessionActions {
  /**
   * Sign in with the collaboration account.
   * @param username - submitted account name.
   * @param password - submitted password; never retained here.
   * @returns empty text on success, otherwise the failure the form shows inline.
   */
  login(username: string, password: string): Promise<string>
  /**
   * Revoke the collaboration session and clear the local cache.
   * @returns empty text on success, otherwise the failure the form shows inline.
   */
  logout(): Promise<string>
  /** Refresh the shared projection; a read already in flight keeps its slot. */
  sync(): void
  /**
   * Read the progress of the project operations the Host is running. The bar
   * polls this while an initialization is recorded; a failure keeps the last bar.
   */
  progress(): void
  /**
   * Run one workbench command whose successful reply is the newer projection.
   * @param command - the command a surface issues.
   * @returns the typed reply, so the caller can show failures and read a session id.
   */
  run(command: StudioCommand): Promise<StudioReply>
}

/** The session the plugin pins: one store, one set of commands. */
export interface StudioSession extends StudioSessionActions {
  /** Pinned handle both the workbench and the settings sections declare. */
  readonly store: StudioProjectionStore
}

/** A thrown channel failure as the text a surface shows. */
function failureText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '工作台状态获取失败'
}

/**
 * Create the Studio session. The projection is read once per request and written
 * in one place, so the workbench and the settings sections cannot disagree about
 * the account, the selected project or the pending work.
 * @param call - the shared bounded command channel.
 * @param readProgress - the bounded channel that reads running project progress.
 * @returns the pinned store plus login, logout, sync and command execution.
 */
export function createStudioSession(call: (command: StudioCommand) => Promise<StudioReply>, readProgress: () => Promise<ProjectProgress[]>): StudioSession {
  const handle = createStudioProjectionStore()
  const instance = handle.create()
  const actions = instance.actions
  const store: StudioProjectionStore = { ...handle, create: () => instance }
  // Newest write wins: a reply issued before a newer projection write must not land.
  let newest = 0
  // The read in flight. Surfaces mount and unmount independently, and login
  // changes reach all of them at once; joining the running read keeps that
  // fan-in to one Host round trip.
  let syncing: Promise<void> | undefined

  const applyRead = (token: number, reply: StudioReply): void => {
    if (token !== newest) return
    if (reply.ok) actions.settle(reply.state)
    else if (reply.code === 'LOGIN_REQUIRED') actions.settle(emptyStudioState())
    else actions.fail(reply.message)
  }

  const sync = (): void => {
    if (syncing !== undefined) return
    const token = ++newest
    actions.start()
    syncing = call({ action: 'state' })
      .then(reply => { applyRead(token, reply) }, error => { if (token === newest) actions.fail(failureText(error)) })
      .finally(() => { syncing = undefined })
  }

  // A command reply that is a full projection supersedes a read still
  // outstanding, which is why the token moves and the read slot is released.
  const execute = async (command: StudioCommand, settle: boolean): Promise<StudioReply> => {
    newest += 1
    syncing = undefined
    try {
      const reply = await call(command)
      if (settle && reply.ok) actions.settle(reply.state)
      return reply
    } catch (error) {
      return { ok: false, code: 'CHANNEL_FAILED', message: failureText(error) }
    }
  }

  // The bar of a running initialization. Reads are advisory: a failed one leaves
  // the last bar and the recorded outcome, which is the authority, unchanged. An
  // older read that arrives late is dropped, so the bar never moves backwards.
  let progressRead = 0
  const progress = (): void => {
    const token = ++progressRead
    void readProgress().then(list => { if (token === progressRead) actions.report(list) }, () => undefined)
  }

  const login = async (username: string, password: string): Promise<string> => {
    // Login's reply only carries the authenticated account, so it cannot settle
    // the projection; the read that follows delivers the signed-in surfaces.
    const reply = await execute({ action: 'login', username, password }, false)
    if (!reply.ok) return reply.message
    sync()
    return ''
  }

  const logout = async (): Promise<string> => {
    const reply = await execute({ action: 'logout' }, false)
    if (!reply.ok) return reply.message
    sync()
    return ''
  }

  return {
    store,
    sync,
    progress,
    run: command => execute(command, true),
    login,
    logout,
  }
}
