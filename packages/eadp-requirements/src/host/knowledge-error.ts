import type { FileErrorCode } from '@eadp/contracts/files'

/** 需求依据相关的可识别失败；`code` 由 Remote 层原样传递给界面。 */
export class RequirementKnowledgeError extends Error {
  constructor(message: string, readonly code: Extract<FileErrorCode, 'EVIDENCE_INVALID' | 'SNAPSHOT_FAILED' | 'INVALID_PATH' | 'NOT_FOUND' | 'UNAVAILABLE'>) {
    super(message)
    this.name = 'RequirementKnowledgeError'
  }
}
