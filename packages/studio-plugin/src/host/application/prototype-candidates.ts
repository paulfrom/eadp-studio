import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { canonical } from '@eadp/asset-domain'
import type { ProjectState, PrototypeEngineeringEvidence, PrototypeIntegrationRequest, PrototypeSourceBaseResult, PrototypeTaskView, UpdatePrototypeSourceBaseRequest } from '@eadp/contracts'
import type { PrototypeCandidateFile, PrototypeCandidateSummary } from '../../shared/prototype.ts'
import type { TaskView } from '../../shared/studio.ts'
import { digest } from '../adapters/assets/materials.ts'
import { ProjectRecord } from '../adapters/project-record.ts'
import { CollaborationError, type CollaborationClient } from '../adapters/collaboration/client.ts'
import type { PrototypeConflictWriteback } from '../adapters/workspace/git.ts'
import type { HostPorts } from './ports.ts'
import { writePrototypeSnapshot } from '../prototype/snapshot.ts'
import type { PrototypeCollaboration } from './prototype-collaboration.ts'
import type { PrototypeIntegrations } from './prototype-integrations.ts'
import type { StudioStore } from './state.ts'

interface ConflictRecovery {
  request: UpdatePrototypeSourceBaseRequest; directory: string; mergeBaseSha: string; conflictFiles: string[]
  phase: 'source-base' | 'writeback' | 'restored'; writeback?: PrototypeConflictWriteback; result?: PrototypeSourceBaseResult
}
interface CandidateRecord {
  id: string; accountId: number; task: TaskView; authorization: PrototypeTaskView
  status: 'fixing' | 'ready' | 'confirmed' | 'no-change' | 'conflict'; summary?: PrototypeCandidateSummary; evidence?: PrototypeEngineeringEvidence; checkOperationId?: string; confirmationId?: string
  sourceUpload?: { ref: string; sha: string; status: 'uploading' | 'uploaded' }
  merged?: { expectedHead: string; candidateSha: string; mergeBaseSha: string; evidence?: PrototypeEngineeringEvidence; checkOperationId?: string }
  mergeScenes?: Array<{ expectedHead: string; mergeBaseSha: string; directory: string; status: 'merged' | 'conflicted' }>
  mergeCheckDirectories?: string[]
  recovery?: ConflictRecovery
}
interface CandidateState { operations: CandidateRecord[] }
function snapshotHash(files: Array<{ path: string; bytes: Buffer }>): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) hash.update(file.path).update('\0').update(file.bytes).update('\0')
  return hash.digest('hex')
}

/** Retains the exact source and task authority shown to its author. */
export class PrototypeCandidates {
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts, private readonly collaboration: PrototypeCollaboration, private readonly integrations: PrototypeIntegrations) {}
  private storage(): ProjectRecord<CandidateState> {
    if (!this.store.accountId) throw new Error('请先登录后固定原型成果')
    return new ProjectRecord<CandidateState>(this.store, 'prototype-candidates.json', () => ({ operations: [] }), (value, id) => ({ operations: value.operations.filter(x => x.task.projectId === id) }), values => ({ operations: values.flatMap(x => x.operations) }))
  }
  private async account(accountId: number): Promise<void> {
    if (this.store.accountId !== accountId || (await this.ports.account())?.id !== accountId || this.store.accountId !== accountId) throw new Error('账号已变化，原型候选已保留')
  }
  private binding(value: { task: TaskView; authorization: PrototypeTaskView }): string {
    const task = value.task, remote = value.authorization
    return canonical({ projectId: task.projectId, taskId: task.entityId, sessionId: task.sessionId, worktree: path.resolve(task.worktree),
      sourceBaseHead: remote.sourceBaseHead, generation: remote.generation, revision: remote.revision, clientId: remote.clientId,
      claimsDigest: remote.claimsDigest, claims: [...remote.developmentClaims].sort((a, b) => a.requirementId.localeCompare(b.requirementId)),
      requirements: [...remote.developmentRequirementIds].sort(), writeScope: [...remote.writeScope].sort(), policyHash: remote.policyHash })
  }
  private async current(record: CandidateRecord) {
    await this.account(record.accountId)
    const current = await this.collaboration.confirmationTask(record.task.entityId)
    await this.account(record.accountId)
    if (this.binding(current) !== this.binding(record)) throw new Error('事项授权、现场或需求范围已变化，请重新固定成果')
    return current
  }
  private async state(): Promise<{ accountId: number; storage: ProjectRecord<CandidateState>; data: CandidateState }> {
    const accountId = this.store.accountId, storage = this.storage()
    if (!accountId) throw new Error('请先登录')
    await this.account(accountId)
    const data = await storage.read() ?? { operations: [] }
    if (!Array.isArray(data.operations)) throw new Error('原型候选记录不可读取，请保留现场')
    await this.account(accountId)
    return { accountId, storage, data }
  }
  private sourceBaseResult(record: CandidateRecord, recovery: ConflictRecovery, result: PrototypeSourceBaseResult): PrototypeSourceBaseResult {
    const request = recovery.request, source = result.source, original = record.authorization, updated = result.task
    if (source.operationId !== record.id || source.ref !== request.sourceRef || source.sha !== request.sourceSha || source.previousBaseHead !== record.summary?.sourceBaseHead || source.newBaseHead !== request.newBaseHead) throw new Error('source-base 响应与原冲突操作不一致')
    const identity = (task: PrototypeTaskView) => canonical({ ...task, developmentClaims: [...task.developmentClaims].sort((a, b) => a.requirementId.localeCompare(b.requirementId)), developmentRequirementIds: [...task.developmentRequirementIds].sort(), referenceRequirementIds: [...task.referenceRequirementIds].sort(), writeScope: [...task.writeScope].sort() })
    if (updated.sourceBaseHead !== request.newBaseHead || updated.revision !== original.revision + 1 || identity({ ...updated, sourceBaseHead: original.sourceBaseHead, revision: original.revision }) !== identity(original)) throw new Error('source-base 响应改变了原事项授权或现场')
    return structuredClone(result)
  }
  /** Recover the original conflict request before allowing any replacement operation. */
  private async recoverConflict(record: CandidateRecord, storage: ProjectRecord<CandidateState>, data: CandidateState): Promise<void> {
    const recovery = record.recovery
    if (!recovery || record.status !== 'conflict' || !record.summary || recovery.phase === 'restored') return
    const request = recovery.request
    if (!record.sourceUpload || request.sourceOperationId !== record.id || request.sourceSha !== record.summary.sourceSha || request.newBaseHead !== record.summary.conflict?.expectedHead || request.sourceRef !== record.sourceUpload.ref || record.sourceUpload.status !== 'uploaded') throw new Error('原冲突恢复记录与固定来源不一致')
    if (recovery.phase === 'source-base') {
      const route = `/v1/projects/${encodeURIComponent(record.task.projectId)}`
      let result: PrototypeSourceBaseResult
      try {
        const receipt = await this.api.request<{ action: string; result: PrototypeSourceBaseResult }>('GET', `${route}/operations/${encodeURIComponent(request.idempotencyKey)}`)
        await this.account(record.accountId)
        if (receipt.action !== `prototype.task.source-base:${record.task.entityId}`) throw new Error('原操作不是 source-base 登记')
        result = receipt.result
      } catch (error) {
        await this.account(record.accountId)
        if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
        result = await this.api.request<PrototypeSourceBaseResult>('PUT', `${route}/prototype/tasks/${encodeURIComponent(record.task.entityId)}/source-base`, request)
        await this.account(record.accountId)
      }
      recovery.result = this.sourceBaseResult(record, recovery, result)
      record.authorization = structuredClone(recovery.result.task)
      record.task.baseHead = recovery.result.task.sourceBaseHead
      recovery.phase = 'writeback'
      await this.account(record.accountId); await storage.write(data)
    }
    if (!recovery.result || recovery.phase !== 'writeback') throw new Error('原冲突 source-base 恢复阶段无效')
    const current = await this.current(record)
    const restored = await this.ports.git.prototypeRestoreConflict(current.task.worktree, {
      directory: recovery.directory, operationId: record.id, sourceBaseHead: record.summary.sourceBaseHead,
      sourceSha: request.sourceSha, expectedHead: request.newBaseHead, mergeBaseSha: recovery.mergeBaseSha,
      writeScope: current.authorization.writeScope, ...(recovery.writeback ? { writeback: structuredClone(recovery.writeback) } : {}),
      onPlan: async writeback => { recovery.writeback = structuredClone(writeback); await this.account(record.accountId); await storage.write(data) },
      onPathRestored: async filePath => {
        const entry = recovery.writeback?.files.find(value => value.path === filePath)
        if (!entry) throw new Error('写回路径不在原恢复计划中')
        entry.status = 'written'; await this.account(record.accountId); await storage.write(data)
      },
    })
    await this.account(record.accountId)
    if (canonical([...restored.conflictFiles].sort()) !== canonical([...recovery.conflictFiles].sort()) || !recovery.writeback || recovery.writeback.files.some(value => value.status !== 'written')) throw new Error('写回状态与原冲突恢复计划不一致')
    recovery.phase = 'restored'
    await this.account(record.accountId); await storage.write(data)
  }
  async prepare(taskId: string, operationId: string): Promise<PrototypeCandidateSummary> {
    const { accountId, storage, data } = await this.state()
    let record = data.operations.find(value => value.id === operationId)
    if (record && (record.accountId !== accountId || record.task.entityId !== taskId)) throw new Error('同一操作不能用于其他事项')
    if (record?.status === 'conflict') throw new Error('冲突修复必须使用新的固定操作，原候选已保留')
    if (!record) {
      const unresolved = await this.integrations.unresolved(taskId)
      if (unresolved) throw new Error('此事项仍有未收敛的原型集成，请先核对原操作；原候选和现场已保留')
      const pending = data.operations.filter(value => value.task.entityId === taskId && value.status === 'conflict' && value.recovery?.phase !== 'restored')
      if (pending.length > 1) throw new Error('存在多个未收敛的原型冲突，请保留原记录核对')
      if (pending[0]) await this.recoverConflict(pending[0], storage, data)
      const current = await this.collaboration.confirmationTask(taskId)
      await this.account(accountId)
      record = { id: operationId, accountId, ...structuredClone(current), status: 'fixing' }
      data.operations.push(record); await storage.write(data)
    }
    const current = await this.current(record)
    const identity = await this.ports.git.identity(current.task.worktree)
    const fixed = await this.ports.git.prototypeSource(current.task.worktree, current.authorization.sourceBaseHead, operationId, current.authorization.writeScope, identity)
    await this.current(record)
    const changes = (await this.ports.git.changedPathStatuses(current.task.worktree, current.authorization.sourceBaseHead, fixed.sha)).map(value => ({ path: value.path, status: value.status === 'A' ? 'added' as const : value.status === 'D' ? 'deleted' as const : 'modified' as const }))
    if (canonical([...changes.map(value => value.path)].sort()) !== canonical([...fixed.changedPaths].sort())) throw new Error('候选变更路径不一致，请保留原操作核对')
    const status = changes.length ? 'ready' as const : 'no-change' as const
    const content = { operationId, projectId: current.task.projectId, prototypeTaskId: taskId, title: current.authorization.title, sourceBaseHead: current.authorization.sourceBaseHead, sourceSha: fixed.sha,
      claimsDigest: current.authorization.claimsDigest, developmentRequirementIds: [...current.authorization.developmentRequirementIds].sort(), changes }
    const summaryHash = digest(canonical({ ...content, binding: this.binding(current) }))
    if (record.summary && record.summary.summaryHash !== summaryHash) throw new Error('原候选内容已变化，请重新固定成果')
    record.summary ??= { ...content, summaryHash, status }
    if (record.status !== 'confirmed') record.status = status
    await this.account(accountId); await storage.write(data)
    return structuredClone(record.summary)
  }
  async latest(taskIds: string[]): Promise<PrototypeCandidateSummary[]> {
    const { data } = await this.state()
    const result: PrototypeCandidateSummary[] = []
    for (const taskId of taskIds) {
      const found = data.operations.findLast(value => value.task.entityId === taskId && value.summary)
      if (found?.summary) {
        const integration = await this.integrations.operation(found.id)
        result.push({ ...structuredClone(found.summary), ...(integration ? { integrationPhase: integration.phase } : {}) })
      }
    }
    return result
  }
  async readFile(operationId: string, filePath: string): Promise<PrototypeCandidateFile> {
    const { data } = await this.state(), record = data.operations.find(value => value.id === operationId)
    if (!record?.summary || !record.summary.changes.some(value => value.path === filePath)) throw new Error('候选文件不存在或不在本次变更中')
    const operation = await this.integrations.operation(operationId)
    if (operation?.phase === 'accepted' && operation.integrationId) {
      await this.account(record.accountId)
      const result = await this.api.request<{ id: string; status: string; prototypeTaskId: string; sourceSha: string; candidateSha: string }>('GET', `/v1/projects/${encodeURIComponent(record.task.projectId)}/prototype/integrations/${encodeURIComponent(operation.integrationId)}`)
      await this.account(record.accountId)
      if (result.id !== operation.integrationId || result.status !== 'accepted' || result.prototypeTaskId !== record.task.entityId || result.sourceSha !== record.summary.sourceSha || result.candidateSha !== operation.request.candidateSha) throw new Error('已接受的原候选身份无法核对')
    } else await this.current(record)
    const [base, source] = await Promise.all([this.ports.git.readOptionalBlob(record.task.worktree, record.summary.sourceBaseHead, filePath), this.ports.git.readOptionalBlob(record.task.worktree, record.summary.sourceSha, filePath)])
    await this.account(record.accountId)
    const binary = [base, source].some(bytes => !!bytes && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)))
    return { path: filePath, binary, truncated: false, ...(!binary && base ? { baseContent: base.toString('utf8') } : {}), ...(!binary && source ? { sourceContent: source.toString('utf8') } : {}) }
  }
  /** Bind engineering checks to the exact candidate tree, not merely the current Git HEAD. */
  async check(operationId: string, checkOperationId: string): Promise<PrototypeCandidateSummary> {
    const { accountId, storage, data } = await this.state(), record = data.operations.find(value => value.id === operationId)
    if (!record?.summary || record.status === 'no-change' || record.status === 'conflict') throw new Error('没有可检查的原型候选')
    const current = await this.current(record), source = record.summary.sourceSha
    const fixed = await this.ports.git.prototypeSource(current.task.worktree, current.authorization.sourceBaseHead, operationId, current.authorization.writeScope, await this.ports.git.identity(current.task.worktree))
    if (fixed.sha !== source) throw new Error('原候选已变化，请重新固定成果')
    const files = await this.ports.git.prototypeSnapshot(current.task.worktree, source)
    const expectedInputHash = snapshotHash(files)
    if (record.checkOperationId === checkOperationId && record.evidence?.candidateSha === source && record.evidence.sourceTreeHash === expectedInputHash) return structuredClone(record.summary)
    delete record.evidence; delete record.checkOperationId; delete record.summary.checks
    await this.account(accountId); await storage.write(data)
    const evidence = await this.ports.candidateChecks(current.task, source, checkOperationId)
    await this.current(record)
    const after = await this.ports.git.prototypeSource(current.task.worktree, current.authorization.sourceBaseHead, operationId, current.authorization.writeScope, await this.ports.git.identity(current.task.worktree))
    if (after.sha !== source || evidence.candidateSha !== source || evidence.sourceTreeHash !== expectedInputHash) throw new Error('工程检查与固定候选不一致，请重新核对')
    record.evidence = structuredClone(evidence); record.checkOperationId = checkOperationId; record.summary.checks = 'passed'
    await this.account(accountId); await storage.write(data)
    return structuredClone(record.summary)
  }
  async confirm(operationId: string, expectedSummaryHash: string): Promise<PrototypeCandidateSummary> {
    const { accountId, storage, data } = await this.state(), record = data.operations.find(value => value.id === operationId)
    if (!record?.summary || record.summary.summaryHash !== expectedSummaryHash || record.status === 'no-change' || record.status === 'conflict') throw new Error('候选摘要已变化、没有代码变化或原候选正在等待冲突修复')
    const current = await this.current(record)
    const fixed = await this.ports.git.prototypeSource(current.task.worktree, current.authorization.sourceBaseHead, operationId, current.authorization.writeScope, await this.ports.git.identity(current.task.worktree))
    if (fixed.sha !== record.summary.sourceSha) throw new Error('候选成果已变化，请重新固定并阅读')
    await this.current(record)
    record.status = 'confirmed'; record.confirmationId ??= randomUUID(); record.summary.status = 'confirmed'; record.summary.confirmedAt ??= new Date().toISOString()
    await this.account(accountId); await storage.write(data)
    return structuredClone(record.summary)
  }
  /** Preserve the author's source ref before attempting any merge or backend preparation. */
  private async uploadSource(record: CandidateRecord, storage: ProjectRecord<CandidateState>, data: CandidateState): Promise<void> {
    const summary = record.summary!
    const ref = `refs/heads/studio-private/${record.task.entityId}/${record.id}/source`, branch = ref.slice('refs/heads/'.length)
    if (record.sourceUpload && (record.sourceUpload.ref !== ref || record.sourceUpload.sha !== summary.sourceSha)) throw new Error('原来源上传记录与固定成果不一致')
    record.sourceUpload ??= { ref, sha: summary.sourceSha, status: 'uploading' }
    await this.account(record.accountId); await storage.write(data)
    const existing = await this.ports.git.optionalRemoteHead(record.task.worktree, branch)
    await this.account(record.accountId)
    if (existing && existing !== summary.sourceSha) throw new Error('原来源引用已指向其他提交，已保留原操作')
    if (!existing) { await this.ports.git.pushNewBranch(record.task.worktree, branch, summary.sourceSha); await this.account(record.accountId) }
    if (await this.ports.git.optionalRemoteHead(record.task.worktree, branch) !== summary.sourceSha) throw new Error('原来源上传结果待核对')
    await this.account(record.accountId)
    record.sourceUpload.status = 'uploaded'; await storage.write(data)
  }
  /** Remove one registered temporary directory without following links or leaving its managed root. */
  private async removeManagedDirectory(root: string, directory: string, prefix: string): Promise<void> {
    const managed = path.resolve(root), target = path.resolve(directory)
    if (path.dirname(target) !== managed || !path.basename(target).startsWith(prefix)) throw new Error('原型临时目录越出本账号受管根目录，现场已保留')
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info) return
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('原型临时目录不能是符号链接或非目录，现场已保留')
    const rootInfo = await lstat(managed)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('原型临时目录受管根目录无效，现场已保留')
    const [actualRoot, actualTarget] = await Promise.all([realpath(managed), realpath(target)])
    if (path.dirname(actualTarget) !== actualRoot) throw new Error('原型临时目录实际位置越界，现场已保留')
    await rm(target, { recursive: true, force: true })
  }
  /** Delete only temporary directories registered by this accepted operation; author and conflict state stays untouched. */
  async cleanupAccepted(operationId: string): Promise<void> {
    const { accountId, data } = await this.state(), record = data.operations.find(value => value.id === operationId)
    if (!record || record.accountId !== accountId) throw new Error('原 accepted operation 的候选登记不存在，临时现场已保留')
    const operation = await this.integrations.operation(operationId)
    await this.account(accountId)
    if (!operation || operation.phase !== 'accepted' || operation.accountId !== accountId || operation.projectId !== record.task.projectId || operation.taskId !== record.task.entityId) throw new Error('候选临时目录与原 accepted operation 身份不一致，现场已保留')
    const mergeRoot = path.join(await this.store.projectDirectory(record.task.projectId), 'prototype-merges'), checkRoot = path.join(await this.store.projectDirectory(record.task.projectId), 'prototype-candidate-checks')
    for (const scene of record.mergeScenes ?? []) if (scene.status === 'merged') {
      await this.account(accountId)
      await this.removeManagedDirectory(mergeRoot, scene.directory, 'prototype-merge-')
      await this.account(accountId)
    }
    for (const directory of record.mergeCheckDirectories ?? []) {
      await this.account(accountId)
      await this.removeManagedDirectory(checkRoot, directory, 'candidate-')
      await this.account(accountId)
    }
  }

  /** Check the merged Git tree in a separate snapshot, without changing the author's worktree. */
  private async checkMerged(record: CandidateRecord, storage: ProjectRecord<CandidateState>, data: CandidateState, checkOperationId: string): Promise<PrototypeEngineeringEvidence> {
    const merged = record.merged!
    const files = await this.ports.git.prototypeSnapshot(record.task.worktree, merged.candidateSha)
    const expectedInputHash = snapshotHash(files)
    if (merged.checkOperationId === checkOperationId && merged.evidence?.candidateSha === merged.candidateSha && merged.evidence.sourceTreeHash === expectedInputHash) return merged.evidence
    delete merged.evidence; delete merged.checkOperationId
    await this.account(record.accountId); await storage.write(data)
    const root = path.join(await this.store.projectDirectory(record.task.projectId), 'prototype-candidate-checks')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(path.join(root, 'candidate-')), prototype = path.join(directory, '原型代码')
    ;(record.mergeCheckDirectories ??= []).push(directory)
    await this.account(record.accountId); await storage.write(data)
    await mkdir(prototype, { mode: 0o700 }); await writePrototypeSnapshot(prototype, files)
    await this.current(record)
    const evidence = await this.ports.candidateChecks({ ...record.task, worktree: directory }, merged.candidateSha, checkOperationId)
    await this.current(record)
    if (evidence.candidateSha !== merged.candidateSha || evidence.sourceTreeHash !== expectedInputHash) throw new Error('合并候选检查与固定 Git 树不一致，检查现场已保留')
    merged.evidence = structuredClone(evidence); merged.checkOperationId = checkOperationId
    await this.account(record.accountId); await storage.write(data)
    return evidence
  }

  /** Construct and recheck a clean merged candidate while retaining the original confirmation. */
  async submit(operationId: string, checkOperationId: string): Promise<void> {
    if (await this.integrations.operation(operationId)) { await this.integrations.resume(operationId); return }
    const before = await this.state(), original = before.data.operations.find(value => value.id === operationId)
    if (!original?.summary || original.status !== 'confirmed' || !original.confirmationId) throw new Error('请先确认固定的原型成果')
    await this.check(operationId, checkOperationId)
    const { storage, data } = await this.state(), record = data.operations.find(value => value.id === operationId)
    if (!record?.summary || !record.evidence || !record.confirmationId || record.status !== 'confirmed') throw new Error('原型确认或检查记录不可用')
    const current = await this.current(record)
    await this.uploadSource(record, storage, data)
    const project = await this.api.request<ProjectState>('GET', `/v1/projects/${encodeURIComponent(current.task.projectId)}`)
    await this.account(record.accountId)
    const expectedHead = project.project.recognizedHead
    if (project.project.id !== current.task.projectId || !expectedHead || !project.project.stableBranch) throw new Error('项目认可头不可用，请保留原候选')
    let candidateSha = record.summary.sourceSha, evidence = record.evidence
    if (expectedHead !== record.summary.sourceBaseHead) {
      await this.ports.git.fetch(current.task.worktree, project.project.stableBranch)
      await this.account(record.accountId)
      if (await this.ports.git.remoteHead(current.task.worktree, project.project.stableBranch) !== expectedHead) throw new Error('项目 Git 头与认可头不一致，请保留原候选核对')
      await this.account(record.accountId)
      const merged = await this.ports.git.prototypeCleanMerge(current.task.worktree, { operationRoot: path.join(await this.store.projectDirectory(record.task.projectId), 'prototype-merges'), operationId,
        sourceBaseHead: record.summary.sourceBaseHead, sourceSha: record.summary.sourceSha, expectedHead,
        writeScope: current.authorization.writeScope, identity: await this.ports.git.identity(current.task.worktree) })
      await this.current(record)
      if (merged.status === 'conflicted') {
        if (record.sourceUpload?.status !== 'uploaded') throw new Error('原冲突来源尚未完成上传核对')
        ;(record.mergeScenes ??= []).push({ expectedHead, mergeBaseSha: merged.mergeBaseSha, directory: merged.directory, status: 'conflicted' })
        const request: UpdatePrototypeSourceBaseRequest = {
          idempotencyKey: digest(`${operationId}:source-base:${expectedHead}`),
          token: { prototypeTaskId: current.authorization.id, generation: current.authorization.generation, clientId: current.authorization.clientId, expectedRevision: current.authorization.revision },
          sourceOperationId: operationId, sourceRef: record.sourceUpload.ref, sourceSha: record.summary.sourceSha, newBaseHead: expectedHead,
          developmentClaims: structuredClone(current.authorization.developmentClaims), claimsDigest: current.authorization.claimsDigest,
        }
        record.recovery = { request, directory: merged.directory, mergeBaseSha: merged.mergeBaseSha, conflictFiles: [...merged.conflictFiles], phase: 'source-base' }
        record.status = 'conflict'; record.summary.status = 'conflict'
        record.summary.conflict = { expectedHead, files: merged.conflictFiles.map(value => `原型代码/${value}`) }
        delete record.summary.confirmedAt; delete record.summary.checks
        delete record.confirmationId; delete record.evidence; delete record.checkOperationId; delete record.merged
        await this.account(record.accountId); await storage.write(data)
        await this.recoverConflict(record, storage, data)
        throw new Error('发生冲突，请在当前事项中修复后重新固定并确认；原来源和合并现场已保留')
      }
      ;(record.mergeScenes ??= []).push({ expectedHead, mergeBaseSha: merged.mergeBaseSha, directory: merged.retainedDirectory, status: 'merged' })
      if (!record.merged || record.merged.expectedHead !== expectedHead || record.merged.candidateSha !== merged.candidateSha || record.merged.mergeBaseSha !== merged.mergeBaseSha) {
        record.merged = { expectedHead, candidateSha: merged.candidateSha, mergeBaseSha: merged.mergeBaseSha }
      }
      await this.account(record.accountId); await storage.write(data)
      candidateSha = merged.candidateSha
      evidence = await this.checkMerged(record, storage, data, `${checkOperationId}-merged`)
    }
    const fixed = await this.ports.git.prototypeSource(current.task.worktree, current.authorization.sourceBaseHead, operationId, current.authorization.writeScope, await this.ports.git.identity(current.task.worktree))
    if (fixed.sha !== record.summary.sourceSha) throw new Error('原作者来源已变化，请重新固定成果')
    await this.current(record)
    const prefix = `refs/heads/studio-private/${current.task.entityId}/${operationId}`
    const request: PrototypeIntegrationRequest = {
      idempotencyKey: operationId, stage: 'prototype', prototypeId: current.authorization.prototypeId,
      token: { prototypeTaskId: current.authorization.id, generation: current.authorization.generation, clientId: current.authorization.clientId, expectedRevision: current.authorization.revision },
      sourceSha: record.summary.sourceSha, sourceBaseHead: record.summary.sourceBaseHead, expectedHead,
      candidateSha, sourceRef: `${prefix}/source`, candidateRef: `${prefix}/candidate`,
      allowedPaths: record.summary.changes.map(value => value.path), developmentRequirementIds: current.authorization.developmentRequirementIds,
      developmentClaims: current.authorization.developmentClaims, claimsDigest: current.authorization.claimsDigest, evidence,
      authorConfirmation: { confirmationId: record.confirmationId, sourceSha: record.summary.sourceSha, authorConfirmed: true, claimsDigest: current.authorization.claimsDigest, mergePolicy: 'clean-merge-and-recheck' },
    }
    await this.integrations.submitConfirmed(current.task, request)
  }
}
