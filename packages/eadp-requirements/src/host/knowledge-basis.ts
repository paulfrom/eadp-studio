import type { Context } from '@deepseek-ai/cordis'
import type {} from '@eadp/knowledge'
import type { FixedKnowledgeCitation } from '@eadp/contracts/knowledge'
import type { RequirementKnowledgeBasis as RequirementKnowledgeBasisData } from '@eadp/contracts/requirements'
import type { RequirementFiles } from './files.ts'
import { hasBasisHeading } from './citation-format.ts'
import type { ProposalStore } from './proposal-store.ts'
import type { KnowledgeSnapshots } from './snapshot.ts'

/**
 * 需求正文的「需求依据」回读：只认已应用到该文件、且正文仍保留依据条目的提案，
 * 从项目快照读取当时内容；资料更新或删除只改变提示，不改变固定内容。
 */
export class RequirementKnowledgeBasis {
  constructor(
    private readonly ctx: Context,
    private readonly files: RequirementFiles,
    private readonly proposals: ProposalStore,
    private readonly snapshots: KnowledgeSnapshots,
  ) {}

  async read(projectId: string, relativePath: string): Promise<RequirementKnowledgeBasisData> {
    const context = relativePath === 'CONTEXT.md'
    let text: string
    try {
      text = (await this.files.read(projectId, relativePath, context)).text
    } catch {
      return { citations: [], problems: ['需求文件暂时无法读取，无法显示需求依据。'] }
    }
    if (!hasBasisHeading(text)) return { citations: [] }
    const target = context ? 'context' : 'requirement'
    const records = (await this.proposals.list(projectId))
      .filter(record => record.status === 'applied' && record.target === target && record.proposal.relativePath === relativePath)
    if (records.length === 0) return { citations: [] }
    const problems: string[] = []
    const notesBySnapshot = new Map<string, string[]>()
    for (const record of records) {
      for (const citation of record.proposal.citations) {
        if (!text.includes(`《${citation.title}》`)) continue
        const notes = notesBySnapshot.get(citation.snapshotId)
        if (notes === undefined) notesBySnapshot.set(citation.snapshotId, [citation.note])
        else if (!notes.includes(citation.note)) notes.push(citation.note)
      }
    }
    const citations: FixedKnowledgeCitation[] = []
    for (const [snapshotId, notes] of notesBySnapshot) {
      let citation: FixedKnowledgeCitation
      try {
        citation = await this.fixed(projectId, snapshotId)
      } catch {
        addProblem(problems, '部分需求依据的当时内容暂时无法读取，可稍后重试。')
        continue
      }
      citation.note = notes.join('；')
      const state = await this.state(citation, problems)
      citation.state = state.state
      citation.latestContentRevisionId = state.latest
      citations.push(citation)
    }
    return problems.length > 0 ? { citations, problems } : { citations }
  }

  /** 读取一份项目快照并转成界面需要的固定依据。 */
  private async fixed(projectId: string, snapshotId: string): Promise<FixedKnowledgeCitation> {
    const stored = await this.snapshots.read(projectId, snapshotId)
    const manifest = stored.manifest
    return {
      snapshotId,
      packId: manifest.packId,
      documentId: manifest.documentId,
      contentRevisionId: manifest.contentRevisionId,
      title: manifest.title,
      category: manifest.category,
      scope: manifest.scope,
      source: manifest.source,
      locations: manifest.locations,
      warnings: manifest.warnings,
      ranges: manifest.ranges,
      note: '',
      state: 'current',
      latestContentRevisionId: null,
      body: stored.body,
      resources: stored.resources.map(resource => ({ path: resource.path, fileName: resource.fileName, dataBase64: resource.dataBase64 })),
      sourceMap: stored.sourceMap,
      original: stored.original === null ? null : {
        fileName: stored.original.fileName,
        fileType: stored.original.fileType,
        size: stored.original.size,
        dataBase64: stored.original.dataBase64,
      },
    }
  }

  /** 与知识服务核对资料是否有新版本；核对失败只提示，不改变固定内容。 */
  private async state(citation: FixedKnowledgeCitation, problems: string[]): Promise<{ state: FixedKnowledgeCitation['state']; latest: string | null }> {
    try {
      const latest = await this.ctx.eadpKnowledgeReference.currentContentRevision(citation.packId, citation.documentId)
      if (latest === null) return { state: 'removed', latest: null }
      return { state: latest === citation.contentRevisionId ? 'current' : 'updated', latest }
    } catch {
      addProblem(problems, '暂时无法确认部分资料是否有新版本，可稍后重试。')
      return { state: 'current', latest: null }
    }
  }
}

function addProblem(problems: string[], message: string): void {
  if (!problems.includes(message)) problems.push(message)
}
