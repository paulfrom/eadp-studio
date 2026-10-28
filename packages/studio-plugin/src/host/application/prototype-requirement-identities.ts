import type { EntityView, ProjectState } from '@eadp/contracts'
import type { HostPorts } from './ports.ts'
import type { RequirementIdentity } from '../adapters/dsh/prototype-requirements.ts'

/** Map the model result only to readable identities and literal spans from this instruction. */
export async function resolvePrototypeRequirements(ports: HostPorts, state: ProjectState, instruction: string, existingIds: string[], explicitIds: string[]): Promise<string[]> {
  if (!ports.identifyPrototypeRequirements) throw new Error('需求身份识别不可用，原指令已保留')
  const readable = state.entities.filter((entity): entity is EntityView => entity.kind === 'requirement' && 'generation' in entity)
  const requirements: RequirementIdentity[] = readable.map(entity => ({ id: entity.id, title: entity.title, ...(entity.code ? { code: entity.code } : {}) }))
  const allowed = new Set(requirements.map(value => value.id))
  if (explicitIds.some(id => !allowed.has(id)) || existingIds.some(id => !allowed.has(id))) throw new Error('指令中的需求不存在或当前账号不可读取')
  if (requirements.length > 1000 || instruction.length > 32000) throw new Error('需求目录或指令超过识别范围，请缩小本次描述')
  const text = await ports.identifyPrototypeRequirements({ instruction, requirements, existingIds, explicitIds }, AbortSignal.timeout(60_000))
  let result: unknown
  try { result = JSON.parse(text) } catch { throw new Error('需求身份识别结果无法解析，原指令已保留') }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('需求身份识别结果无效，原指令已保留')
  const value = result as { targets?: unknown; ambiguous?: unknown }
  if (!Array.isArray(value.targets) || typeof value.ambiguous !== 'boolean' || value.targets.length > 100) throw new Error('需求身份识别结果无效，原指令已保留')
  if (value.ambiguous) throw new Error('无法确定指令中要开发的需求，请补充需求名称或编号；原指令已保留')
  const inferred: string[] = []
  for (const target of value.targets) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('需求身份识别结果无效，原指令已保留')
    const item = target as { id?: unknown; mention?: unknown }
    if (typeof item.id !== 'string' || !allowed.has(item.id) || typeof item.mention !== 'string' || !item.mention.trim() || !instruction.includes(item.mention) || inferred.includes(item.id)) throw new Error('需求身份识别结果与原指令或可读目录不一致')
    inferred.push(item.id)
  }
  const resultIds = [...new Set([...explicitIds, ...inferred])]
  if (resultIds.length > 100) throw new Error('一次指令涉及的需求超过数量限制')
  return resultIds
}
