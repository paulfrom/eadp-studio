import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import { diffWithCap, isValidSummary, ReadTracker } from '@eadp/contracts'
import type { RequirementDocument } from '@eadp/contracts/files'
import type { RequirementProposal } from '@eadp/contracts/requirements'
import { RequirementFiles } from './files.ts'

const nullableVersion = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const

/** Keeps AI candidates in Host memory; only trusted UI application mutates files. */
export class RequirementProposals {
  private readonly proposals = new Map<string, RequirementProposal>()
  private readonly reads = new ReadTracker<string>()
  private readonly installed = new WeakSet<Agent>()
  constructor(private readonly ctx: Context, private readonly files: RequirementFiles) {}

  list(projectId: string): RequirementProposal[] { return [...this.proposals.values()].filter(value => value.projectId === projectId) }
  discard(projectId: string, proposalId: string): void {
    this.get(projectId, proposalId)
    this.proposals.delete(proposalId)
  }
  private get(projectId: string, proposalId: string): RequirementProposal {
    const proposal = this.proposals.get(proposalId)
    if (!proposal || proposal.projectId !== projectId) throw new FsError('提案不存在或不属于当前项目。', 'FS_NOT_FOUND')
    return proposal
  }
  async apply(projectId: string, proposalId: string, expectedVersion: string | null): Promise<RequirementDocument> {
    return this.files.mutate(projectId, async () => {
      const proposal = this.get(projectId, proposalId)
      if (expectedVersion !== proposal.baseVersion || await this.files.statVersion(projectId, proposal.relativePath) !== proposal.baseVersion) throw new FsError('提案基于旧版本，请重新读取并生成。', 'FS_STALE_VERSION')
      const document = await this.files.write(projectId, proposal.relativePath, proposal.text, expectedVersion, proposal.relativePath === 'CONTEXT.md')
      this.proposals.delete(proposalId)
      return document
    })
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

  private async propose(agent: Agent, relativePath: string, baseVersion: string | null, text: string, summary: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const projectId = await this.project(agent)
    const key = projectId + '/' + relativePath
    if (this.reads.get(agent, key) !== baseVersion) throw new FsError('必须先读取目标及当前版本，再生成提案。', 'FS_NOT_OBSERVED')
    if (text.length > 1_000_000 || Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024 || text.includes('\0')) throw new FsError('提案正文过大或不是有效文本。', 'FS_TOO_LARGE')
    if (!isValidSummary(summary)) throw new FsError('提案摘要不能为空且不能超过 2000 字符。', 'FS_NOT_TEXT')
    const current = relativePath === 'CONTEXT.md' && await this.files.statVersion(projectId, relativePath) === null
      ? { relativePath, text: '', version: null }
      : await this.files.read(projectId, relativePath, relativePath === 'CONTEXT.md')
    signal.throwIfAborted()
    if (current.version !== baseVersion) throw new FsError('文件已变化，请重新生成提案。', 'FS_STALE_VERSION')
    if (current.text === text) throw new FsError('提案与当前正文相同。', 'FS_NOT_TEXT')
    const { diff, truncated: diffTruncated } = diffWithCap(current.text, text)
    const proposal: RequirementProposal = { proposalId: randomUUID(), projectId, relativePath, baseVersion, text, baseText: current.text, summary, diff, diffTruncated, target: relativePath === 'CONTEXT.md' ? 'context' : 'requirement', createdAt: new Date().toISOString(), sessionId: agent.session.id }
    signal.throwIfAborted()
    this.proposals.set(proposal.proposalId, proposal)
    return { proposalId: proposal.proposalId, relativePath, summary }
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
      name: 'eadp_requirement_propose', description: '提出单文件整篇需求/项目背景修改；只生成待用户审阅的内存提案，不写文件。baseVersion必须来自本会话先前读取。',
      parameters: { relativePath: { type: 'string', required: true }, baseVersion: { ...nullableVersion, required: true }, text: { type: 'string', required: true }, summary: { type: 'string', required: true } },
      output: { schema: { type: 'object', properties: { proposalId: { type: 'string', required: true }, relativePath: { type: 'string', required: true }, summary: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: `提案已生成，等待用户审阅：${value.summary}（${value.proposalId}）` }] },
      execute: async (args, exec) => { exec.signal.throwIfAborted(); if (exec.agent !== agent) throw new FsError('工具会话身份不匹配。', 'FS_SANDBOX_DENIED'); return this.propose(agent, args.relativePath, args.baseVersion, args.text, args.summary, exec.signal) },
    })))
  }
  dispose(): void { this.proposals.clear() }
}
