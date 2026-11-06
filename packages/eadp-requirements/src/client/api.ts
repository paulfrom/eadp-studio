import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@eadp/requirements/remote'

function unwrap<T>(reply: RemoteResult<T>): T {
  if (!reply.ok) throw reply.error
  return reply.value
}
/** Exposes only the generated Remote's UI operations to React components. */
export function requirementsApi(ctx: Context) {
  const remote = ctx.remote.eadpRequirements
  return {
    list: async (projectId: string) => unwrap(await remote.list(projectId)),
    read: async (projectId: string, path: string) => unwrap(await remote.read(projectId, path)),
    readContext: async (projectId: string) => unwrap(await remote.readContext(projectId)),
    create: async (projectId: string, path: string, text = '') => unwrap(await remote.create(projectId, path, text)),
    createDirectory: async (projectId: string, path: string) => unwrap(await remote.createDirectory(projectId, path)),
    save: async (projectId: string, path: string, text: string, version: string) => unwrap(await remote.save(projectId, path, text, version)),
    saveContext: async (projectId: string, text: string, version: string | null) => unwrap(await remote.saveContext(projectId, text, version)),
    rename: async (projectId: string, path: string, next: string) => unwrap(await remote.rename(projectId, path, next)),
    remove: async (projectId: string, path: string) => unwrap(await remote.remove(projectId, path)),
    listProposals: async (projectId: string) => unwrap(await remote.listProposals(projectId)),
    applyProposal: async (projectId: string, id: string, version: string | null) => unwrap(await remote.applyProposal(projectId, id, version)),
    discardProposal: async (projectId: string, id: string) => unwrap(await remote.discardProposal(projectId, id)),
    statVersion: async (projectId: string, path: string) => unwrap(await remote.statVersion(projectId, path)),
  }
}
export type RequirementsApi = ReturnType<typeof requirementsApi>
