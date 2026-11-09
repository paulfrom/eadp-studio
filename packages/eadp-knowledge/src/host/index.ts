import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  KnowledgeCatalog,
  KnowledgeDocument,
  KnowledgeDraft,
  KnowledgeDraftResource,
  KnowledgeImportFile,
  KnowledgeImportReceipt,
  KnowledgeImports as KnowledgeImportList,
  KnowledgePackId,
  KnowledgeProposal,
  KnowledgeSourceView,
} from '@eadp/contracts/knowledge'
import { failureMessage, isRemoteCancellation } from '@eadp/contracts'
import { KnowledgeStore, KnowledgeError } from './store.ts'
import { KnowledgeImports } from './imports.ts'
import { KnowledgeProposals } from './proposals.ts'
import { SessionPreferences } from './preferences.ts'
import { KnowledgeReference } from './reference.ts'
import { TurnReferences } from './turn-references.ts'
import { KnowledgeInjection } from './injection.ts'
import { KnowledgeIndex } from './index/indexer.ts'
import { requestKnowledgeTags } from './tagger.ts'

export const name = 'eadp-knowledge'
export const inject = ['typert', 'agents', 'tools', 'llm', 'agentDefaultModel', 'sessionProjections', 'eadpProjectContext']

/** 向可信界面提供本机资料、导入记录与待审建议；不向 Agent 暴露写入或文件接口。 */
export class KnowledgeService extends TypertRemoteService {
  private readonly store: KnowledgeStore
  private readonly importQueue: KnowledgeImports
  private readonly proposals: KnowledgeProposals
  private readonly reference: KnowledgeReference
  private readonly index: KnowledgeIndex
  private readonly organizing = new Set<string>()
  /** 已登记索引的导入完成项；键为资料编号与更新时间的组合。 */
  private readonly enqueuedImports = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'eadpKnowledge', { namespace: 'eadpKnowledge' })
    const diagnostic = (message: string) => ctx.logger.error(message)
    this.store = new KnowledgeStore(diagnostic)
    this.importQueue = new KnowledgeImports(ctx, this.store, diagnostic)
    const preferences = new SessionPreferences(this.store.userRoot, diagnostic)
    // 参考服务先于索引与建议服务创建：后两者只依赖已声明的服务实例。
    const turns = new TurnReferences()
    this.reference = new KnowledgeReference(ctx, this.store, preferences, turns)
    this.index = new KnowledgeIndex(ctx, this.store, diagnostic)
    this.proposals = new KnowledgeProposals(ctx, this.store, this.reference, this.index)
    const injection = new KnowledgeInjection(ctx, this.store, this.reference, this.index, turns)
    injection.install()
    ctx.on('agent/created', ({ agent }) => {
      this.proposals.install(agent)
    })
    for (const agent of ctx.agents.list()) this.proposals.install(agent)
    ctx.effect(() => () => {
      this.proposals.dispose()
      void this.index.dispose()
      void this.importQueue.dispose()
    })
    // 启动核对只补建可判定的处理，不删除未知文件；失败只写诊断。
    void this.store
      .mutate(() => this.store.reconcile())
      .catch(error => ctx.logger.error(`资料启动核对失败：${String(error)}`))
    this.index.start()
    void this.importQueue.resume().catch(error => ctx.logger.error(`导入记录恢复失败：${String(error)}`))
  }

  /** 把操作错误转换为界面可识别的 Remote 错误。 */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (isRemoteCancellation(error)) throw new RemoteError('gateway/cancelled', '知识操作已取消。', {})
      throw new RemoteError('eadp/knowledge', failureMessage(error, '知识操作失败。'), {
        code: error instanceof KnowledgeError ? error.code : 'UNAVAILABLE',
      })
    }
  }

  /**
   * 保存后异步整理主题标签；失败只把资料标成“自动整理未完成”，不影响正文。
   * 标签变化同样会影响查找结果，因此整理结束后再登记一次索引。
   * @param saved - 本次已提交的资料快照，标签基于它的内容身份回写。
   */
  private organize(saved: KnowledgeDocument): void {
    const key = `${saved.documentId}:${saved.contentRevisionId}`
    if (this.organizing.has(key)) return
    this.organizing.add(key)
    void (async () => {
      try {
        const tags = await requestKnowledgeTags(this.ctx, {
          title: saved.title,
          category: saved.category,
          scope: saved.scope,
          excerpt: saved.text,
        })
        const summary = await this.store.mutate(() =>
          this.store.updateTags(saved.documentId, saved.contentRevisionId, tags, 'ready'))
        if (summary !== null) this.enqueueIndex(summary)
      } catch (error) {
        this.ctx.logger.warn(`资料主题整理未完成：${String(error)}`)
        try {
          const summary = await this.store.mutate(() =>
            this.store.updateTags(saved.documentId, saved.contentRevisionId, [], 'failed'))
          if (summary !== null) this.enqueueIndex(summary)
        } catch (reason) {
          this.ctx.logger.error(`资料整理状态回写失败：${String(reason)}`)
        }
      } finally {
        this.organizing.delete(key)
      }
    })()
  }

  /** 登记查找索引；失败只写诊断，不影响已提交的保存结果。 */
  private enqueueIndex(document: { packId: KnowledgePackId; documentId: string; contentRevisionId: string }): void {
    try {
      this.index.enqueue(document)
    } catch (error) {
      this.ctx.logger.error(`资料查找索引登记失败：${String(error)}`)
    }
  }

  /** 资料删除后立即退出查找准入并清理衍生数据；失败只写诊断。 */
  private removeIndex(documentId: string): void {
    try {
      this.index.remove('user', documentId)
    } catch (error) {
      this.ctx.logger.error(`资料查找索引清理失败：${String(error)}`)
    }
  }

  /** 导入完成后按清单当前版本登记索引；版本读取失败只写诊断。 */
  private async enqueueImportedDocument(documentId: string): Promise<void> {
    try {
      const revision = await this.store.currentRevision('user', documentId)
      if (revision !== null) this.enqueueIndex({ packId: 'user', documentId, contentRevisionId: revision })
    } catch (error) {
      this.ctx.logger.error(`导入资料查找索引登记失败：${documentId}：${String(error)}`)
    }
  }

  /** 导入完成项按更新时间去重，避免界面轮询重复登记同一份资料。 */
  private async enqueueImportedItems(items: readonly { status: string; documentId?: string | undefined; updatedAt: string }[]): Promise<void> {
    for (const item of items) {
      if (item.status !== 'imported' || item.documentId === undefined) continue
      const key = `${item.documentId}:${item.updatedAt}`
      if (this.enqueuedImports.has(key)) continue
      this.enqueuedImports.add(key)
      await this.enqueueImportedDocument(item.documentId)
    }
  }

  @Remote
  async catalog(): Promise<KnowledgeCatalog> {
    return this.run(() => this.store.catalog())
  }

  @Remote
  async readDocument(packId: KnowledgePackId, documentId: string, expectedRevisionId: string | null): Promise<KnowledgeDocument> {
    return this.run(() => this.store.readDocument(packId, documentId, expectedRevisionId))
  }

  @Remote
  async readResource(packId: KnowledgePackId, documentId: string, expectedRevisionId: string | null, path: string): Promise<Uint8Array> {
    return this.run(() => this.store.readResource(packId, documentId, expectedRevisionId, path))
  }

  @Remote
  async saveDocument(
    documentId: string | null,
    expectedRevisionId: string | null,
    draft: KnowledgeDraft,
    resources: KnowledgeDraftResource[],
  ): Promise<KnowledgeDocument> {
    return this.run(async () => {
      const saved = await this.store.mutate(() => this.store.saveDocument(documentId, expectedRevisionId, draft, resources))
      this.enqueueIndex(saved)
      this.organize(saved)
      return saved
    })
  }

  @Remote
  async setAutoReference(
    packId: KnowledgePackId,
    documentId: string,
    expectedRevisionId: string,
    autoReference: boolean,
  ): Promise<void> {
    return this.run(async () => {
      await this.store.mutate(() => this.store.setAutoReference(packId, documentId, expectedRevisionId, autoReference))
    })
  }

  @Remote
  async removeDocument(documentId: string, expectedRevisionId: string): Promise<void> {
    return this.run(async () => {
      await this.store.mutate(() => this.store.removeDocument(documentId, expectedRevisionId))
      this.removeIndex(documentId)
    })
  }

  @Remote
  async copyBuiltin(documentId: string, expectedRevisionId: string): Promise<KnowledgeDocument> {
    return this.run(async () => {
      const saved = await this.store.mutate(() => this.store.copyBuiltin(documentId, expectedRevisionId))
      this.enqueueIndex(saved)
      return saved
    })
  }

  @Remote
  async retagDocument(documentId: string, expectedRevisionId: string): Promise<void> {
    return this.run(async () => {
      await this.store.mutate(() => this.store.setOrganize(documentId, expectedRevisionId, 'pending'))
      const document = await this.store.readDocument('user', documentId, expectedRevisionId)
      this.organize(document)
    })
  }

  @Remote
  async imports(): Promise<KnowledgeImportList> {
    return this.run(async () => {
      const list = await this.importQueue.list()
      await this.enqueueImportedItems(list.items)
      return list
    })
  }

  @Remote
  async importFiles(files: KnowledgeImportFile[]): Promise<KnowledgeImportReceipt[]> {
    return this.run(async () => {
      const receipts = await this.importQueue.importFiles(files)
      // 少数原件可能当场完成转换，其余在后续列表查询中登记索引。
      for (const receipt of receipts) {
        if (receipt.status === 'imported' && receipt.documentId !== undefined) await this.enqueueImportedDocument(receipt.documentId)
      }
      return receipts
    })
  }

  @Remote
  async retryImport(importId: string): Promise<void> {
    return this.run(() => this.importQueue.retry(importId))
  }

  @Remote
  async cancelImport(importId: string): Promise<void> {
    return this.run(() => this.importQueue.cancel(importId))
  }

  @Remote
  async clearFinishedImports(): Promise<void> {
    return this.run(() => this.importQueue.clearFinished())
  }

  @Remote
  async sourceView(importId: string): Promise<KnowledgeSourceView> {
    return this.run(() => this.importQueue.sourceView(importId))
  }

  @Remote
  async saveManualDocument(importId: string, draft: KnowledgeDraft, resources: KnowledgeDraftResource[]): Promise<KnowledgeDocument> {
    return this.run(async () => {
      const saved = await this.importQueue.saveManual(importId, draft, resources)
      this.enqueueIndex(saved)
      this.organize(saved)
      return saved
    })
  }

  @Remote
  async listProposals(): Promise<KnowledgeProposal[]> {
    return this.run(async () => this.proposals.list())
  }

  @Remote
  async applyProposal(proposalId: string, expectedRevisionId: string | null): Promise<KnowledgeDocument> {
    return this.run(async () => {
      const saved = await this.proposals.apply(proposalId, expectedRevisionId)
      this.enqueueIndex(saved)
      this.organize(saved)
      return saved
    })
  }

  @Remote
  async discardProposal(proposalId: string): Promise<void> {
    return this.run(async () => this.proposals.discard(proposalId))
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(KnowledgeService)
}

/** 导出服务实现类型，使依赖方读到 `Context.eadpKnowledgeReference` 的服务声明。 */
export { KnowledgeReference } from './reference.ts'

/** 导出索引服务实现类型，使依赖方读到 `Context.eadpKnowledgeIndex` 的服务声明。 */
export { KnowledgeIndex } from './index/indexer.ts'
