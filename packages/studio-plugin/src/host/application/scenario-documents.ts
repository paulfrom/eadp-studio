import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { canonical, validateMaterialMetadata } from '@eadp/asset-domain'
import { isMaterialMetadata, type MaterialMetadata } from '@eadp/contracts'
import type { MaterialDraft } from '../../shared/studio.ts'
import type { ScenarioConflict, ScenarioGate, ScenarioSuggestionBatch } from '../../shared/scenarios.ts'
import { atomicWriteFile, containedFile, digest, materialPath, materialText, parseMaterial, readMaterial } from '../adapters/assets/materials.ts'
import { sameTemplate, suggestionBody } from './scenario-suggestions.ts'

interface SaveInput { root: string; metadata: MaterialMetadata; body: string; expectedHash: string; operationId: string }
interface ApplyInput { root: string; draft: MaterialDraft; batch: ScenarioSuggestionBatch; selectedItemIds: readonly string[]; expectedHash: string; operationId: string; readEvidenceIds: readonly string[] }
interface Receipt { fingerprint: string; result: MaterialDraft; committed: boolean }
const queues = new Map<string, Promise<unknown>>()

/** Carries both preserved inputs so the UI can offer an explicit merge without losing either version. */
export class ScenarioDocumentConflictError extends Error {
  readonly code = 'SCENARIO_DOCUMENT_CONFLICT'
  constructor(readonly conflict: ScenarioConflict | undefined, readonly savedPaths: { external: string; local: string }, readonly actualHash: string) { super('场景文件已被外部修改，两份内容已保留，请解决冲突后再继续') }
}

async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const running = previous.catch(() => {}).then(work)
  queues.set(key, running)
  try { return await running } finally { if (queues.get(key) === running) queues.delete(key) }
}
function operationId(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)) throw new Error('本地保存操作 ID 无效') }

/** Owns all controlled scenario writes and persistent receipts, serializing each material independently. */
export class ScenarioDocumentService {
  constructor(private readonly localRoot: string) {}

  private async localStore(root: string): Promise<string> {
    const directory = path.resolve(this.localRoot, 'scenario-documents', digest(root))
    const relative = path.relative(root, directory)
    if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('场景本地过程数据目录必须位于用户工程之外')
    await mkdir(directory, { recursive: true })
    return realpath(directory)
  }
  async save(input: SaveInput): Promise<MaterialDraft> {
    const root = await realpath(input.root)
    const relative = materialPath(input.metadata.kind, input.metadata.entityId)
    return serialized(`${root}/${relative}`, () => this.write({ ...input, root }))
  }

  async apply(input: ApplyInput): Promise<MaterialDraft> {
    const root = await realpath(input.root)
    const relative = materialPath(input.draft.metadata.kind, input.draft.entityId)
    return serialized(`${root}/${relative}`, async () => {
      const { status: _status, error: _error, ...protocol } = input.batch
      const fingerprint = digest(canonical({ action: 'apply', entityId: input.draft.entityId, batch: protocol, selectedItemIds: [...input.selectedItemIds].sort(), expectedHash: input.expectedHash }))
      const repeated = await this.receipt(root, input.draft.entityId, input.operationId, fingerprint)
      if (repeated) return repeated
      if (input.expectedHash !== input.draft.sha256) throw new Error('采纳时读取的场景版本无效')
      const body = suggestionBody(input.draft, input.batch, input.selectedItemIds, input.readEvidenceIds)
      return this.write({ root, metadata: input.draft.metadata, body, expectedHash: input.expectedHash, operationId: input.operationId }, fingerprint)
    })
  }

  private receiptPath(entityId: string, id: string): string { operationId(entityId); operationId(id); return `operations/${entityId}/${id}.json` }

  private async receipt(root: string, entityId: string, id: string, fingerprint: string): Promise<MaterialDraft | undefined> {
    const file = await containedFile(await this.localStore(root), this.receiptPath(entityId, id), true)
    const bytes = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!bytes) return undefined
    const saved = JSON.parse(bytes) as Receipt
    if (saved.fingerprint !== fingerprint) throw new Error('同一操作 ID 不能用于不同的场景写入')
    if (saved.committed) return saved.result
    // A process may stop after rename and before persisting the completed receipt.
    const actual = await readMaterial(root, 'scenario', entityId)
    if (actual.sha256 === saved.result.sha256) {
      await atomicWriteFile(file, JSON.stringify({ ...saved, committed: true }))
      return saved.result
    }
    return undefined
  }

  private async preserveConflict(input: SaveInput, external: Buffer): Promise<never> {
    const store = await this.localStore(input.root)
    const prefix = `conflicts/${input.metadata.entityId}/${randomUUID()}`
    const savedPaths = { external: await containedFile(store, `${prefix}/external.md`, true), local: await containedFile(store, `${prefix}/local.md`, true) }
    await atomicWriteFile(savedPaths.external, external)
    await atomicWriteFile(savedPaths.local, materialText(input.metadata, input.body))
    let actual: MaterialDraft | undefined
    try { actual = parseMaterial(external, materialPath(input.metadata.kind, input.metadata.entityId)) } catch { /* Preserve malformed external edits before reporting the conflict. */ }
    throw new ScenarioDocumentConflictError(actual ? { expectedHash: input.expectedHash, actual, localBody: input.body, localMetadata: input.metadata, savedPath: path.join(store, prefix) } : undefined, savedPaths, digest(external))
  }

  private async write(input: SaveInput, suppliedFingerprint?: string): Promise<MaterialDraft> {
    if (input.metadata.kind !== 'scenario' || !isMaterialMetadata(input.metadata) || !/^[a-f0-9]{64}$/.test(input.expectedHash)) throw new Error('场景保存身份或预期版本无效')
    operationId(input.operationId)
    const fingerprint = suppliedFingerprint ?? digest(canonical({ metadata: input.metadata, body: input.body, expectedHash: input.expectedHash }))
    const repeated = await this.receipt(input.root, input.metadata.entityId, input.operationId, fingerprint)
    if (repeated) return repeated
    const relative = materialPath('scenario', input.metadata.entityId)
    const target = await containedFile(input.root, relative)
    const external = await readFile(target)
    if (digest(external) !== input.expectedHash) return this.preserveConflict(input, external)
    const current = parseMaterial(external, relative)
    if (current.metadata.kind !== 'scenario' || input.metadata.templateId !== current.metadata.templateId || !sameTemplate(input.metadata.templateRef, current.metadata.templateRef)) throw new Error('保存不能隐式更换场景模板绑定')
    const text = materialText(input.metadata, input.body)
    const result = parseMaterial(Buffer.from(text), relative)
    const temporary = `${relative}.${randomUUID()}.tmp`
    const temporaryFile = await containedFile(input.root, temporary, true)
    const receiptFile = await containedFile(await this.localStore(input.root), this.receiptPath(input.metadata.entityId, input.operationId), true)
    // Prepare both files before the final comparison; serialization also prevents competing Host writes.
    try {
      await atomicWriteFile(temporaryFile, text)
      const latest = await readFile(target)
      if (digest(latest) !== input.expectedHash) return this.preserveConflict(input, latest)
      await atomicWriteFile(receiptFile, JSON.stringify({ fingerprint, result, committed: false } satisfies Receipt))
      const beforeRename = await readFile(target)
      if (digest(beforeRename) !== input.expectedHash) return this.preserveConflict(input, beforeRename)
      await rename(temporaryFile, target)
      await atomicWriteFile(receiptFile, JSON.stringify({ fingerprint, result, committed: true } satisfies Receipt))
      return result
    } finally { await rm(temporaryFile, { force: true }) }
  }
}

export interface ScenarioCheckInput {
  draft: MaterialDraft; expectedHash: string; hasPermission: boolean; hasOccupation: boolean;
  conflict?: boolean; structureCheck?: boolean; templateBody?: string; fileErrors?: readonly string[];
}
/** Groups fixed checks separately from the optional, local template preference. */
export function checkScenarioDocument(input: ScenarioCheckInput): { hash: string; passed: boolean; groups: ScenarioGate[] } {
  const { draft } = input, metadata = draft.metadata
  const business: string[] = [], evidence: string[] = [...(input.fileErrors ?? [])], version: string[] = [], template: string[] = []
  if (metadata.kind !== 'scenario') business.push('当前材料不是项目场景')
  if (!metadata.coreRulesPresent) business.push('核心业务规则尚未声明完整')
  if (!metadata.acceptanceCriteriaPresent) business.push('验收条件尚未声明完整')
  business.push(...metadata.openQuestions.filter(question => question.blocking).map(question => question.limitation))
  if (!metadata.businessEvidence.length) evidence.push('请选定并归档真实业务依据')
  try { validateMaterialMetadata({ ...metadata, coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [] }) } catch (error) { evidence.push(error instanceof Error ? error.message : '资料与引用无效') }
  if (draft.sha256 !== input.expectedHash) version.push('当前文件已不是用户阅读的版本')
  if (!input.hasPermission) version.push('当前用户没有确认权限')
  if (!input.hasOccupation) version.push('当前用户没有有效设计占用')
  if (input.conflict) version.push('文件冲突尚未解决')
  if (input.structureCheck) {
    if (input.templateBody === undefined) template.push('无法读取所选模板固定版本')
    else {
      const current = new Set(headings(draft.body))
      for (const heading of headings(input.templateBody)) if (!current.has(heading)) template.push(`缺少模板二级章节：${heading}`)
    }
  }
  const gate = (id: ScenarioGate['id'], label: string, messages: string[], enabled = true): ScenarioGate => ({ id, label, messages, status: !enabled ? 'disabled' : messages.length ? 'blocked' : 'passed' })
  const groups = [gate('business', '业务内容', business), gate('evidence', '资料与引用', evidence), gate('version', '版本与占用', version), gate('template', '模板结构', template, input.structureCheck === true)]
  return { hash: draft.sha256, passed: groups.every(group => group.status !== 'blocked'), groups }
}

function headings(markdown: string): string[] {
  let fence: string | undefined
  const result: string[] = []
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; continue }
    if (!fence) { const heading = /^ {0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)?.[1]?.trim(); if (heading) result.push(heading) }
  }
  return result
}

/** Checks current bytes; confirmation must repeat the same checks against its fixed Git tree. */
export async function scenarioFileErrors(root: string, draft: MaterialDraft): Promise<string[]> {
  const errors: string[] = [], files = new Map<string, string>()
  for (const file of [...(draft.metadata.files ?? []), ...draft.metadata.businessEvidence.flatMap(item => item.files)]) {
    if (files.has(file.path)) { if (files.get(file.path) !== file.sha256) errors.push(`文件 hash 声明冲突：${file.path}`); continue }
    files.set(file.path, file.sha256)
    try { if (digest(await readFile(await containedFile(root, file.path))) !== file.sha256) errors.push(`文件内容已变化：${file.path}`) }
    catch { errors.push(`文件缺失或路径无效：${file.path}`) }
  }
  for (const evidence of draft.metadata.businessEvidence) for (const range of evidence.ranges) {
    try {
      const lines = (await readFile(await containedFile(root, range.path), 'utf8')).split('\n').length
      if (range.startLine < 1 || range.endLine < range.startLine || range.endLine > lines || !evidence.files.some(file => file.path === range.path)) errors.push(`依据引用范围无效：${range.path}`)
    } catch { errors.push(`无法读取依据范围：${range.path}`) }
  }
  return [...new Set(errors)]
}
