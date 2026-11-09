import type {} from '@deepseek-ai/dsh-typert-protocol'
/** Opaque version returned by the native filesystem service. */
export type FileVersion = string
export type FileErrorCode = 'NOT_FOUND' | 'EXISTS' | 'INVALID_PATH' | 'OUTSIDE_PROJECT' | 'PERMISSION_DENIED' | 'IO_ERROR' | 'TOO_LARGE' | 'NOT_TEXT' | 'STALE_VERSION' | 'PROJECT_NOT_FOUND' | 'EVIDENCE_INVALID' | 'SNAPSHOT_FAILED'
export interface RequirementEntry { relativePath: string; name: string; type: 'file' | 'directory'; size?: number }
export interface RequirementDocument { relativePath: string; text: string; version: FileVersion }
export type ContextDocument = { kind: 'absent' } | ({ kind: 'present' } & RequirementDocument)
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'eadp/file': { code: FileErrorCode } }
}
