import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { KnowledgeCatalog, KnowledgeDraft, KnowledgePackId, KnowledgeProposal, KnowledgeRead, KnowledgeSearchResult } from '@eadp/contracts/knowledge'
import { failureMessage, isRemoteCancellation } from '@eadp/contracts'
import { KnowledgeStore, KnowledgeError } from './store.ts'
import { KnowledgeProposals } from './proposals.ts'
export const name = 'eadp-knowledge'
export const inject = ['typert', 'agents', 'tools']
/** 向可信界面提供本地知识操作，不向 Agent 暴露直接写入能力。 */
export class KnowledgeService extends TypertRemoteService {
  private store: KnowledgeStore
  private proposals: KnowledgeProposals
  constructor(ctx: Context) {
    super(ctx, 'eadpKnowledge', {
      namespace: 'eadpKnowledge'
    })
    this.store = new KnowledgeStore(message => ctx.logger.error(message))
    this.proposals = new KnowledgeProposals(ctx, this.store)
    ctx.on('agent/created', ({ agent }) => {
      this.proposals.install(agent)
    })
    for (const agent of ctx.agents.list())
      this.proposals.install(agent)
    ctx.effect(() => () => this.proposals.dispose())
  }

  /** 将操作错误转换为界面可识别的 Remote 错误。 */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    }
    catch (error) {
      if (isRemoteCancellation(error))
        throw new RemoteError('gateway/cancelled', '知识操作已取消。', {})
      throw new RemoteError('eadp/knowledge', failureMessage(error, '知识操作失败。'), {
        code: error instanceof KnowledgeError ? error.code : 'UNAVAILABLE'
      })
    }
  }
  @Remote
  async catalog(): Promise<KnowledgeCatalog> {
    return this.run(() => this.store.catalog())
  }
  @Remote
  async search(query: string, limit: number, pack: 'all' | KnowledgePackId): Promise<KnowledgeSearchResult> {
    return this.run(() => this.store.search(query, limit, pack))
  }
  @Remote
  async read(packId: KnowledgePackId, id: string, expectedV: string | null, offset: number, length: number): Promise<KnowledgeRead> {
    return this.run(() => this.store.read(packId, id, expectedV, offset, length))
  }
  @Remote
  async saveUserCard(id: string | null, expectedV: string, draft: KnowledgeDraft): Promise<KnowledgeRead> {
    return this.run(() => this.store.mutate(() => this.store.save(id, expectedV, draft)))
  }
  @Remote
  async removeUserCard(id: string, expectedV: string): Promise<void> {
    return this.run(() => this.store.mutate(() => this.store.remove(id, expectedV)))
  }
  @Remote
  async repairUserPack(): Promise<KnowledgeCatalog> {
    return this.run(() => this.store.mutate(() => this.store.repair()))
  }
  @Remote
  async listProposals(): Promise<KnowledgeProposal[]> {
    return this.run(async () => this.proposals.list())
  }
  @Remote
  async applyProposal(id: string, expectedV: string): Promise<KnowledgeRead> {
    return this.run(() => this.proposals.apply(id, expectedV))
  }
  @Remote
  async discardProposal(id: string): Promise<void> {
    return this.run(async () => this.proposals.discard(id))
  }
}
export function apply(ctx: Context): void {
  ctx.plugin(KnowledgeService)
}
