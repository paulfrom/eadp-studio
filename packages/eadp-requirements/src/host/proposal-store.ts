import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { FileVersion } from '@eadp/contracts/files'
import type { RequirementProposal } from '@eadp/contracts/requirements'
import type { RequirementFiles } from './files.ts'
import { RequirementKnowledgeError } from './knowledge-error.ts'
import { readJsonFile, stateDirectory, writeJsonAtomically } from './state-files.ts'

/** 提案在项目中的生命周期：待审阅、已应用到需求正文、已被丢弃。 */
export type PersistedProposalStatus = 'pending' | 'applied' | 'discarded'

/**
 * `<项目>/.eadp/proposals/<proposalId>.json` 的格式。
 * 提案连同已固定依据一起保存，重启后不依赖本次运行的内存状态。
 */
export interface PersistedProposal {
  schemaVersion: 1
  /** 提案全量元数据；`citations` 也在其中。 */
  proposal: RequirementProposal
  target: 'requirement' | 'context'
  baseVersion: FileVersion | null
  createdAt: string
  sessionId: string
  status: PersistedProposalStatus
  appliedAt?: string
  appliedVersion?: string
}

const PROPOSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_DIRECTORY = ['.eadp', 'proposals'] as const
const STATUSES: readonly PersistedProposalStatus[] = ['pending', 'applied', 'discarded']

/** 提案文件是界面跨重启回看与依据引用的持久记录；未知文件不删除，只写诊断。 */
export class ProposalStore {
  constructor(private readonly files: RequirementFiles, private readonly diagnostic: (message: string) => void) {}

  /** 覆盖写入一份提案记录；文件名来自提案自身身份。 */
  async save(projectId: string, record: PersistedProposal): Promise<void> {
    const directory = await stateDirectory(this.files, projectId, STATE_DIRECTORY, true)
    if (directory === null) throw new RequirementKnowledgeError('提案无法保存到项目。', 'SNAPSHOT_FAILED')
    await writeJsonAtomically(path.join(directory, `${record.proposal.proposalId}.json`), record)
  }

  /** 读取一份提案记录；不存在返回 null，损坏记录写诊断后也返回 null。 */
  async read(projectId: string, proposalId: string): Promise<PersistedProposal | null> {
    if (!PROPOSAL_ID.test(proposalId)) return null
    const directory = await stateDirectory(this.files, projectId, STATE_DIRECTORY, false)
    if (directory === null) return null
    let value: unknown
    try {
      value = await readJsonFile(path.join(directory, `${proposalId}.json`))
    } catch (error) {
      this.diagnostic(`提案文件读取失败：${proposalId} ${String(error)}`)
      return null
    }
    if (value === null) return null
    const record = parseRecord(value, projectId)
    if (record === null || record.proposal.proposalId !== proposalId) {
      this.diagnostic(`提案文件内容无效，未按提案处理：${proposalId}`)
      return null
    }
    return record
  }

  /** 列出项目内全部可识别提案记录；损坏或未知文件保留并写诊断。 */
  async list(projectId: string): Promise<PersistedProposal[]> {
    const directory = await stateDirectory(this.files, projectId, STATE_DIRECTORY, false)
    if (directory === null) return []
    const entries = await readdir(directory, { withFileTypes: true })
    const records: PersistedProposal[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        this.diagnostic(`提案目录中的未识别项未处理：${entry.name}`)
        continue
      }
      const proposalId = entry.name.slice(0, -'.json'.length)
      const record = await this.read(projectId, proposalId)
      if (record !== null) records.push(record)
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  /** 更新已保存提案的状态；文件不存在按不可恢复失败处理。 */
  async update(projectId: string, proposalId: string, change: (record: PersistedProposal) => void): Promise<PersistedProposal> {
    const record = await this.read(projectId, proposalId)
    if (record === null) throw new RequirementKnowledgeError('提案记录已不存在，无法更新。', 'NOT_FOUND')
    change(record)
    await this.save(projectId, record)
    return record
  }
}

/** 校验持久记录的最小结构；任何缺失都按损坏记录处理。 */
function parseRecord(value: unknown, projectId: string): PersistedProposal | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record['schemaVersion'] !== 1) return null
  if (typeof record['target'] !== 'string' || (record['target'] !== 'requirement' && record['target'] !== 'context')) return null
  if (typeof record['createdAt'] !== 'string' || typeof record['sessionId'] !== 'string') return null
  if (typeof record['status'] !== 'string' || !STATUSES.includes(record['status'] as PersistedProposalStatus)) return null
  if (record['baseVersion'] !== null && typeof record['baseVersion'] !== 'string') return null
  if (record['appliedAt'] !== undefined && typeof record['appliedAt'] !== 'string') return null
  if (record['appliedVersion'] !== undefined && typeof record['appliedVersion'] !== 'string') return null
  const proposal = record['proposal']
  if (typeof proposal !== 'object' || proposal === null) return null
  const candidate = proposal as Record<string, unknown>
  if (typeof candidate['proposalId'] !== 'string' || typeof candidate['relativePath'] !== 'string') return null
  if (candidate['projectId'] !== projectId) return null
  if (typeof candidate['text'] !== 'string' || typeof candidate['baseText'] !== 'string') return null
  if (candidate['baseVersion'] !== null && typeof candidate['baseVersion'] !== 'string') return null
  if (typeof candidate['summary'] !== 'string' || typeof candidate['createdAt'] !== 'string' || typeof candidate['sessionId'] !== 'string') return null
  if (!Array.isArray(candidate['citations']) || !Array.isArray(candidate['diff'])) return null
  if (!candidate['citations'].every(isCitation)) return null
  return record as unknown as PersistedProposal
}

/** 依据条目只做回读所需的最小校验；缺少固定内容标识的记录按损坏处理。 */
function isCitation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const citation = value as Record<string, unknown>
  return typeof citation['snapshotId'] === 'string'
    && typeof citation['packId'] === 'string'
    && typeof citation['documentId'] === 'string'
    && typeof citation['contentRevisionId'] === 'string'
    && typeof citation['title'] === 'string'
    && typeof citation['sourceLabel'] === 'string'
    && typeof citation['note'] === 'string'
    && Array.isArray(citation['locations'])
    && Array.isArray(citation['warnings'])
    && Array.isArray(citation['ranges'])
}
