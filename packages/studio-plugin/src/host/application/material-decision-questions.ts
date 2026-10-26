import type { MaterialDecisionQuestion, MaterialDecisionQuestionOption } from '../../shared/scenarios.ts'

export interface ParsedMaterialDecisionQuestions {
  questions: Array<{
    key: string
    title: string
    reason: string
    evidenceIds: string[]
    options: Array<{ key: string; label: string; description: string }>
  }>
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const questionLimit = 12
const optionLimit = 8
const evidenceLimit = 50

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw new Error('本轮问题字段无效')
  return value as Record<string, unknown>
}

function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('本轮问题 ID 无效')
}

function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error('本轮问题文本无效或过大')
}

function normalized(response: string): string {
  return response.replace(/\r\n/g, '\n')
}

/** Detects a malformed fenced question block as well as a valid one. */
export function hasMaterialDecisionQuestions(response: string): boolean {
  return /^```[^\n]*eadp-material-questions/m.test(normalized(response))
}

/** Parses the optional per-turn question block and rejects references the Host did not read. */
export function parseMaterialDecisionQuestions(response: string, entityId: string, readEvidenceIds: readonly string[]): ParsedMaterialDecisionQuestions {
  if (response.length > 2_000_000) throw new Error('本轮问题代码块过大')
  const source = normalized(response)
  if ([...source.matchAll(/^```[^\n]*eadp-material-questions[^\n]*$/gm)].length !== 1) throw new Error('需要且仅允许一个 eadp-material-questions JSON 块')
  const payload = /^```eadp-material-questions[ \t]*\n([^]*?)^```[ \t]*$/m.exec(source)
  if (!payload) throw new Error('需要且仅允许一个 eadp-material-questions JSON 块')

  let decoded: unknown
  try { decoded = JSON.parse(payload[1]!) } catch { throw new Error('本轮问题代码块不是合法 JSON') }
  const value = object(decoded, ['entityId', 'questions'])
  id(value.entityId)
  if (value.entityId !== entityId) throw new Error('本轮问题材料身份不一致')
  if (!Array.isArray(value.questions) || value.questions.length > questionLimit) throw new Error('本轮问题数量无效')

  const available = new Set(readEvidenceIds)
  const questionKeys = new Set<string>()
  const questions: ParsedMaterialDecisionQuestions['questions'] = []
  for (const rawQuestion of value.questions) {
    const question = object(rawQuestion, ['key', 'title', 'reason', 'evidenceIds', 'options'])
    id(question.key)
    text(question.title, 1_000)
    text(question.reason, 2_000)
    if (questionKeys.has(question.key)) throw new Error('本轮问题包含重复 ID')
    questionKeys.add(question.key)

    if (!Array.isArray(question.evidenceIds) || question.evidenceIds.length > evidenceLimit) throw new Error('本轮问题依据无效')
    const evidenceIds: string[] = [], seenEvidence = new Set<string>()
    for (const evidenceId of question.evidenceIds) {
      id(evidenceId)
      if (!available.has(evidenceId)) throw new Error('本轮问题引用了未实际读取的资料')
      if (seenEvidence.has(evidenceId)) throw new Error('本轮问题包含重复依据')
      seenEvidence.add(evidenceId)
      evidenceIds.push(evidenceId)
    }

    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > optionLimit) throw new Error('本轮问题选项数量无效')
    const optionKeys = new Set<string>()
    const options: ParsedMaterialDecisionQuestions['questions'][number]['options'] = []
    for (const rawOption of question.options) {
      const option = object(rawOption, ['key', 'label', 'description'])
      id(option.key)
      text(option.label, 160)
      text(option.description, 600)
      if (optionKeys.has(option.key)) throw new Error('本轮问题包含重复选项 ID')
      optionKeys.add(option.key)
      options.push({ key: option.key, label: option.label.trim(), description: option.description.trim() })
    }
    questions.push({ key: question.key, title: question.title.trim(), reason: question.reason.trim(), evidenceIds, options })
  }
  return { questions }
}

/** Adds a Host-owned turn identity to model-local keys before projection or persistence. */
export function identifyMaterialQuestions(turnId: string, questions: ParsedMaterialDecisionQuestions['questions']): MaterialDecisionQuestion[] {
  return questions.map(question => ({
    id: `${turnId}:${question.key}`,
    title: question.title,
    reason: question.reason,
    evidenceIds: question.evidenceIds,
    options: question.options.map(option => ({ id: `${turnId}:${question.key}:${option.key}`, label: option.label, description: option.description } satisfies MaterialDecisionQuestionOption)),
  }))
}
