import type { FileErrorCode } from './files.js'
/** Paths are relative to the current Workspace's 原型 directory. */
export interface PrototypeEntry { relativePath: string; name: string; type: 'file' | 'directory'; size?: number }
export interface PrototypeFileList { entries: PrototypeEntry[]; hiddenCount: number; exists: boolean }
export type PrototypeContent =
  | { relativePath: string; kind: 'text'; text: string; size: number; truncated: boolean }
  | { relativePath: string; kind: 'binary' | 'too-large'; size: number; truncated: false }
/** Runtime state is observed from owned handles, never restored as running from disk. */
export interface PrototypeRunState {
  projectId: string
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
  installStatus: 'unknown' | 'installing' | 'ready' | 'failed'
  url?: string
  port?: number
  pid?: number
  startedAt?: string
  error?: string
  installationError?: string
}
export interface PrototypeRunLog { items: Array<{ stream: 'stdout' | 'stderr' | 'host'; text: string }>; truncated: boolean }
export type PrototypeErrorCode = FileErrorCode | 'RUN_NOT_READY' | 'RUN_FAILED' | 'DEPENDENCIES_MISSING' | 'PORT_UNAVAILABLE' | 'PROJECT_NOT_EMPTY' | 'STOP_FAILED' | 'RESOURCE_INVALID'
/** Coordinates a user-requested removal without exposing process implementation to the Shell. */
export interface EadpPrototypeClient {
  stopProject(projectId: string): Promise<void>
  listRuns(): Promise<PrototypeRunState[]>
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'eadp/prototype': { code: PrototypeErrorCode } }
}
