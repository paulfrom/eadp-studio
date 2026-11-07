import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-workspace'
import type { FileErrorCode, RequirementDocument, RequirementEntry, ContextDocument } from '@eadp/contracts/files'
import { failureMessage, isRemoteCancellation, mapFailureCode } from '@eadp/contracts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { RequirementProposal } from '@eadp/contracts/requirements'
import { RequirementProposals } from './proposals.ts'
import { RequirementFiles } from './files.ts'

export const name = 'eadp-requirements'
export const inject = ['typert', 'workspaceRegistry', 'fs', 'agents', 'tools']

/** Trusted user editing API; none of these methods is registered as an Agent tool. */
export class RequirementsService extends TypertRemoteService {
  private readonly files: RequirementFiles
  private readonly proposals: RequirementProposals
  constructor(ctx: Context) {
    super(ctx, 'eadpRequirements', { namespace: 'eadpRequirements' })
    this.files = new RequirementFiles(ctx)
    this.proposals = new RequirementProposals(ctx, this.files)
    ctx.on('agent/created', ({ agent }) => { this.proposals.install(agent) })
    for (const agent of ctx.agents.list()) this.proposals.install(agent)
    ctx.effect(() => () => this.proposals.dispose())
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
    await this.run(async () => { await this.files.root(projectId); this.proposals.discard(projectId, proposalId) })
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
      }
      throw new RemoteError('eadp/file', failureMessage(error, '文件操作失败。'), { code: mapFailureCode(error, codes, 'IO_ERROR') })
    }
  }

}

export function apply(ctx: Context): void { ctx.plugin(RequirementsService) }
