import { randomUUID } from 'node:crypto'
import type { FixedReference, MaterialMetadata } from '@eadp/contracts'
import type { Candidate, CandidateExcerpt, CandidateSource, CandidateTemplate, SplitSource } from '../../shared/requirements.ts'
import type { TaskView } from '../../shared/studio.ts'
import { digest, parseMaterial } from '../adapters/assets/materials.ts'
import type { HostPorts } from './ports.ts'
import type { StudioStore } from './state.ts'

export const requirementSplitRules = '从本次已读取的普通场景固定正文按独立业务能力拆分需求，可包含多页面、主流程和异常分支。已有需求只用于减少重复，不自动判定覆盖、合并或改写。每个候选只绑定实际相关的所选场景子集及可核对原文。冲突保留待澄清，不自行裁决。仅提出候选，不修改文件、预留身份或确认材料。'
const maxInputBytes = 1_000_000
// Catalogs read at a newer project head may name identical template bytes. Keep the
// candidate's original accepted reference unless the selected template itself changed.
const sameTemplate = (left: CandidateTemplate, right: CandidateTemplate): boolean => left.id === right.id && left.body === right.body && left.fixed.path === right.fixed.path && left.fixed.sha256 === right.fixed.sha256
const sourceKey = (source: SplitSource): string => `${source.projectId}:${source.entityId}`
const clone = <T>(value: T): T => structuredClone(value)

export interface RequirementCandidateDependencies {
  readFixed(projectId: string, fixed: FixedReference): Promise<Uint8Array>
  template(projectId: string): Promise<CandidateTemplate>
  /** Reserve with candidate.id as the operation key and the candidate's exact fixed sources/template. */
  create(candidate: Candidate): Promise<{ id: string }>
  /** Write the adopted body once; an exact replay is allowed, changed user content is preserved. */
  write(candidate: Candidate, entityId: string): Promise<void>
}
export interface SplitRequest {
  projectId: string; worktree: string; sources: SplitSource[];
  existingRequirements: Array<{ id: string; title: string; summary?: string }>
}
interface ReadSource { source: SplitSource; body: string }

/** Fixed-input splitting and idempotent adoption, separate from material creation and Git orchestration. */
export class RequirementCandidates {
  constructor(private readonly store: StudioStore, private readonly ports: Pick<HostPorts, 'session' | 'prompt'>, private readonly dependencies: RequirementCandidateDependencies) {}

  /** Every explicit request starts a new round; older candidates and their fixed sources remain available. */
  async start(request: SplitRequest): Promise<TaskView> {
    this.validateSources(request.projectId, request.sources)
    const inputs = await this.readSources(request.sources)
    const template = await this.dependencies.template(request.projectId)
    this.validateTemplate(template)
    const id = randomUUID()
    const task: TaskView = {
      projectId: request.projectId, entityId: request.sources[0]!.entityId, worktree: request.worktree,
      purpose: 'split', sessionId: `studio-split-${id}`,
      inputHash: digest(JSON.stringify({ sources: request.sources, template })),
      split: { id, sources: clone(request.sources), template: clone(template), existingRequirements: clone(request.existingRequirements), status: 'pending' },
    }
    const local = await this.store.read()
    local.tasks.push(task); await this.store.save()
    await this.deliver(task, inputs)
    return task
  }

  /** Reopen the original durable session; an unsaved send verdict replays the exact request for DSH deduplication. */
  async resume(sessionId: string): Promise<string> {
    const local = await this.store.read(), task = local.tasks.find(value => value.sessionId === sessionId && value.purpose === 'split')
    if (!task?.split) throw new Error('未找到原拆分任务')
    if (task.split.status === 'sent' || task.split.status === 'completed') return this.ports.session(task, requirementSplitRules)
    await this.assertTemplate(task.projectId, task.split.template)
    await this.deliver(task, await this.readSources(task.split.sources))
    return task.sessionId
  }

  private async deliver(task: TaskView, inputs: ReadSource[]): Promise<void> {
    try {
      const prompt = this.prompt(task, inputs, task.split!.existingRequirements)
      await this.ports.session(task, requirementSplitRules)
      await this.ports.prompt(task.sessionId, prompt)
      task.split!.status = 'sent'; delete task.error; await this.store.save()
    } catch (error) {
      task.split!.status = 'failed'; task.error = message(error, '需求拆分请求未完成'); await this.store.save(); throw error
    }
  }

  /** Accept only one bounded response whose excerpts can be verified against the exact supplied bytes. */
  async accept(sessionId: string, content: string): Promise<boolean> {
    const local = await this.store.read(), task = local.tasks.find(value => value.sessionId === sessionId && value.purpose === 'split')
    if (!task?.split) return false
    if (task.split.status === 'completed') return true
    const matches = [...content.matchAll(/```eadp-candidates\s*\n([\s\S]*?)\n```/g)]
    if (!matches.length) return true
    try {
      if (matches.length !== 1 || Buffer.byteLength(content) > maxInputBytes) throw new Error('需求候选须包含唯一且大小受限的 eadp-candidates JSON')
      await this.assertTemplate(task.projectId, task.split.template)
      const inputs = await this.readSources(task.split.sources)
      const values: unknown = JSON.parse(matches[0]![1]!)
      if (!Array.isArray(values) || values.length > 50) throw new Error('需求候选必须为最多 50 项的数组')
      const candidates = values.map(value => this.candidate(task, value, inputs))
      local.candidates.push(...candidates)
      task.split.status = 'completed'; delete task.error; await this.store.save()
    } catch (error) {
      task.split.status = 'failed'; task.error = message(error, '需求候选无效'); await this.store.save(); throw error
    }
    return true
  }

  /** A lost response or body-write failure resumes the original candidate's reserved identity. */
  async select(id: string, projectId: string, expectedInputHash: string): Promise<string> {
    const local = await this.store.read(), candidate = local.candidates.find(value => value.id === id && value.projectId === projectId)
    if (!candidate) throw new Error('候选不存在或不属于当前项目')
    if (candidate.inputHash !== expectedInputHash) throw new Error('候选输入已变化，请重新查看后采用')
    if (candidate.selectedEntityId) return candidate.selectedEntityId
    if (!candidate.reservedEntityId) {
      await this.assertTemplate(projectId, candidate.template)
      await this.readSources(candidate.sources)
      const entity = await this.dependencies.create(candidate)
      candidate.reservedEntityId = entity.id; await this.store.save()
    }
    await this.dependencies.write(candidate, candidate.reservedEntityId)
    candidate.selectedEntityId = candidate.reservedEntityId; await this.store.save()
    return candidate.selectedEntityId
  }

  private validateSources(projectId: string, sources: SplitSource[]): void {
    if (!sources.length || sources.length > 100 || new Set(sources.map(sourceKey)).size !== sources.length) throw new Error('请选择一个或多个不同的已确认普通场景')
    for (const source of sources) if (source.projectId !== projectId || !Number.isSafeInteger(source.version) || source.version < 1 || !source.confirmationId || !source.entityId) throw new Error('拆分来源必须是同项目的明确已接受版本')
  }

  private validateTemplate(template: CandidateTemplate): void {
    if (!template.id || !template.body.trim() || digest(template.body) !== template.fixed.sha256) throw new Error('需求模板固定内容校验失败')
  }

  private async assertTemplate(projectId: string, expected: CandidateTemplate): Promise<void> {
    const actual = await this.dependencies.template(projectId)
    this.validateTemplate(actual)
    if (!sameTemplate(expected, actual)) throw new Error('需求模板上下文已变化，请重新生成候选')
  }

  private async readSources(sources: SplitSource[]): Promise<ReadSource[]> {
    let bytesRead = 0
    const inputs: ReadSource[] = []
    for (const source of sources) {
      const bytes = await this.dependencies.readFixed(source.projectId, source.fixed)
      bytesRead += bytes.byteLength
      if (bytesRead > maxInputBytes) throw new Error('拆分固定输入超过读取边界，请减少所选场景')
      if (digest(bytes) !== source.fixed.sha256) throw new Error('场景拆分固定输入哈希校验失败')
      const draft = parseMaterial(Buffer.from(bytes), source.fixed.path)
      if (draft.metadata.kind !== 'scenario' || draft.entityId !== source.entityId || !draft.metadata.businessEvidence.length) throw new Error('拆分只接受真实已确认普通场景，通用场景不能作为业务依据')
      inputs.push({ source, body: draft.body })
    }
    return inputs
  }

  private prompt(task: TaskView, inputs: ReadSource[], existing: SplitRequest['existingRequirements']): string {
    const template = task.split!.template
    const protocol = '[{"title":"业务能力名称","summary":"摘要","goal":"目标","scope":"范围","rules":["业务规则"],"acceptanceCriteria":["可判断验收"],"openQuestions":[{"blocking":true,"limitation":"仍需澄清的问题","excludedScope":"未明确时排除范围"}],"sources":[{"entityId":"实际相关的已选场景ID","excerpts":[{"startLine":1,"endLine":1,"text":"对应行的完整原文"}]}],"body":"按已选需求模板整理完整Markdown，保留目标、范围、每项规则、验收及待澄清的原文表达"}]'
    const sourceText = inputs.map(({ source, body }) => `场景固定引用：${JSON.stringify(source)}\n正文行号从 1 开始；摘录须是范围对应行的完整原文：\n${body.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n')}`).join('\n\n')
    const text = `本次拆分 ${task.split!.id}，输入哈希 ${task.inputHash}。每项代表可独立描述、验证和交付的业务能力，不按页面或步骤机械拆分。先解释拆分思路和每条候选为什么独立成立，最后输出唯一代码块 eadp-candidates，摘要不超过 2000 字符，JSON结构为 ${protocol}。不能编造未读取来源或资料，不能合并、覆盖或修改已有需求。无待澄清时 openQuestions 为 []。正文不能携带 eadp-metadata 技术身份块。来源追溯由 Host 附加。\n\n需求模板固定引用：${JSON.stringify({ id: template.id, fixed: template.fixed })}\n${template.body}\n\n已有相关需求（仅减少重复，不代表已覆盖）：${JSON.stringify(existing)}\n\n${sourceText}`
    if (Buffer.byteLength(text) > maxInputBytes) throw new Error('拆分上下文超过读取边界，请减少所选场景')
    return text
  }

  private candidate(task: TaskView, value: unknown, inputs: ReadSource[]): Candidate {
    const item = record(value, ['title', 'summary', 'goal', 'scope', 'rules', 'acceptanceCriteria', 'openQuestions', 'sources', 'body'])
    const title = text(item.title, 150), summary = text(item.summary, 2000), goal = text(item.goal, 10_000), scope = text(item.scope, 10_000)
    const rules = texts(item.rules), acceptanceCriteria = texts(item.acceptanceCriteria)
    const openQuestions = questions(item.openQuestions)
    const body = text(item.body, maxInputBytes)
    if (/```eadp-metadata\b/.test(body) || body.includes('\r') || body.charCodeAt(0) === 0xfeff) throw new Error('候选正文不得包含技术身份块，须使用 UTF-8 LF Markdown')
    if ([goal, scope, ...rules, ...acceptanceCriteria, ...openQuestions.flatMap(q => [q.limitation, q.excludedScope])].some(part => !body.includes(part))) throw new Error('候选正文未完整承接目标、范围、规则、验收或待澄清项')
    const sources = this.candidateSources(item.sources, inputs)
    return { id: randomUUID(), projectId: task.projectId, sessionId: task.sessionId, splitId: task.split!.id, inputHash: task.inputHash,
      title, summary, goal, scope, rules, acceptanceCriteria, sources, template: clone(task.split!.template),
      quality: { coreRulesPresent: rules.length > 0, acceptanceCriteriaPresent: acceptanceCriteria.length > 0, openQuestions },
      body: `${body.trimEnd()}\n\n${traceability(sources)}\n`,
    }
  }

  private candidateSources(value: unknown, inputs: ReadSource[]): CandidateSource[] {
    if (!Array.isArray(value) || !value.length || value.length > inputs.length) throw new Error('候选须绑定实际相关的所选来源子集')
    const seen = new Set<string>()
    return value.map(entry => {
      const source = record(entry, ['entityId', 'excerpts'])
      const input = inputs.find(value => value.source.entityId === source.entityId)
      if (!input || seen.has(input.source.entityId)) throw new Error('候选包含未读取、未选择或重复的场景来源')
      seen.add(input.source.entityId)
      if (!Array.isArray(source.excerpts) || !source.excerpts.length || source.excerpts.length > 20) throw new Error('候选来源须保留实际原文片段')
      const lines = input.body.split('\n')
      const excerpts: CandidateExcerpt[] = source.excerpts.map(value => {
        const excerpt = record(value, ['startLine', 'endLine', 'text'])
        const startLine = excerpt.startLine as number, endLine = excerpt.endLine as number
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) throw new Error('来源片段行号无效')
        const actual = lines.slice(startLine - 1, endLine).join('\n')
        if (!actual.trim() || excerpt.text !== actual) throw new Error('来源片段与已读取固定原文不一致')
        return { startLine, endLine, text: actual }
      })
      return { ...clone(input.source), excerpts }
    })
  }
}

function message(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('需求候选字段无效')
  return value as Record<string, unknown>
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('需求候选文本无效或超限')
  return value
}
function texts(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error('需求候选规则或验收无效')
  return value.map(entry => text(entry, 10_000))
}
function questions(value: unknown): MaterialMetadata['openQuestions'] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('需求候选待澄清项无效')
  return value.map(entry => {
    const item = record(entry, ['blocking', 'limitation', 'excludedScope'])
    if (typeof item.blocking !== 'boolean') throw new Error('需求候选待澄清项无效')
    return { blocking: item.blocking, limitation: text(item.limitation, 500), excludedScope: text(item.excludedScope, 500) }
  })
}
function traceability(sources: CandidateSource[]): string {
  return '## 场景来源追溯\n\n' + sources.map(source => `### ${source.title}\n\n项目：${source.projectId}；场景：${source.entityId}；版本：${source.version}；确认记录：${source.confirmationId}\n\n固定文件：${source.fixed.path}；提交：${source.fixed.commitSha}；SHA-256：${source.fixed.sha256}\n\n` + source.excerpts.map(excerpt => `正文第 ${excerpt.startLine}—${excerpt.endLine} 行：\n\n${excerpt.text.split('\n').map(line => `> ${line}`).join('\n')}`).join('\n\n')).join('\n\n')
}
