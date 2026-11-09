import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import { diffWithCap, isValidSummary, ReadTracker } from '@eadp/contracts'
import type { RequirementDocument } from '@eadp/contracts/files'
import type { RequirementKnowledgeAdoption, RequirementKnowledgeCitation, RequirementProposal } from '@eadp/contracts/requirements'
import { parseKnowledgeAdoptions } from './adoption.ts'
import type { KnowledgeBasis } from './basis.ts'
import { RequirementFiles } from './files.ts'
import { RequirementKnowledgeError } from './knowledge-error.ts'
import type { PersistedProposal, ProposalStore } from './proposal-store.ts'
import type { KnowledgeSnapshots } from './snapshot.ts'

const nullableVersion = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const
const MAX_TEXT_CHARACTERS = 1_000_000

/** 已解析的提案：内存中的待审提案或项目内的持久记录，状态决定可用操作。 */
interface ResolvedProposal {
  proposal: RequirementProposal
  status: PersistedProposal['status']
  persisted: boolean
}

/**
 * 需求提案：把模型给出的整篇候选与显式关联的资料依据一起固定到项目，
 * 用户应用前不改变需求正文；应用时只按版本整篇写入。
 */
export class RequirementProposals {
  private readonly proposals = new Map<string, RequirementProposal>()
  private readonly reads = new ReadTracker<string>()
  private readonly installed = new WeakSet<Agent>()
  constructor(
    private readonly ctx: Context,
    private readonly files: RequirementFiles,
    private readonly store: ProposalStore,
    private readonly snapshots: KnowledgeSnapshots,
    private readonly basis: KnowledgeBasis,
    private readonly diagnostic: (message: string) => void,
  ) {}

  /** 待审提案：内存中的本次运行提案与项目内仍待审的持久提案合并返回。 */
  async list(projectId: string): Promise<RequirementProposal[]> {
    const merged = new Map<string, RequirementProposal>()
    for (const record of await this.store.list(projectId)) {
      if (record.status === 'pending') merged.set(record.proposal.proposalId, record.proposal)
    }
    for (const proposal of this.proposals.values()) if (proposal.projectId === projectId) merged.set(proposal.proposalId, proposal)
    return [...merged.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  /** 该文件最近的待审提案；内存与项目记录合并后取最新，没有时为空。 */
  async pending(projectId: string, relativePath: string): Promise<RequirementProposal | null> {
    const matches = (await this.list(projectId)).filter(proposal => proposal.relativePath === relativePath)
    return matches[matches.length - 1] ?? null
  }

  /** 新增或更新一份待审提案并持久化；依据未能保存到项目时必须阻断。 */
  async savePending(projectId: string, proposal: RequirementProposal): Promise<RequirementProposal> {
    const persisted = await this.persist(projectId, { ...proposal, persisted: false }, true)
    const saved: RequirementProposal = { ...proposal, persisted }
    this.proposals.set(saved.proposalId, saved)
    return saved
  }

  /** 丢弃提案并清理不再被任何待审或已应用提案引用的快照。 */
  async discard(projectId: string, proposalId: string): Promise<void> {
    await this.files.mutate(projectId, async () => {
      const resolved = await this.resolve(projectId, proposalId)
      if (resolved.status === 'applied') throw new FsError('该提案已应用，不能丢弃。', 'FS_NOT_OBSERVED')
      this.proposals.delete(proposalId)
      if (resolved.persisted) await this.store.update(projectId, proposalId, record => { record.status = 'discarded' })
      await this.cleanupSnapshots(projectId)
    })
  }

  /**
   * 应用提案：同一文件事务内校验基线版本，再整篇写入已含依据条目的正文。
   * 重复应用不会重复追加依据；文件已是候选正文时只补记提案状态。
   */
  async apply(projectId: string, proposalId: string, expectedVersion: string | null): Promise<RequirementDocument> {
    return this.files.mutate(projectId, async () => {
      const resolved = await this.resolve(projectId, proposalId)
      const proposal = resolved.proposal
      if (resolved.status === 'applied') return this.readDocument(projectId, proposal.relativePath)
      if (resolved.status === 'discarded') throw new FsError('该提案已被丢弃。', 'FS_NOT_FOUND')
      const current = await this.currentDocument(projectId, proposal.relativePath)
      if (current.version !== null && current.text === proposal.text) {
        this.proposals.delete(proposalId)
        await this.markApplied(projectId, resolved, current.version)
        return { relativePath: current.relativePath, text: current.text, version: current.version }
      }
      if (expectedVersion !== proposal.baseVersion || current.version !== proposal.baseVersion) throw new FsError('提案基于旧版本，请重新读取并生成。', 'FS_STALE_VERSION')
      await this.verifyCitations(projectId, proposal.citations)
      const document = await this.files.write(projectId, proposal.relativePath, proposal.text, expectedVersion, proposal.relativePath === 'CONTEXT.md')
      this.proposals.delete(proposalId)
      await this.markApplied(projectId, resolved, document.version)
      return document
    })
  }

  /** 启动核对：清理无任何待审/已应用提案引用的快照目录；失败只写诊断。 */
  async reconcile(): Promise<void> {
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      try {
        await this.files.mutate(workspace.id, () => this.cleanupSnapshots(workspace.id))
      } catch (error) {
        this.diagnostic(`项目需求依据启动核对失败：${workspace.path} ${String(error)}`)
      }
    }
  }

  /** Execution scope comes from the identity-protected Agent, never model arguments. */
  private async project(agent: Agent | undefined): Promise<string> {
    if (!agent || !['eadp-requirements', 'eadp-prototype'].includes(agent.session.header.agentPreset ?? '')) throw new FsError('当前会话不能提出需求修改。', 'FS_SANDBOX_DENIED')
    const cwd = agent.session.header.cwd
    const workspace = cwd ? await this.ctx.workspaceRegistry.resolveByPath(cwd) : undefined
    if (!workspace || await realpath(cwd!) !== workspace.path) throw new FsError('会话没有绑定有效项目。', 'FS_SANDBOX_DENIED')
    await this.files.root(workspace.id)
    return workspace.id
  }

  private async read(agent: Agent, relativePath: string, signal: AbortSignal, offset: number | undefined, length: number | undefined) {
    const start = offset ?? 0, size = length ?? 12000
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size < 1 || size > 24000) throw new FsError('offset 必须为非负整数，length 必须为 1–24000 的整数。', 'FS_NOT_TEXT')
    const projectId = await this.project(agent)
    let document: { relativePath: string; text: string; version: string | null }
    if (relativePath === 'CONTEXT.md' && await this.files.statVersion(projectId, relativePath) === null) document = { relativePath, text: '', version: null }
    else document = await this.files.read(projectId, relativePath, relativePath === 'CONTEXT.md')
    signal.throwIfAborted()
    this.reads.set(agent, projectId + '/' + relativePath, document.version)
    const characters = Array.from(document.text)
    const end = Math.min(start + size, characters.length)
    return { ...document, text: characters.slice(start, end).join(''), offset: start, truncated: end < characters.length, nextOffset: end < characters.length ? end : null }
  }

  /**
   * 生成提案并把依据固定到项目；有依据时快照和提案文件必须先写成功才返回。
   * 无依据的提案沿用原行为：持久化失败只标记 `persisted=false`。
   */
  private async propose(agent: Agent, relativePath: string, baseVersion: string | null, text: string, summary: string, citations: unknown, signal: AbortSignal) {
    signal.throwIfAborted()
    const projectId = await this.project(agent)
    const key = projectId + '/' + relativePath
    if (this.reads.get(agent, key) !== baseVersion) throw new FsError('必须先读取目标及当前版本，再生成提案。', 'FS_NOT_OBSERVED')
    if (text.length > MAX_TEXT_CHARACTERS || Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024 || text.includes('\0')) throw new FsError('提案正文过大或不是有效文本。', 'FS_TOO_LARGE')
    if (!isValidSummary(summary)) throw new FsError('提案摘要不能为空且不能超过 2000 字符。', 'FS_NOT_TEXT')
    const adoptions = parseKnowledgeAdoptions(citations)
    signal.throwIfAborted()
    return this.files.mutate(projectId, async () => {
      const current = await this.currentDocument(projectId, relativePath)
      signal.throwIfAborted()
      if (current.version !== baseVersion) throw new FsError('文件已变化，请重新生成提案。', 'FS_STALE_VERSION')
      const fixed = await this.fixCitations(projectId, agent.session.id, adoptions, text)
      signal.throwIfAborted()
      if (current.text === fixed.text) throw new FsError('提案与当前正文相同。', 'FS_NOT_TEXT')
      const { diff, truncated: diffTruncated } = diffWithCap(current.text, fixed.text)
      const proposal: RequirementProposal = {
        proposalId: randomUUID(),
        projectId,
        relativePath,
        baseVersion,
        text: fixed.text,
        baseText: current.text,
        summary,
        diff,
        diffTruncated,
        citations: fixed.citations,
        persisted: false,
        target: relativePath === 'CONTEXT.md' ? 'context' : 'requirement',
        createdAt: new Date().toISOString(),
        sessionId: agent.session.id,
      }
      proposal.persisted = await this.persist(projectId, proposal, fixed.citations.length > 0)
      this.proposals.set(proposal.proposalId, proposal)
      return { proposalId: proposal.proposalId, relativePath, summary }
    })
  }

  /** 持久化提案文件；有依据时失败必须阻断，避免返回未固定的依据。 */
  private async persist(projectId: string, proposal: RequirementProposal, required: boolean): Promise<boolean> {
    const record: PersistedProposal = {
      schemaVersion: 1,
      proposal: { ...proposal, persisted: true },
      target: proposal.target,
      baseVersion: proposal.baseVersion,
      createdAt: proposal.createdAt,
      sessionId: proposal.sessionId,
      status: 'pending',
    }
    try {
      await this.store.save(projectId, record)
      return true
    } catch (error) {
      this.diagnostic(`需求提案持久化失败：${String(error)}`)
      if (required) throw new RequirementKnowledgeError('提案或需求依据未能保存到项目，请重试。', 'SNAPSHOT_FAILED')
      return false
    }
  }

  /** 固定每份资料的当时内容，并把可读的「需求依据」章节渲染进候选正文。 */
  private async fixCitations(projectId: string, sessionId: string, adoptions: RequirementKnowledgeAdoption[], text: string): Promise<{ citations: RequirementKnowledgeCitation[]; text: string }> {
    if (adoptions.length === 0) return { citations: [], text }
    const resolutions = await this.basis.resolve(sessionId, projectId, adoptions)
    const fixed = await this.basis.fix(projectId, adoptions, resolutions)
    return { citations: fixed.citations, text: this.basis.render(text, fixed) }
  }

  /** 应用前核对全部固定内容仍完整；缺失时要求重新生成提案。 */
  private async verifyCitations(projectId: string, citations: readonly RequirementKnowledgeCitation[]): Promise<void> {
    for (const citation of citations) {
      try {
        await this.snapshots.read(projectId, citation.snapshotId)
      } catch {
        throw new RequirementKnowledgeError(`提案关联的《${citation.title}》当时内容不完整，请重新生成提案。`, 'SNAPSHOT_FAILED')
      }
    }
  }

  private async markApplied(projectId: string, resolved: ResolvedProposal, appliedVersion: string): Promise<void> {
    if (!resolved.persisted) return
    await this.store.update(projectId, resolved.proposal.proposalId, record => {
      record.status = 'applied'
      record.appliedAt = new Date().toISOString()
      record.appliedVersion = appliedVersion
    })
  }

  /** 解析提案：优先本次运行的待审内存提案，否则读取项目持久记录。 */
  private async resolve(projectId: string, proposalId: string): Promise<ResolvedProposal> {
    const memory = this.proposals.get(proposalId)
    if (memory !== undefined) {
      if (memory.projectId !== projectId) throw new FsError('提案不存在或不属于当前项目。', 'FS_NOT_FOUND')
      return { proposal: memory, status: 'pending', persisted: memory.persisted }
    }
    const record = await this.store.read(projectId, proposalId)
    if (record === null) throw new FsError('提案不存在或不属于当前项目。', 'FS_NOT_FOUND')
    return { proposal: record.proposal, status: record.status, persisted: true }
  }

  /** 当前正文；不存在的 CONTEXT.md 视为空正文与 null 版本。 */
  private async currentDocument(projectId: string, relativePath: string): Promise<{ relativePath: string; text: string; version: string | null }> {
    if (relativePath === 'CONTEXT.md' && await this.files.statVersion(projectId, relativePath) === null) {
      return { relativePath, text: '', version: null }
    }
    return this.files.read(projectId, relativePath, relativePath === 'CONTEXT.md')
  }

  /** 读取已应用提案的目标正文；CONTEXT.md 由文件层读取。 */
  private async readDocument(projectId: string, relativePath: string): Promise<RequirementDocument> {
    return this.files.read(projectId, relativePath, relativePath === 'CONTEXT.md')
  }

  /** 只保留仍被待审或已应用提案引用的快照。 */
  private async cleanupSnapshots(projectId: string): Promise<void> {
    const referenced = new Set<string>()
    for (const record of await this.store.list(projectId)) {
      if (record.status !== 'pending' && record.status !== 'applied') continue
      for (const citation of record.proposal.citations) referenced.add(citation.snapshotId)
    }
    await this.snapshots.cleanup(projectId, referenced)
  }

  install(agent: Agent): void {
    if (this.installed.has(agent)) return
    this.installed.add(agent)
    if (!['eadp-requirements', 'eadp-prototype'].includes(agent.session.header.agentPreset ?? '')) return
    const scope = agent.ctx
    this.ctx.effect(() => scope.tools.register(defineTool({
      name: 'eadp_requirements_list', description: '列出当前本地项目需求 Markdown 文件，CONTEXT.md 是独立项目背景。', parameters: {},
      output: { schema: { type: 'object', properties: { entries: { type: 'array', required: true, items: { type: 'object', properties: { relativePath: { type: 'string', required: true }, name: { type: 'string', required: true }, type: { type: 'string', required: true } }, additionalProperties: false } } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (_args, exec) => { exec.signal.throwIfAborted(); if (exec.agent !== agent) throw new FsError('工具会话身份不匹配。', 'FS_SANDBOX_DENIED'); const projectId = await this.project(exec.agent); const entries = await this.files.list(projectId); if (await this.files.statVersion(projectId, 'CONTEXT.md') !== null) entries.push({ relativePath: 'CONTEXT.md', name: 'CONTEXT.md', type: 'file' }); exec.signal.throwIfAborted(); return { entries: entries.map(({ relativePath, name, type }) => ({ relativePath, name, type })) } },
    })))
    this.ctx.effect(() => scope.tools.register(defineTool({
      name: 'eadp_requirement_read', description: '读取需求或 CONTEXT.md 正文与完整文件的不透明版本；修改前必须读取。offset 从 0 开始，单位是 Unicode 字符；length 默认 12000，上限 24000，按 nextOffset 续读。不存在的 CONTEXT.md 返回空正文及 null 版本。',
      parameters: { relativePath: { type: 'string', required: true }, offset: { type: 'integer', description: '从 0 开始的 Unicode 字符位置。' }, length: { type: 'integer', description: '读取 Unicode 字符数量，默认 12000，上限 24000。' } },
      output: { schema: { type: 'object', properties: { relativePath: { type: 'string', required: true }, text: { type: 'string', required: true }, version: { ...nullableVersion, required: true }, offset: { type: 'integer', required: true }, truncated: { type: 'boolean', required: true }, nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => { exec.signal.throwIfAborted(); if (exec.agent !== agent) throw new FsError('工具会话身份不匹配。', 'FS_SANDBOX_DENIED'); return this.read(agent, args.relativePath, exec.signal, args.offset, args.length) },
    })))
    this.ctx.effect(() => scope.tools.register(defineTool({
      name: 'eadp_requirement_propose',
      description: '提出单文件整篇需求/项目背景修改；只生成待用户审阅的提案，不写需求正文。baseVersion必须来自本会话先前读取。要把知识作为需求依据时，先在本次会话读取知识，再在 citations 中为每份资料给出本次实际读取的范围（Unicode 字符偏移）和非空的采用说明；范围必须来自本次读取，采用说明说明为什么把它作为需求依据。不关联知识时省略 citations。',
      parameters: {
        relativePath: { type: 'string', required: true },
        baseVersion: { ...nullableVersion, required: true },
        text: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        citations: {
          type: 'array',
          description: '显式关联的知识采用项；省略表示本次提案不关联依据。',
          items: {
            type: 'object',
            properties: {
              evidenceId: { type: 'string', required: true, description: '本次会话读取知识时返回的标识。' },
              ranges: {
                type: 'array', required: true,
                items: { type: 'object', properties: { start: { type: 'integer', required: true }, end: { type: 'integer', required: true } }, additionalProperties: false },
                description: '本次实际读取到的 Unicode 字符范围。',
              },
              note: { type: 'string', required: true, description: '采用说明，非空且不超过 500 字。' },
            },
            additionalProperties: false,
          },
        },
      },
      output: { schema: { type: 'object', properties: { proposalId: { type: 'string', required: true }, relativePath: { type: 'string', required: true }, summary: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: `提案已生成，等待用户审阅：${value.summary}（${value.proposalId}）` }] },
      execute: async (args, exec) => { exec.signal.throwIfAborted(); if (exec.agent !== agent) throw new FsError('工具会话身份不匹配。', 'FS_SANDBOX_DENIED'); return this.propose(agent, args.relativePath, args.baseVersion, args.text, args.summary, args.citations, exec.signal) },
    })))
  }
  dispose(): void { this.proposals.clear() }
}
