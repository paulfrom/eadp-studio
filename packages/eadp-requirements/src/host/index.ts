import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-workspace'
import type { FileErrorCode, RequirementDocument, RequirementEntry, ContextDocument } from '@eadp/contracts/files'
import type { RequirementKnowledgeBasis, RequirementProposal } from '@eadp/contracts/requirements'
import { failureMessage, isRemoteCancellation, mapFailureCode } from '@eadp/contracts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@eadp/knowledge'
import { RequirementProposals } from './proposals.ts'
import { RequirementFiles } from './files.ts'
import { ProposalStore } from './proposal-store.ts'
import { KnowledgeSnapshots } from './snapshot.ts'
import { RequirementKnowledgeBasis as KnowledgeBasisReader } from './knowledge-basis.ts'

export const name = 'eadp-requirements'
export const inject = ['typert', 'workspaceRegistry', 'fs', 'agents', 'tools', 'eadpKnowledgeReference']

/** Trusted user editing API; none of these methods is registered as an Agent tool. */
export class RequirementsService extends TypertRemoteService {
  private readonly files: RequirementFiles
  private readonly proposals: RequirementProposals
  private readonly basis: KnowledgeBasisReader
  constructor(ctx: Context) {
    super(ctx, 'eadpRequirements', { namespace: 'eadpRequirements' })
    const diagnostic = (message: string) => ctx.logger.warn(message)
    this.files = new RequirementFiles(ctx)
    const store = new ProposalStore(this.files, diagnostic)
    const snapshots = new KnowledgeSnapshots(this.files, diagnostic)
    this.proposals = new RequirementProposals(ctx, this.files, store, snapshots, diagnostic)
    this.basis = new KnowledgeBasisReader(ctx, this.files, store, snapshots)
    ctx.on('agent/created', ({ agent }) => { this.proposals.install(agent) })
    for (const agent of ctx.agents.list()) this.proposals.install(agent)
    ctx.effect(() => () => this.proposals.dispose())
    // 启动核对只清理无任何提案引用的当时内容；失败只写诊断，不阻断界面。
    void this.proposals.reconcile().catch(error => ctx.logger.error(`需求依据启动核对失败：${String(error)}`))
  }

  @Remote
  async list(projectId: string): Promise<RequirementEntry[]> { return this.run(() => this.files.list(projectId)) }

  @Remote
  async read(projectId: string, relativePath: string): Promise<RequirementDocument> { return this.run(() => this.files.read(projectId, relativePath)) }

  @Remote
  async createDirectory(projectId: string, relativePath: string): Promise<void> {
    await this.run(() => this.files.mutate(projectId, () => this.files.makeDirectory(projectId, relativePath)))
  }

  @Remote
  async create(projectId: string, relativePath: string, text: string): Promise<RequirementDocument> {
    const target = relativePath.toLowerCase().endsWith('.md') ? relativePath : relativePath + '.md'
    return this.run(() => this.files.mutate(projectId, () => this.files.write(projectId, target, text, null)))
  }

  @Remote
  async save(projectId: string, relativePath: string, text: string, expectedVersion: string): Promise<RequirementDocument> {
    return this.run(() => this.files.mutate(projectId, () => this.files.write(projectId, relativePath, text, expectedVersion)))
  }

  @Remote
  async rename(projectId: string, relativePath: string, newRelativePath: string): Promise<string> {
    const target = newRelativePath.toLowerCase().endsWith('.md') ? newRelativePath : newRelativePath + '.md'
    await this.run(() => this.files.mutate(projectId, () => this.files.rename(projectId, relativePath, target)))
    return target
  }

  @Remote
  async removeEntry(projectId: string, relativePath: string): Promise<void> {
    await this.run(() => this.files.mutate(projectId, () => this.files.remove(projectId, relativePath)))
  }

  @Remote
  async readContext(projectId: string): Promise<ContextDocument> {
    return this.run(async () => {
      if (await this.files.statVersion(projectId, 'CONTEXT.md') === null) return { kind: 'absent' }
      const document = await this.files.read(projectId, 'CONTEXT.md', true)
      return { kind: 'present', ...document }
    })
  }

  @Remote
  async saveContext(projectId: string, text: string, expectedVersion: string | null): Promise<RequirementDocument> {
    return this.run(() => this.files.mutate(projectId, () => this.files.write(projectId, 'CONTEXT.md', text, expectedVersion, true)))
  }

  @Remote
  async statVersion(projectId: string, relativePath: string): Promise<string | null> {
    return this.run(() => this.files.statVersion(projectId, relativePath))
  }
  @Remote
  async listProposals(projectId: string): Promise<RequirementProposal[]> {
    return this.run(async () => { await this.files.root(projectId); return this.proposals.list(projectId) })
  }

  @Remote
  async applyProposal(projectId: string, proposalId: string, expectedVersion: string | null): Promise<RequirementDocument> {
    return this.run(() => this.proposals.apply(projectId, proposalId, expectedVersion))
  }

  @Remote
  async discardProposal(projectId: string, proposalId: string): Promise<void> {
    await this.run(() => this.proposals.discard(projectId, proposalId))
  }

  /** 已应用需求依据的回读：资料更新或删除后仍返回当时内容。 */
  @Remote
  async knowledgeBasis(projectId: string, relativePath: string): Promise<RequirementKnowledgeBasis> {
    return this.run(() => this.basis.read(projectId, relativePath))
  }

  /** 需求会话的「自动参考知识」偏好；委托知识服务持久化，默认开启。 */
  @Remote
  async knowledgeAutoReference(sessionId: string): Promise<boolean> {
    return this.run(() => { this.checkSession(sessionId); return this.ctx.eadpKnowledgeReference.autoReferenceFor(sessionId) })
  }

  @Remote
  async setKnowledgeAutoReference(sessionId: string, enabled: boolean): Promise<void> {
    await this.run(() => { this.checkSession(sessionId); return this.ctx.eadpKnowledgeReference.setAutoReferenceFor(sessionId, enabled) })
  }

  private checkSession(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 200) throw new FsError('需求会话标识无效。', 'FS_NOT_TEXT')
  }

  /** Keep filesystem failures machine-readable across the official Remote transport. */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch (error) {
      if (isRemoteCancellation(error)) throw new RemoteError('gateway/cancelled', '文件操作已取消。', {})
      const codes: Record<string, FileErrorCode> = {
        INVALID_PATH: 'INVALID_PATH', PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND', FS_NOT_FOUND: 'NOT_FOUND', ENOENT: 'NOT_FOUND', FS_NOT_OBSERVED: 'EXISTS', EEXIST: 'EXISTS',
        FS_STALE_VERSION: 'STALE_VERSION', FS_SANDBOX_DENIED: 'OUTSIDE_PROJECT', FS_PERMISSION_DENIED: 'PERMISSION_DENIED',
        EACCES: 'PERMISSION_DENIED', EPERM: 'PERMISSION_DENIED', FS_TOO_LARGE: 'TOO_LARGE', FS_NOT_TEXT: 'NOT_TEXT',
        FS_NOT_DIRECTORY: 'INVALID_PATH', FS_NOT_REGULAR_FILE: 'INVALID_PATH', ENOTDIR: 'INVALID_PATH', EINVAL: 'INVALID_PATH',
        EVIDENCE_INVALID: 'EVIDENCE_INVALID', SNAPSHOT_FAILED: 'SNAPSHOT_FAILED',
      }
      throw new RemoteError('eadp/file', failureMessage(error, '文件操作失败。'), { code: mapFailureCode(error, codes, 'IO_ERROR') })
    }
  }

}

export function apply(ctx: Context): void { ctx.plugin(RequirementsService) }
