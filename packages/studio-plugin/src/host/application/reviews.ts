import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CheckEvidence, ConfirmationInput } from '@eadp/contracts'
import type { ConfirmationChoice, ReviewView, TaskView } from '../../shared/studio.ts'
import { digest } from '../adapters/assets/materials.ts'
import type { HostPorts } from './ports.ts'
import type { StudioStore } from './state.ts'

export interface ReviewCandidate {
  projectId: string; entityId: string; purpose: ReviewView['purpose']; candidateSha: string; inputHash: string;
  paths: string[]; checks: CheckEvidence; task: TaskView;
}
export interface LocalReview extends ReviewView {
  projectId: string; task: TaskView; paths: string[]; checks: CheckEvidence; sent: boolean;
  report?: string; reportHash?: string;
}
const rules = '你正在对工作台固定的 Git 候选与输入进行 AI 辅助评审。只能读取此固定快照；不得编辑文件、运行命令、改变 Git、认领或确认资产。作者自行处理意见并确认。指出实际问题，不编造依据。'
const same = (review: LocalReview, candidate: ReviewCandidate) => review.projectId === candidate.projectId && review.entityId === candidate.entityId && review.purpose === candidate.purpose && review.candidateSha === candidate.candidateSha && review.inputHash === candidate.inputHash

/** Review reports stay local; only author disposition and fixed hashes cross the integration boundary. */
export class AuthorReviews {
  constructor(private readonly store: StudioStore, private readonly ports: HostPorts) {}
  async request(candidate: ReviewCandidate): Promise<void> {
    const local = await this.store.read()
    let review = [...local.reviews].reverse().find(value => same(value, candidate) && (value.status !== 'failed' || !value.sent))
    if (!review) {
      const id = randomUUID()
      const task: TaskView = { projectId: candidate.projectId, entityId: candidate.entityId, sessionId: 'studio-review-' + id, purpose: 'review', reviewId: id, inputHash: candidate.inputHash, worktree: path.join(this.store.directory, 'reviews', id) }
      review = { id, projectId: candidate.projectId, entityId: candidate.entityId, purpose: candidate.purpose, candidateSha: candidate.candidateSha, inputHash: candidate.inputHash, status: 'pending', task, paths: [...candidate.paths], checks: candidate.checks, sent: false }
      local.reviews.push(review); local.tasks.push(task); await this.store.save()
    }
    if (review.status === 'reported') return
    try {
      let existing: Awaited<ReturnType<HostPorts['git']['state']>> | undefined
      try { existing = await this.ports.git.state(review.task.worktree) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (!existing) {
        await this.ports.git.createWorktree(candidate.task.worktree, review.task.worktree, 'studio-review/' + review.id, review.candidateSha)
        existing = await this.ports.git.state(review.task.worktree)
      }
      if (existing.head !== review.candidateSha || existing.dirty) throw new Error('评审固定快照已变化，请保留现场并重新评审')
      await this.ports.session(review.task, rules)
      if (!review.sent) {
        await this.ports.prompt(review.task.sessionId, '固定候选 ' + review.candidateSha + '，固定输入哈希 ' + review.inputHash + '。检查范围 ' + JSON.stringify(review.paths) + '，工程检查证据哈希 ' + digest(JSON.stringify(review.checks)) + '。仅评审该快照与其中的固定业务依据，输出唯一代码块 eadp-review，JSON格式 {"summary":"整体评审说明","findings":[{"severity":"info|warning|blocking","message":"具体问题或建议"}]}。不能自行确认或修改成果。')
        review.sent = true; review.task.reviewSent = true
      }
      review.status = 'pending'; delete review.error; await this.store.save()
    } catch (error) { review.status = 'failed'; review.error = error instanceof Error ? error.message : '评审请求未完成'; await this.store.save(); throw error }
  }
  async accept(sessionId: string, content: string): Promise<boolean> {
    const local = await this.store.read(), review = local.reviews.find(value => value.task.sessionId === sessionId)
    if (!review) return false
    if (review.status === 'reported') return true
    const matches = [...content.matchAll(new RegExp(String.fromCharCode(96).repeat(3) + 'eadp-review\\s*\\n([\\s\\S]*?)\\n' + String.fromCharCode(96).repeat(3), 'g'))]
    if (!matches.length) return true
    try {
      const snapshot = await this.ports.git.state(review.task.worktree)
      if (snapshot.head !== review.candidateSha || snapshot.dirty) throw new Error('评审固定快照已变化，不能接受报告')
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
      review.summary = result.summary; review.findings = findings; review.report = content; review.reportHash = digest(content); review.status = 'reported'; review.sent = true; review.task.reviewSent = true; delete review.error
      await this.store.save(); return true
    } catch (error) { review.status = 'failed'; review.sent = true; review.task.reviewSent = true; review.error = error instanceof Error ? error.message : '评审报告无法解析'; await this.store.save(); throw error }
  }
  async confirmation(choice: ConfirmationChoice, candidate: ReviewCandidate): Promise<{ confirmationMethod: 'direct' } | { confirmationMethod: 'ai-assisted'; reviewEvidence: Extract<ConfirmationInput, { confirmationMethod: 'ai-assisted' }>['reviewEvidence'] }> {
    if (choice.method === 'direct') return { confirmationMethod: 'direct' }
    if (choice.method !== 'ai-assisted' || !choice.authorDisposition?.trim() || choice.authorDisposition.length > 20_000) throw new Error('请由作者填写评审意见处理说明后确认')
    const review = (await this.store.read()).reviews.find(value => value.id === choice.reviewId)
    if (!review || !same(review, candidate) || review.status !== 'reported' || !review.report || !review.reportHash || digest(review.report) !== review.reportHash) throw new Error('评审未完成或固定候选与输入已变化，请重新评审')
    return { confirmationMethod: 'ai-assisted', reviewEvidence: { candidateSha: review.candidateSha, inputHash: review.inputHash, reportHash: review.reportHash, dispositionHash: digest(choice.authorDisposition.trim()) } }
  }
  async views(projectId?: string): Promise<ReviewView[]> {
    return (await this.store.read()).reviews.filter(review => review.projectId === projectId).map(({ id, entityId, purpose, candidateSha, inputHash, status, summary, findings, error }) => ({ id, entityId, purpose, candidateSha, inputHash, status, ...(summary ? { summary } : {}), ...(findings ? { findings } : {}), ...(error ? { error } : {}) }))
  }
}
