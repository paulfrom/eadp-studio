import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { KnowledgeDraft, KnowledgePackId } from '@eadp/contracts/knowledge'
import type {} from '@eadp/knowledge/remote'
function unwrap<T>(reply: RemoteResult<T>): T {
  if (!reply.ok) throw reply.error
  return reply.value
}
/** Uses only the generated Host surface and preserves remote error details. */
export function knowledgeApi(ctx: Context) {
  const remote = ctx.remote.eadpKnowledge
  return {
    catalog: async () => unwrap(await remote.catalog()),
    search: async (query: string, limit: number, pack: 'all' | KnowledgePackId) =>
      unwrap(await remote.search(query, limit, pack)),
    read: async (
      pack: KnowledgePackId,
      id: string,
      version: string | null,
      offset: number,
      length: number,
    ) => unwrap(await remote.read(pack, id, version, offset, length)),
    save: async (id: string | null, version: string, draft: KnowledgeDraft) =>
      unwrap(await remote.saveUserCard(id, version, draft)),
    remove: async (id: string, version: string) => unwrap(await remote.removeUserCard(id, version)),
    repair: async () => unwrap(await remote.repairUserPack()),
    proposals: async () => unwrap(await remote.listProposals()),
    apply: async (id: string, version: string) => unwrap(await remote.applyProposal(id, version)),
    discard: async (id: string) => unwrap(await remote.discardProposal(id)),
  }
}
export type KnowledgeApi = ReturnType<typeof knowledgeApi>
