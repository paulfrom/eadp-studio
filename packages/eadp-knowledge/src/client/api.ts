import type { Context } from '@deepseek-ai/cordis'
import { unwrapRemoteResult } from '@eadp/contracts'
import type { KnowledgeDraft, KnowledgePackId } from '@eadp/contracts/knowledge'
import type {} from '@eadp/knowledge/remote'
/** Uses only the generated Host surface and preserves remote error details. */
export function knowledgeApi(ctx: Context) {
  const remote = ctx.remote.eadpKnowledge
  return {
    catalog: async () => unwrapRemoteResult(await remote.catalog()),
    search: async (query: string, limit: number, pack: 'all' | KnowledgePackId) =>
      unwrapRemoteResult(await remote.search(query, limit, pack)),
    read: async (
      pack: KnowledgePackId,
      id: string,
      version: string | null,
      offset: number,
      length: number,
    ) => unwrapRemoteResult(await remote.read(pack, id, version, offset, length)),
    save: async (id: string | null, version: string, draft: KnowledgeDraft) =>
      unwrapRemoteResult(await remote.saveUserCard(id, version, draft)),
    remove: async (id: string, version: string) => unwrapRemoteResult(await remote.removeUserCard(id, version)),
    repair: async () => unwrapRemoteResult(await remote.repairUserPack()),
    proposals: async () => unwrapRemoteResult(await remote.listProposals()),
    apply: async (id: string, version: string) => unwrapRemoteResult(await remote.applyProposal(id, version)),
    discard: async (id: string) => unwrapRemoteResult(await remote.discardProposal(id)),
  }
}
export type KnowledgeApi = ReturnType<typeof knowledgeApi>
