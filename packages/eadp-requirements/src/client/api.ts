import type { Context } from '@deepseek-ai/cordis'
import { unwrapRemoteResult } from '@eadp/contracts'
import type {} from '@eadp/requirements/remote'

/** Exposes only the generated Remote's UI operations to React components. */
export function requirementsApi(ctx: Context) {
  const remote = ctx.remote.eadpRequirements
  return {
    list: async (projectId: string) => unwrapRemoteResult(await remote.list(projectId)),
    read: async (projectId: string, path: string) => unwrapRemoteResult(await remote.read(projectId, path)),
    readContext: async (projectId: string) => unwrapRemoteResult(await remote.readContext(projectId)),
    create: async (projectId: string, path: string, text = '') => unwrapRemoteResult(await remote.create(projectId, path, text)),
    createDirectory: async (projectId: string, path: string) => unwrapRemoteResult(await remote.createDirectory(projectId, path)),
    save: async (projectId: string, path: string, text: string, version: string) => unwrapRemoteResult(await remote.save(projectId, path, text, version)),
    saveContext: async (projectId: string, text: string, version: string | null) => unwrapRemoteResult(await remote.saveContext(projectId, text, version)),
    rename: async (projectId: string, path: string, next: string) => unwrapRemoteResult(await remote.rename(projectId, path, next)),
    remove: async (projectId: string, path: string) => unwrapRemoteResult(await remote.removeEntry(projectId, path)),
    listProposals: async (projectId: string) => unwrapRemoteResult(await remote.listProposals(projectId)),
    applyProposal: async (projectId: string, id: string, version: string | null) => unwrapRemoteResult(await remote.applyProposal(projectId, id, version)),
    discardProposal: async (projectId: string, id: string) => unwrapRemoteResult(await remote.discardProposal(projectId, id)),
    statVersion: async (projectId: string, path: string) => unwrapRemoteResult(await remote.statVersion(projectId, path)),
  }
}
export type RequirementsApi = ReturnType<typeof requirementsApi>
