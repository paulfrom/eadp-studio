/** Shared projection store of the Studio workbench and settings sections. */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ProjectProgress, StudioState } from '../shared/studio.ts'

/** One workbench projection, shared by every surface that renders it. */
export interface StudioProjectionSnapshot {
  /** Last projection the Host reported; undefined until the first answer arrives. */
  projection: StudioState | undefined
  /** Progress of the project operations the Host is running; empty when nothing is running. */
  progress: ProjectProgress[]
  /** Whether a projection read is in flight; drives the surfaces' loading state. */
  loading: boolean
  /** Failure text of the last read; empty while the last read succeeded. */
  error: string
}

type StudioProjectionActions = {
  start(draft: StudioProjectionSnapshot): void
  settle(draft: StudioProjectionSnapshot, projection: StudioState): void
  fail(draft: StudioProjectionSnapshot, error: string): void
  report(draft: StudioProjectionSnapshot, progress: ProjectProgress[]): void
}

/** Handle the workbench and settings registrations declare; one pinned instance serves both. */
export type StudioProjectionStore = EngineStoreHandle<StudioProjectionSnapshot, StudioProjectionActions>

/**
 * Declare the shared projection. A failed read keeps the last projection: the
 * surfaces then report the failure beside known state instead of pretending the
 * account was signed out.
 * @returns the store handle, created once per plugin activation.
 */
export function createStudioProjectionStore(): StudioProjectionStore {
  return defineStore({
    init: (): StudioProjectionSnapshot => ({ projection: undefined, progress: [], loading: false, error: '' }),
    actions: {
      start: draft => { draft.loading = true },
      // A projection without a running operation ends the bar, so a stopped poll cannot leave one behind.
      settle: (draft, projection: StudioState) => { draft.projection = projection; draft.loading = false; draft.error = ''; if (!projection.projectInitializations.length) draft.progress = [] },
      fail: (draft, error: string) => { draft.loading = false; draft.error = error },
      report: (draft, progress: ProjectProgress[]) => { draft.progress = progress },
    },
  })
}
