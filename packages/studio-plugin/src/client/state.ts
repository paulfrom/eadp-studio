import type { StudioState } from '../shared/studio.ts'

/**
 * The workbench projection before any Host answer: signed out, nothing
 * selected, every collection empty. Surfaces use it for a Host `LOGIN_REQUIRED`
 * reply and as their placeholder while the first answer is still outstanding.
 * @returns a fresh empty projection.
 */
export function emptyStudioState(): StudioState {
  return { connected: false, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], drafts: [], tasks: [], candidates: [], pending: [], reviews: [] }
}
