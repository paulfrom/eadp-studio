import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { diffWithCap, failureMessage } from '@eadp/contracts'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@eadp/knowledge'
import type { RequirementDocument } from '@eadp/contracts/files'
import type { KnowledgeBasisAcquisition, KnowledgeRange } from '@eadp/contracts/knowledge'
import type { RequirementKnowledgeAdoption, RequirementKnowledgeCitation, RequirementProposal } from '@eadp/contracts/requirements'
import { parseKnowledgeAdoptions } from './adoption.ts'
import type { FixedBasis, KnowledgeBasis } from './basis.ts'
import { appendBasisEntries } from './citation-format.ts'
import type { RequirementFiles } from './files.ts'
import { RequirementKnowledgeError } from './knowledge-error.ts'
import type { RequirementProposals } from './proposals.ts'

/** 需求会话标识上限；与需求 Remote 的会话校验一致。 */
const MAX_SESSION_ID = 200
/** 单个采用项的范围数上限；与模型提案的采用项一致。 */
const MAX_SOURCE_RANGES = 32

/** 已核验的界面采用输入。 */
interface AdoptionInput {
  relativePath: string
  baseVersion: string | null
  /** 原始采用说明；由采用项解析统一校验与去空白。 */
  note: unknown
  source: Record<string, unknown>
}

/**
 * 界面“作为需求依据”的流程：校验输入 → 核验证据并固定快照 →
 * 合并或新建待审提案。不写需求正文；应用提案仍由现有流程把正文与引用同次保存。
 */
export class RequirementAdoption {
  constructor(
    private readonly ctx: Context,
    private readonly files: RequirementFiles,
    private readonly proposals: RequirementProposals,
    private readonly basis: KnowledgeBasis,
  ) {}

  /**
   * 把界面选定的知识内容加入该文件当前待审提案；没有待审提案时新建。
   * @param projectId - 目标需求文件所属项目。
   * @param sessionId - 发起采用的需求会话；证据只在所属会话与项目内有效。
   * @param input - 目标文件、基线版本、采用说明与来源。
   * @returns 待审提案；不改变需求正文。
   */
  async adopt(projectId: string, sessionId: string, input: unknown): Promise<RequirementProposal> {
    this.checkSession(sessionId)
    const parsed = parseInput(input)
    return this.files.mutate(projectId, async () => {
      const current = await this.files.read(projectId, parsed.relativePath)
      if (current.version !== parsed.baseVersion) throw new FsError('需求文件已变化，请重新打开后再采用。', 'FS_STALE_VERSION')
      const adoption = await this.adoptionOf(projectId, sessionId, parsed)
      const resolutions = await this.basis.resolve(sessionId, projectId, [adoption])
      const fixed = await this.basis.fix(projectId, [adoption], resolutions)
      const pending = await this.proposals.pending(projectId, current.relativePath)
      if (pending === null) return this.create(projectId, sessionId, current, fixed)
      // 提案基于旧版本时不能把依据并进旧候选，否则应用会覆盖更新后的正文。
      if (pending.baseVersion !== current.version) throw new FsError('提案基于旧版本，请重新生成。', 'FS_STALE_VERSION')
      return this.merge(projectId, pending, fixed)
    })
  }

  private checkSession(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > MAX_SESSION_ID) throw new FsError('需求会话标识无效。', 'FS_NOT_TEXT')
  }

  /** 按来源分支取得可核验的采用项：本次参考用已签发标识，资料页先重读并签发证据。 */
  private async adoptionOf(projectId: string, sessionId: string, input: AdoptionInput): Promise<RequirementKnowledgeAdoption> {
    const kind = input.source['kind']
    if (kind === 'reference') return parseAdoption({ evidenceId: input.source['evidenceId'], ranges: input.source['ranges'], note: input.note })
    if (kind === 'document') return parseAdoption(await this.acquireDocument(projectId, sessionId, input))
    throw new RequirementKnowledgeError('知识采用来源无效。', 'EVIDENCE_INVALID')
  }

  /** 资料页分支：Host 重读 canonical 正文并签发证据，不信任界面自报正文或出处。 */
  private async acquireDocument(projectId: string, sessionId: string, input: AdoptionInput): Promise<{ evidenceId: string; ranges: KnowledgeRange[]; note: unknown }> {
    const packId = input.source['packId']
    const documentId = input.source['documentId']
    const contentRevisionId = input.source['contentRevisionId']
    if (packId !== 'builtin' && packId !== 'user') throw new RequirementKnowledgeError('知识资料范围无效。', 'EVIDENCE_INVALID')
    if (typeof documentId !== 'string' || documentId === '') throw new RequirementKnowledgeError('知识资料标识无效。', 'EVIDENCE_INVALID')
    if (typeof contentRevisionId !== 'string' || contentRevisionId === '') throw new RequirementKnowledgeError('知识资料版本无效，请重新选择。', 'EVIDENCE_INVALID')
    const ranges = parseRanges(input.source['ranges'])
    let acquisition: KnowledgeBasisAcquisition
    try {
      acquisition = await this.ctx.eadpKnowledgeReference.acquireBasis({ sessionId, projectId, packId, documentId, contentRevisionId, ranges })
    } catch (error) {
      throw new RequirementKnowledgeError(failureMessage(error, '选定的资料已更新，请重新选择。'), 'EVIDENCE_INVALID')
    }
    return { evidenceId: acquisition.evidenceId, ranges: acquisition.ranges, note: input.note }
  }

  /** 没有待审提案时，以当前正文为基线新建待审提案；只保存提案，不写需求正文。 */
  private async create(projectId: string, sessionId: string, current: RequirementDocument, fixed: FixedBasis): Promise<RequirementProposal> {
    const text = appendBasisEntries(current.text, fixed.citations, fixed.snapshots)
    if (text === current.text) throw new RequirementKnowledgeError('该内容已在需求依据中。', 'EVIDENCE_INVALID')
    const { diff, truncated } = diffWithCap(current.text, text)
    return this.proposals.savePending(projectId, {
      proposalId: randomUUID(),
      projectId,
      relativePath: current.relativePath,
      target: 'requirement',
      baseVersion: current.version,
      text,
      baseText: current.text,
      summary: `采用${fixed.citations.map(citation => `《${citation.title}》`).join('、')}作为需求依据。`,
      diff,
      diffTruncated: truncated,
      citations: fixed.citations,
      persisted: false,
      createdAt: new Date().toISOString(),
      sessionId,
    })
  }

  /**
   * 已有待审提案时合并新依据：只把新依据并入正文依据章节，正文已有条目（含此前已应用的
   * 依据）保持原样；正文改动保留。提案自身只记录本次合并进来的依据。
   */
  private async merge(projectId: string, pending: RequirementProposal, fixed: FixedBasis): Promise<RequirementProposal> {
    const citations = mergeCitations(pending.citations, fixed.citations)
    const text = appendBasisEntries(pending.text, fixed.citations, fixed.snapshots)
    if (citations.length === pending.citations.length && text === pending.text) return pending
    const { diff, truncated } = diffWithCap(pending.baseText, text)
    return this.proposals.savePending(projectId, { ...pending, citations, text, diff, diffTruncated: truncated })
  }
}

/** 校验界面传入的采用输入；需求路径、说明与范围在读取文件和采用项解析时再核对。 */
function parseInput(value: unknown): AdoptionInput {
  if (typeof value !== 'object' || value === null) throw new FsError('采用参数无效。', 'FS_NOT_TEXT')
  const record = value as Record<string, unknown>
  const relativePath = record['relativePath']
  if (typeof relativePath !== 'string' || relativePath === '') throw new RequirementKnowledgeError('只能把知识作为需求目录中 Markdown 文件的依据。', 'INVALID_PATH')
  const baseVersion = record['baseVersion']
  if (baseVersion !== null && (typeof baseVersion !== 'string' || baseVersion === '')) throw new FsError('缺少需求版本，请重新打开需求后再采用。', 'FS_NOT_OBSERVED')
  const source = record['source']
  if (typeof source !== 'object' || source === null) throw new RequirementKnowledgeError('知识采用来源无效。', 'EVIDENCE_INVALID')
  return { relativePath, baseVersion, note: record['note'], source: source as Record<string, unknown> }
}

/** 解析单个采用项；复用模型提案的采用项校验，界面输入不另立规则。 */
function parseAdoption(value: unknown): RequirementKnowledgeAdoption {
  const adoption = parseKnowledgeAdoptions([value])[0]
  if (adoption === undefined) throw new RequirementKnowledgeError('知识采用项无效。', 'EVIDENCE_INVALID')
  return adoption
}

/** 校验界面提交的范围：非空、整数、起点小于终点；是否落在正文内由知识服务再次核对。 */
function parseRanges(value: unknown): KnowledgeRange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCE_RANGES) throw new RequirementKnowledgeError('请选择要作为依据的内容范围。', 'EVIDENCE_INVALID')
  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null) throw new RequirementKnowledgeError('采用的资料范围无效。', 'EVIDENCE_INVALID')
    const record = entry as Record<string, unknown>
    const start = record['start']
    const end = record['end']
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) {
      throw new RequirementKnowledgeError('采用的资料范围无效。', 'EVIDENCE_INVALID')
    }
    return { start: start as number, end: end as number }
  })
}

/** 合并引用：同一快照与范围只保留一条，同一资料的新范围保留为另一条。 */
function mergeCitations(existing: readonly RequirementKnowledgeCitation[], added: readonly RequirementKnowledgeCitation[]): RequirementKnowledgeCitation[] {
  const merged = [...existing]
  for (const citation of added) {
    if (merged.some(value => value.snapshotId === citation.snapshotId && sameRanges(value.ranges, citation.ranges))) continue
    merged.push(citation)
  }
  return merged
}

function sameRanges(left: RequirementKnowledgeCitation['ranges'], right: RequirementKnowledgeCitation['ranges']): boolean {
  return left.length === right.length && left.every((range, index) => {
    const other = right[index]
    return other !== undefined && range.start === other.start && range.end === other.end && range.textHash === other.textHash
  })
}
