import type { Context } from '@deepseek-ai/cordis'
import type {} from '@eadp/knowledge'
import { failureMessage } from '@eadp/contracts'
import type { KnowledgeEvidenceResolution, KnowledgeSourceMap } from '@eadp/contracts/knowledge'
import type { RequirementKnowledgeAdoption, RequirementKnowledgeCitation } from '@eadp/contracts/requirements'
import { citationFromSnapshot } from './adoption.ts'
import { renderBasisSection } from './citation-format.ts'
import { RequirementKnowledgeError } from './knowledge-error.ts'
import type { KnowledgeSnapshots } from './snapshot.ts'

/** 渲染「需求依据」章节所需的快照正文与来源映射。 */
export interface BasisSnapshot {
  body: string
  sourceMap: KnowledgeSourceMap | null
}

/** 已固定到项目的一组依据及渲染所需的全部快照内容。 */
export interface FixedBasis {
  citations: RequirementKnowledgeCitation[]
  snapshots: Map<string, BasisSnapshot>
}

/**
 * 证据核验 → 项目快照 → 提案引用 的共用链路。
 * 模型提案与界面采用都走同一条，避免出现第二套引用链路。
 */
export class KnowledgeBasis {
  constructor(private readonly ctx: Context, private readonly snapshots: KnowledgeSnapshots) {}

  /**
   * 按本会话实际取得的证据标识核验证据与真实范围。
   * @param sessionId - 取得证据的需求会话。
   * @param projectId - 证据所属项目。
   * @param adoptions - 采用项；范围必须包含在会话实际读取范围内。
   * @returns 与采用项同序的已核验证据。
   */
  async resolve(sessionId: string, projectId: string, adoptions: readonly RequirementKnowledgeAdoption[]): Promise<KnowledgeEvidenceResolution[]> {
    let resolutions: KnowledgeEvidenceResolution[]
    try {
      resolutions = await this.ctx.eadpKnowledgeReference.resolveEvidence({
        sessionId,
        projectId,
        items: adoptions.map(adoption => ({ evidenceId: adoption.evidenceId, ranges: adoption.ranges })),
      })
    } catch (error) {
      throw new RequirementKnowledgeError(failureMessage(error, '用于关联的知识内容已失效，请重新读取后再关联。'), 'EVIDENCE_INVALID')
    }
    if (resolutions.length !== adoptions.length) throw new RequirementKnowledgeError('用于关联的知识内容已失效，请重新读取后再关联。', 'EVIDENCE_INVALID')
    return resolutions
  }

  /**
   * 固定每份资料的当时内容并生成提案引用；同一身份复用已有快照。
   * @param projectId - 快照写入的项目。
   * @param adoptions - 采用项与采用说明，须与核验结果同序。
   * @param resolutions - Host 已核验的证据。
   */
  async fix(
    projectId: string,
    adoptions: readonly RequirementKnowledgeAdoption[],
    resolutions: readonly KnowledgeEvidenceResolution[],
  ): Promise<FixedBasis> {
    const citations: RequirementKnowledgeCitation[] = []
    const snapshots = new Map<string, BasisSnapshot>()
    for (const [index, adoption] of adoptions.entries()) {
      const resolution = resolutions[index]
      if (resolution === undefined) throw new RequirementKnowledgeError('用于关联的知识内容已失效，请重新读取后再关联。', 'EVIDENCE_INVALID')
      const fixed = await this.snapshots.ensure(projectId, resolution)
      citations.push(citationFromSnapshot(fixed.manifest, adoption.note))
      snapshots.set(fixed.snapshotId, { body: resolution.text, sourceMap: resolution.sourceMap })
    }
    return { citations, snapshots }
  }

  /** 把依据渲染进候选正文；正文已有依据章节时只补缺失条目。 */
  render(text: string, fixed: FixedBasis): string {
    return renderBasisSection(text, fixed.citations, fixed.snapshots)
  }

  /**
   * 回读一组已固定依据的正文与来源映射；合并后重新渲染正文时必须取得全部依据内容。
   * @param projectId - 依据所属项目。
   * @param citations - 合并后的全部依据。
   */
  async readSnapshots(projectId: string, citations: readonly RequirementKnowledgeCitation[]): Promise<Map<string, BasisSnapshot>> {
    const snapshots = new Map<string, BasisSnapshot>()
    for (const citation of citations) {
      if (snapshots.has(citation.snapshotId)) continue
      try {
        const stored = await this.snapshots.read(projectId, citation.snapshotId)
        snapshots.set(citation.snapshotId, { body: stored.body, sourceMap: stored.sourceMap })
      } catch {
        throw new RequirementKnowledgeError(`提案关联的《${citation.title}》当时内容不完整，请重新生成提案。`, 'SNAPSHOT_FAILED')
      }
    }
    return snapshots
  }
}
