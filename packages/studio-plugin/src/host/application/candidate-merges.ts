import type { CheckEvidence, EntityView, MaterialIntegrationRequest } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../shared/studio.ts'
import type { GitIdentity } from '../adapters/workspace/git.ts'
import type { HostPorts, SessionOutput } from './ports.ts'
import type { PendingOperation, StudioStore } from './state.ts'

export interface MergeNote { remoteFiles: string[]; aiFiles: string[] }
export interface MergedCandidate { task: TaskView; draft: MaterialDraft; prepare: MaterialIntegrationRequest; note: MergeNote }
export function mergeNoteText(note: MergeNote): string {
  if (!note.remoteFiles.length && !note.aiFiles.length) return '已基于远端最新版本重建候选'
  const automatic = note.remoteFiles.length ? `已自动合并远端变更：${note.remoteFiles.join('、')}` : ''
  const ai = note.aiFiles.length ? `${automatic ? '；' : ''}AI 解决冲突：${note.aiFiles.join('、')}` : ''
  return `${automatic}${ai}`
}
interface Dependencies {
  entity(entityId: string, projectId?: string): Promise<{ entity: EntityView }>
  identity(projectId: string): Promise<GitIdentity>
  checks(candidateSha: string, draft: MaterialDraft): CheckEvidence
  readDraft(task: TaskView, entity: EntityView): Promise<MaterialDraft>
}
const mergeRules = '你是合并助手。当前工作区处于 git merge 冲突状态。逐个读取冲突文件，保留双方有效业务内容，解决全部冲突标记后直接写入合并后的完整文件。不提交、不执行 git 命令、不改冲突清单之外的文件。完成后用中文简述每个文件如何合并。'

/** Rebuilds a fixed candidate on a moved remote head; the agent resolves conflicts in place. */
export class CandidateMerges {
  private readonly pending = new Map<string, (error?: Error) => void>()
  constructor(private readonly store: StudioStore, private readonly ports: Pick<HostPorts, 'git' | 'session' | 'prompt'>, private readonly deps: Dependencies) {}

  async merge(operation: PendingOperation, request: MaterialIntegrationRequest, remoteHead: string, branch: string): Promise<MergedCandidate | undefined> {
    const local = await this.store.read()
    const task = local.tasks.find(value => value.projectId === operation.projectId && value.entityId === operation.entityId && value.worktree === operation.task.worktree && value.sessionId === operation.task.sessionId && value.purpose === operation.task.purpose)
    if (!task || task.cleanup) return undefined
    const { entity } = await this.deps.entity(operation.entityId, operation.projectId)
    const state = await this.ports.git.state(task.worktree)
    if (state.head !== operation.candidateSha) throw new Error('候选提交已变化，请核对原候选后再集成')
    await this.ports.git.fetch(task.worktree, branch)
    const identity = await this.deps.identity(operation.projectId)
    const remoteFiles = await this.ports.git.changedFiles(task.worktree, operation.expectedHead, remoteHead)
    const mergeBranch = `studio-merge/${operation.candidateSha.slice(0, 12)}-${remoteHead.slice(0, 12)}`
    await this.ports.git.checkoutBranch(task.worktree, mergeBranch, remoteHead)
    const result = await this.ports.git.merge(task.worktree, operation.candidateSha, identity)
    const aiFiles = result.status === 'conflicted' ? result.files : []
    const mergeSha = result.status === 'merged' ? result.commit : await this.resolveWithAgent(task, operation, remoteHead, result.files, identity)
    const after = await this.ports.git.state(task.worktree)
    if (after.dirty || after.head !== mergeSha) throw new Error('合并后工作区仍有未提交改动，已保留现场请核对')
    const parents = (await this.ports.gitLocal(['rev-list', '--parents', '-n', '1', mergeSha], task.worktree)).trim().split(/\s+/)
    if (parents.length !== 3 || parents[0] !== mergeSha || parents[1] !== remoteHead) throw new Error('合并父顺序不符合远端头优先，已保留现场请核对')
    const scope = await this.ports.git.changedFiles(task.worktree, remoteHead, mergeSha)
    if (!scope.length || scope.some(file => !request.allowedPaths.includes(file))) throw new Error('合并结果超出本材料允许范围，已保留现场请核对')
    const draft = await this.deps.readDraft(task, entity)
    const confirmations = request.confirmations.map(value => ({ ...value, fixed: { ...value.fixed, commitSha: mergeSha, path: draft.path, sha256: draft.sha256 } }))
    const prepare: MaterialIntegrationRequest = { ...request, idempotencyKey: `m-${mergeSha}`, sourceSha: mergeSha, candidateSha: mergeSha,
      expectedHead: remoteHead, confirmations, checks: this.deps.checks(mergeSha, draft) }
    return { task, draft, prepare, note: { remoteFiles, aiFiles } }
  }

  /** Session-output entry: only merge sessions are claimed; everything else falls through. */
  async accept(sessionId: string, output: SessionOutput): Promise<boolean> {
    const settle = this.pending.get(sessionId)
    if (!settle) return false
    if (output.kind === 'turn-ended') { this.pending.delete(sessionId); settle(output.reason === 'stop' ? undefined : new Error('AI 合并未正常完成，现场已保留')) }
    return true
  }

  private async resolveWithAgent(task: TaskView, operation: PendingOperation, remoteHead: string, files: string[], identity: GitIdentity): Promise<string> {
    const sessionId = `studio-merge-${operation.id}-${remoteHead.slice(0, 12)}`
    const sessionTask: TaskView = { ...task, sessionId }
    const completion = new Promise<void>((resolve, reject) => this.pending.set(sessionId, error => error ? reject(error) : resolve()))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(sessionId)
        void (async () => {
          try { await this.ports.cancelSession?.(sessionId) }
          catch (error) { reject(new Error('AI 合并超时，现场已保留', { cause: error })); return }
          reject(new Error('AI 合并超时，现场已保留'))
        })()
      }, 600_000)
      timer.unref()
    })
    try {
      await this.ports.session(sessionTask, mergeRules)
      await this.ports.prompt(sessionId, `本次合并的冲突文件：${files.join('、')}。原候选提交 ${operation.candidateSha}，远端新头 ${remoteHead}。请直接在工作区写入每个冲突文件的合并结果。`)
      await Promise.race([completion, timeout])
      return await this.ports.git.completeMerge(task.worktree, files, identity)
    } finally { if (timer) clearTimeout(timer); this.pending.delete(sessionId) }
  }
}
