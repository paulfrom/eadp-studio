import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ConfirmationInput } from '@eadp/contracts'
import type { ConfirmationChoice, ReviewView, TaskView } from '../../shared/studio.ts'
import { containedFile, digest } from '../adapters/assets/materials.ts'
import { snapshotWorktreeFiles } from '../adapters/workspace/snapshot.ts'
import type { HostPorts, SessionOutput } from './ports.ts'
import type { StudioStore } from './state.ts'

/** One reviewed path's exact bytes; `null` records a path deleted by the snapshot. */
export interface ReviewFile { path: string; sha256: string | null }
/** The local, uncommitted version a review is bound to. */
export interface ReviewSnapshot {
  projectId: string; entityId: string; purpose: ReviewView['purpose'];
  head: string; inputHash: string; files: ReviewFile[]; paths: string[]; task: TaskView;
}
export interface ReviewCandidate extends ReviewSnapshot { candidateSha: string }
export interface LocalReview extends ReviewView {
  projectId: string; head: string; files: ReviewFile[]; paths: string[];
  task: TaskView; sent: boolean; ended?: boolean; report?: string; reportHash?: string;
}
const rules = '你正在对工作台固定的本地版本快照进行 AI 辅助评审。该快照尚未提交，只能读取；不得编辑文件、运行命令、改变 Git、认领或确认资产。作者自行处理意见并确认。指出实际问题，不编造依据。'
const binding = (value: Pick<ReviewSnapshot, 'projectId' | 'entityId' | 'purpose' | 'head' | 'inputHash' | 'files'>) => JSON.stringify([value.projectId, value.entityId, value.purpose, value.head, value.inputHash, value.files])
const same = (review: LocalReview, snapshot: ReviewSnapshot) => binding(review) === binding(snapshot)
const fileHash = (bytes: Buffer | undefined) => bytes ? digest(bytes) : null

/** Review reports stay local; only author disposition and fixed hashes cross the integration boundary. */
export class AuthorReviews {
  constructor(private readonly store: StudioStore, private readonly ports: HostPorts) {}
  async request(snapshot: ReviewSnapshot): Promise<void> {
    const local = await this.store.read()
    let review = [...local.reviews].reverse().find(value => same(value, snapshot) && (value.status !== 'failed' || !value.sent))
    if (!review) {
      const id = randomUUID()
      const task: TaskView = { projectId: snapshot.projectId, entityId: snapshot.entityId, sessionId: 'studio-review-' + id, purpose: 'review', reviewId: id, inputHash: snapshot.inputHash, worktree: path.join(await this.store.projectDirectory(snapshot.projectId), 'reviews', id) }
      review = { id, projectId: snapshot.projectId, entityId: snapshot.entityId, purpose: snapshot.purpose, head: snapshot.head, inputHash: snapshot.inputHash, files: [...snapshot.files], paths: [...snapshot.paths], status: 'pending', task, sent: false }
      local.reviews.push(review); local.tasks.push(task); await this.store.save()
    }
    if (review.status === 'reported') return
    try {
      let existing: Awaited<ReturnType<HostPorts['git']['state']>> | undefined
      try { existing = await this.ports.git.state(review.task.worktree) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (!existing) {
        // The worktree starts at the reviewed HEAD; the uncommitted bytes are copied in.
        await this.ports.git.createWorktree(snapshot.task.worktree, review.task.worktree, 'studio-review/' + review.id, review.head)
        await snapshotWorktreeFiles(snapshot.task.worktree, review.task.worktree, review.files.map(file => file.path))
      }
      if (!await this.intact(review)) throw new Error('评审固定快照已变化，请保留现场并重新评审')
      await this.ports.session(review.task, rules)
      if (!review.sent) {
        await this.ports.prompt(review.task.sessionId, '固定本地快照 ' + review.head + '（未提交），固定输入哈希 ' + review.inputHash + '，快照文件哈希 ' + digest(JSON.stringify(review.files)) + '。检查范围 ' + JSON.stringify(review.paths) + '。仅评审该快照与其中的固定业务依据。先用可读中文说明评审结论和主要问题，再在回答最后输出唯一代码块 eadp-review，JSON格式 {"summary":"整体评审说明","findings":[{"severity":"info|warning|blocking","message":"具体问题或建议"}]}。不能自行确认或修改成果。')
        review.sent = true; review.task.reviewSent = true
      }
      review.status = 'pending'; delete review.error; await this.store.save()
    } catch (error) { review.status = 'failed'; review.error = error instanceof Error ? error.message : '评审请求未完成'; await this.store.save(); throw error }
  }
  async accept(sessionId: string, output: SessionOutput): Promise<boolean> {
    const local = await this.store.read(), review = local.reviews.find(value => value.task.sessionId === sessionId)
    if (!review) return false
    if (output.kind === 'turn-ended') {
      review.ended = true; review.sent = true; review.task.reviewSent = true
      if (output.reason === 'completed' && review.status !== 'failed' && review.report && review.reportHash && digest(review.report) === review.reportHash) { review.status = 'reported'; delete review.error }
      else {
        review.status = 'failed'
        review.error = output.reason === 'completed' ? '评审已结束但没有有效报告，请重新发起评审' : output.reason === 'aborted' ? '评审已取消，请重新发起评审' : '评审会话未完成，请重新发起评审'
      }
      await this.store.save(); return true
    }
    if (output.kind !== 'assistant' || review.ended) return true
    const content = output.content
    const matches = [...content.matchAll(new RegExp(String.fromCharCode(96).repeat(3) + 'eadp-review\\s*\\n([\\s\\S]*?)\\n' + String.fromCharCode(96).repeat(3), 'g'))]
    if (!matches.length) return true
    try {
      if (!await this.intact(review)) throw new Error('评审固定快照已变化，不能接受报告')
      if (matches.length !== 1 || content.length > 100_000) throw new Error('评审报告必须包含唯一且大小受限的 eadp-review JSON')
      const value: unknown = JSON.parse(matches[0]![1]!)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('评审报告格式无效')
      const result = value as Record<string, unknown>
      if (Object.keys(result).some(key => key !== 'summary' && key !== 'findings') || typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 20_000 || !Array.isArray(result.findings) || result.findings.length > 100) throw new Error('评审报告格式无效')
      const findings: NonNullable<ReviewView['findings']> = []
      for (const entry of result.findings) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('评审意见格式无效')
        const item = entry as Record<string, unknown>
        if (Object.keys(item).some(key => key !== 'severity' && key !== 'message') || !['info', 'warning', 'blocking'].includes(String(item.severity)) || typeof item.message !== 'string' || !item.message.trim() || item.message.length > 4000) throw new Error('评审意见格式无效')
        findings.push({ severity: item.severity as 'info' | 'warning' | 'blocking', message: item.message })
      }
      review.summary = result.summary; review.findings = findings; review.report = content; review.reportHash = digest(content); review.status = 'pending'; review.sent = true; review.task.reviewSent = true; delete review.error
      await this.store.save(); return true
    } catch (error) { review.status = 'failed'; review.sent = true; review.task.reviewSent = true; review.error = error instanceof Error ? error.message : '评审报告无法解析'; await this.store.save(); throw error }
  }
  async confirmation(choice: ConfirmationChoice, candidate: ReviewCandidate): Promise<{ confirmationMethod: 'direct' } | { confirmationMethod: 'ai-assisted'; reviewEvidence: Extract<ConfirmationInput, { confirmationMethod: 'ai-assisted' }>['reviewEvidence'] }> {
    if (choice.method === 'direct') return { confirmationMethod: 'direct' }
    if (choice.method !== 'ai-assisted' || !choice.authorDisposition?.trim() || choice.authorDisposition.length > 20_000) throw new Error('请由作者填写评审意见处理说明后确认')
    const review = (await this.store.read()).reviews.find(value => value.id === choice.reviewId)
    if (!review || !same(review, candidate) || review.status !== 'reported' || !review.report || !review.reportHash || digest(review.report) !== review.reportHash) throw new Error('评审未完成或固定候选与输入已变化，请重新评审')
    return { confirmationMethod: 'ai-assisted', reviewEvidence: { candidateSha: candidate.candidateSha, inputHash: review.inputHash, reportHash: review.reportHash, dispositionHash: digest(choice.authorDisposition.trim()) } }
  }
  async views(projectId?: string): Promise<ReviewView[]> {
    return (await this.store.read()).reviews.filter(review => review.projectId === projectId).map(({ id, entityId, purpose, inputHash, status, summary, findings, error }) => ({ id, entityId, purpose, inputHash, status, ...(summary ? { summary } : {}), ...(findings ? { findings } : {}), ...(error ? { error } : {}) }))
  }
  /** The review worktree still holds the exact bytes and HEAD the report describes. */
  private async intact(review: LocalReview): Promise<boolean> {
    const state = await this.ports.git.state(review.task.worktree)
    if (state.head !== review.head) return false
    for (const file of review.files) {
      const bytes = await readFile(await containedFile(review.task.worktree, file.path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (fileHash(bytes) !== file.sha256) return false
    }
    return true
  }
}
