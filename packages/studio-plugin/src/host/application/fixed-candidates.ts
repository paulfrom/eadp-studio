import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { canonical } from '@eadp/asset-domain'
import { reviewInputText } from '@eadp/contracts'
import type { CheckEvidence, ConfirmationInput, EntityView, OccupationToken, ProjectState } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../shared/studio.ts'
import { checkMaterial, containedFile, digest, normalizeMaterialPath, parseMaterial, readMaterial } from '../adapters/assets/materials.ts'
import type { HostPorts } from './ports.ts'
import type { ReviewCandidate, ReviewFile } from './reviews.ts'
import type { StudioStore } from './state.ts'

/** The material or prototype input, optionally bound to a recorded confirmation task. */
export interface FixedCandidateRequest {
  entityId: string
  purpose: 'material' | 'prototype'
  expectedHash?: string
  projectId?: string
  task?: TaskView
  operationId?: string
  fixedInput?: FixedCandidateInput
}

export interface FixedCandidateDependencies {
  entity(entityId: string, projectId?: string): Promise<{ remote: ProjectState; entity: EntityView }>
  designTask(remote: ProjectState, entity: EntityView): Promise<TaskView>
  prototypeTask(remote: ProjectState, entity: EntityView): Promise<TaskView>
  owned(entity: EntityView): Promise<OccupationToken>
  identity(projectId: string): Promise<{ name: string; email: string }>
  pruneEvidence(task: TaskView): Promise<void>
}

/** Owns the exact content, path scope and fixed commit shared by review and confirmation. */
export class FixedCandidates {
  constructor(private readonly store: StudioStore, private readonly ports: HostPorts, private readonly deps: FixedCandidateDependencies) {}

  /** Reads the exact local input without committing, running checks or writing remotely. */
  async content(request: FixedCandidateRequest) {
    const projectId = request.projectId ?? request.task?.projectId
    let context = await this.deps.entity(request.entityId, projectId)
    const task = request.task ?? await (request.purpose === 'prototype'
      ? this.deps.prototypeTask(context.remote, context.entity)
      : this.deps.designTask(context.remote, context.entity))
    context = await this.deps.entity(request.entityId, context.remote.project.id)
    const { remote, entity } = context, token = await this.deps.owned(entity)
    await this.requireTask(task, remote, entity, token, request.purpose)
    const draft = await this.currentMaterialDraft(task, entity)
    if (request.expectedHash && draft.sha256 !== request.expectedHash) throw new Error('材料已变化，请阅读并确认新版本')
    // The snapshot starts from the task HEAD; target files are bound by their own hashes.
    const head = (await this.ports.git.state(task.worktree)).head
    let paths: string[], allowedPaths: string[]
    const confirmations: Array<Pick<ConfirmationInput, 'entityId' | 'expectedRevision' | 'fixed'>> = []
    const prepareBase = { idempotencyKey: request.operationId ?? randomUUID(), entityId: entity.id, token, expectedHead: remote.project.recognizedHead! }
    const drafts = [{ entity, draft }]
    if (request.purpose === 'material') {
      checkMaterial(draft)
      if (entity.kind === 'scenario') {
        const contextBytes = await readFile(await containedFile(task.worktree, 'CONTEXT.md')).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        })
        if (contextBytes && !draft.metadata.files?.some(file => file.path === 'CONTEXT.md' && file.sha256 === digest(contextBytes))) throw new Error('项目上下文尚未纳入场景文件包，请保存场景后重新确认')
      }
      const materialPaths = drafts.map(value => value.draft.path)
      const evidenceFiles = new Map(drafts.flatMap(value => [...value.draft.metadata.businessEvidence.flatMap(evidence => evidence.files), ...(value.draft.metadata.files ?? [])]).map(file => [file.path, file]))
      for (const file of evidenceFiles.values()) {
        const bytes = await readFile(await containedFile(task.worktree, file.path))
        if (digest(bytes) !== file.sha256) throw new Error(`正式依据或关联文件已变化：${file.path}`)
      }
      paths = [...new Set([...materialPaths, ...evidenceFiles.keys()])]
      const replaced = await this.replacedMaterialPaths(task, prepareBase.expectedHead, new Set(drafts.map(value => value.entity.id)))
      allowedPaths = [...new Set([...paths, ...replaced])]
      // The fixed commit is filled in after the snapshot; review binds the content hash.
      for (const value of drafts) confirmations.push({ entityId: value.entity.id, expectedRevision: value.entity.revision, fixed: { commitSha: '', path: value.draft.path, sha256: value.draft.sha256 } })
    } else {
      if (entity.kind !== 'requirement' || !entity.current || task.inputHash !== entity.current.fixed.sha256 || draft.sha256 !== entity.current.fixed.sha256) throw new Error('原型输入已失效，请重新确认需求')
      const committed = head === prepareBase.expectedHead ? [] : await this.ports.git.changedFiles(task.worktree, prepareBase.expectedHead, head)
      paths = [...new Set([...committed, ...await this.dirtyPaths(task)])]
      if (!paths.length || paths.some(file => !file.startsWith('原型代码/'))) throw new Error('候选相对当前项目基线没有有效变化或包含本任务范围外提交')
      allowedPaths = paths
      confirmations.push({ entityId: entity.id, expectedRevision: entity.revision, fixed: entity.current.fixed })
    }
    const stage = request.purpose === 'prototype' ? 'prototype' as const : 'material' as const
    const input = { ...prepareBase, stage, confirmations }
    return { remote, entity, task, draft, drafts, paths, allowedPaths, confirmations, input,
      inputHash: digest(reviewInputText(input, entity)),
      snapshot: { head, files: await this.snapshotFiles(task.worktree, allowedPaths) } }
  }

  /** Commits only the owned paths and binds checks and review evidence to that candidate. */
  async prepare(request: FixedCandidateRequest) {
    const current = await this.content(request)
    const content = request.fixedInput ? await this.restoreInput(current, request.fixedInput) : current
    const { task, draft, entity, remote } = content
    let candidateSha: string, paths = content.paths, allowedPaths = content.allowedPaths, checks: CheckEvidence
    if (request.purpose === 'material') {
      await this.deps.pruneEvidence(task)
      const allowed = new Set(allowedPaths)
      candidateSha = (await this.candidateSha(task, content.input.expectedHead, file => allowed.has(file), allowedPaths, '固定材料 ' + entity.id)).sha
      for (const relative of paths) await this.ports.git.verifyFile(task.worktree, candidateSha, relative)
      checks = { candidateSha, passed: true, checks: content.drafts.flatMap(value => this.materialChecks(candidateSha, value.draft).checks) }
      for (const value of content.confirmations) value.fixed.commitSha = candidateSha
    } else {
      const allowed = request.fixedInput ? (file: string) => allowedPaths.includes(file) : (file: string) => file.startsWith('原型代码/')
      const candidate = await this.candidateSha(task, content.input.expectedHead, allowed, [], '固定原型 ' + entity.id)
      candidateSha = candidate.sha
      if (!request.fixedInput) { paths = candidate.changed; allowedPaths = paths }
      checks = await this.ports.checks(task, candidateSha)
    }
    const prepare = { ...content.input, sourceSha: candidateSha, candidateSha, allowedPaths, checks }
    const review: ReviewCandidate = { projectId: remote.project.id, entityId: entity.id, purpose: request.purpose, head: content.snapshot.head, inputHash: content.inputHash, files: content.snapshot.files, paths, task, candidateSha }
    return { task, draft, prepare, confirmations: content.confirmations, review }
  }

  /** Reuse the original review snapshot even when its commit completed before a process interruption. */
  private async restoreInput(current: PreparedContent, fixed: FixedCandidateInput): Promise<PreparedContent> {
    if (canonical(current.input) !== canonical(fixed.input) || current.inputHash !== fixed.inputHash || !/^[a-f0-9]{40}$/.test(fixed.snapshot.head)) throw new Error('原固定输入的版本、占用或确认身份已变化，请保留原操作并重新核对')
    const samePaths = (left: readonly string[], right: readonly string[]): boolean => canonical([...left].sort()) === canonical([...right].sort())
    const allowed = new Set(fixed.allowedPaths)
    if (allowed.size !== fixed.allowedPaths.length || new Set(fixed.paths).size !== fixed.paths.length || !samePaths(current.paths, fixed.paths) || fixed.paths.some(file => !allowed.has(file)) || current.allowedPaths.some(file => !allowed.has(file)) || !samePaths(fixed.snapshot.files.map(file => file.path), fixed.allowedPaths)) throw new Error('原固定输入的文件范围已变化，请重新核对原候选')
    // A committed title rename disappears from porcelain; only this material's
    // removed baseline paths may remain in the persisted scope after that point.
    const removed = fixed.allowedPaths.filter(file => !current.allowedPaths.includes(file))
    if (removed.length) {
      const owned = await this.ownedMaterialPaths(current.task, fixed.input.expectedHead, removed, new Set(fixed.input.confirmations.map(value => value.entityId)))
      if (!samePaths(owned, removed) || removed.some(file => fixed.snapshot.files.find(value => value.path === file)?.sha256 !== null)) throw new Error('原固定输入包含不属于本材料的删除路径')
    }
    const actual = await this.snapshotFiles(current.task.worktree, fixed.allowedPaths)
    if (canonical(actual) !== canonical([...fixed.snapshot.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) throw new Error('原固定输入的文件内容已变化，请核对当前内容后重新确认')
    if (current.snapshot.head !== fixed.snapshot.head) await this.requireCompletedCommit(current, fixed)
    const input = structuredClone(fixed.input)
    return { ...current, input, confirmations: input.confirmations, inputHash: fixed.inputHash,
      snapshot: structuredClone(fixed.snapshot), paths: [...fixed.paths], allowedPaths: [...fixed.allowedPaths] }
  }

  /** A recovered commit must be the original snapshot's single successor with exactly its recorded bytes. */
  private async requireCompletedCommit(current: PreparedContent, fixed: FixedCandidateInput): Promise<void> {
    const head = current.snapshot.head, original = fixed.snapshot.head
    const parents = (await this.ports.gitLocal(['rev-list', '--parents', '-n', '1', head], current.task.worktree)).trim().split(/\s+/)
    const changed = await this.ports.git.changedFiles(current.task.worktree, original, head)
    if (parents.length !== 2 || parents[0] !== head || parents[1] !== original || !changed.length || changed.some(file => !fixed.allowedPaths.includes(file))) throw new Error('原固定输入之后出现其他提交或范围外变更，请保留原候选并核对')
    for (const file of fixed.snapshot.files) {
      const bytes = await this.ports.git.readOptionalBlob(current.task.worktree, head, file.path)
      if ((bytes ? digest(bytes) : null) !== file.sha256) throw new Error('已提交候选与原固定输入不一致，不能重新制作替代候选')
    }
    if ((await this.dirtyPaths(current.task)).some(file => fixed.allowedPaths.includes(file))) throw new Error('候选提交后存在新的文件变更，请核对原候选')
  }

  /** A recorded task cannot be replaced by another session or a newly acquired occupation. */
  private async requireTask(task: TaskView, remote: ProjectState, entity: EntityView, token: OccupationToken, purpose: FixedCandidateRequest['purpose']): Promise<void> {
    const expectedPurpose = purpose === 'prototype' ? 'prototype' : entity.kind === 'handoff' ? 'handoff' : 'material'
    const registered = (await this.store.read()).tasks.some(value => value.projectId === task.projectId && value.entityId === task.entityId && value.worktree === task.worktree && value.sessionId === task.sessionId && value.purpose === task.purpose && value.inputHash === task.inputHash)
    if (!registered || task.projectId !== remote.project.id || task.entityId !== entity.id || task.purpose !== expectedPurpose || path.basename(task.worktree) !== token.taskId || entity.occupation?.purpose !== (purpose === 'prototype' ? 'prototype' : 'design')) throw new Error('原任务现场与当前材料占用不一致，请保留现场并重新核对')
  }

  materialChecks(candidateSha: string, draft: MaterialDraft): CheckEvidence {
    checkMaterial(draft)
    return { candidateSha, passed: true, checks: ['materials', 'relations'].map(name => ({ name, passed: true, evidenceHash: digest(`${name}:${draft.sha256}`) })) }
  }

  /** Working-tree paths this task changed, including both sides of a rename. */
  private async dirtyPaths(task: TaskView): Promise<string[]> {
    const entries = (await this.ports.gitLocal(['status', '--porcelain=v1', '-z', '--untracked-files=all'], task.worktree)).split('\0').filter(Boolean)
    const dirty: string[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!, name = entry.slice(3); dirty.push(name)
      if (/[RC]/.test(entry.slice(0, 2))) { const source = entries[++index]; if (!source) throw new Error('Git 变更列表不完整'); dirty.push(source) }
    }
    return dirty
  }

  private async candidateSha(task: TaskView, expectedHead: string, allowed: (file: string) => boolean, files: string[], message: string): Promise<{ sha: string; changed: string[] }> {
    const dirty = await this.dirtyPaths(task)
    if (dirty.some(file => !allowed(file))) throw new Error('存在本任务允许范围外的变更，请先处理后再固定候选')
    const sha = dirty.length ? await this.ports.git.commitFiles(task.worktree, files.length ? files : dirty, message, await this.deps.identity(task.projectId)) : (await this.ports.git.state(task.worktree)).head
    const changed = await this.ports.git.changedFiles(task.worktree, expectedHead, sha)
    if (!changed.length || changed.some(file => !allowed(file))) throw new Error('候选相对当前项目基线没有有效变化或包含本任务范围外提交')
    return { sha, changed }
  }

  /** Reads a material that is about to be fixed, first giving it the path its title requires. */
  private async currentMaterialDraft(task: TaskView, entity: EntityView): Promise<MaterialDraft> {
    const draft = await readMaterial(task.worktree, entity.kind, entity.id)
    const relative = await normalizeMaterialPath(task.worktree, draft)
    return relative === draft.path ? draft : { ...draft, path: relative }
  }

  /** Only removed paths whose baseline material identity belongs to this candidate enter its scope. */
  private async replacedMaterialPaths(task: TaskView, expectedHead: string, entityIds: Set<string>): Promise<string[]> {
    const entries = (await this.ports.gitLocal(['status', '--porcelain=v1', '-z', '--untracked-files=all'], task.worktree)).split('\0').filter(Boolean)
    const removed = new Set<string>()
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!, status = entry.slice(0, 2), name = entry.slice(3)
      if (/[RC]/.test(status)) { const source = entries[++index]; if (source && status.includes('R')) removed.add(source) }
      if (status.includes('D')) removed.add(name)
    }
    return this.ownedMaterialPaths(task, expectedHead, [...removed], entityIds)
  }

  /** Resolve deleted baseline material identities before admitting their paths to the candidate scope. */
  private async ownedMaterialPaths(task: TaskView, expectedHead: string, removed: readonly string[], entityIds: Set<string>): Promise<string[]> {
    const owned: string[] = []
    for (const relative of removed) {
      const bytes = await this.ports.git.readBlob(task.worktree, expectedHead, relative).catch(() => undefined)
      if (!bytes) continue
      try { if (entityIds.has(parseMaterial(bytes, relative).entityId)) owned.push(relative) }
      catch { /* A removed non-material path never enters the candidate scope. */ }
    }
    return owned
  }

  /** Content identity of the worktree bytes a review and its confirmation must share. */
  private async snapshotFiles(root: string, files: readonly string[]): Promise<ReviewFile[]> {
    const result: ReviewFile[] = []
    for (const relative of [...new Set(files)].sort()) {
      const bytes = await readFile(await containedFile(root, relative)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      result.push({ path: relative, sha256: bytes ? digest(bytes) : null })
    }
    return result
  }
}

export type PreparedContent = Awaited<ReturnType<FixedCandidates['content']>>
export type FixedCandidateInput = Pick<PreparedContent, 'snapshot' | 'paths' | 'allowedPaths' | 'input' | 'inputHash'>
export type PreparedCandidate = Awaited<ReturnType<FixedCandidates['prepare']>>
