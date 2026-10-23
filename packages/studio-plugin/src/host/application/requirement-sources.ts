import { parseBuiltinScenario } from '@eadp/asset-domain'
import type { EntityView, FixedReference, FixedVersion } from '@eadp/contracts'
import type { RequirementSourceView } from '../../shared/requirement-workspace.ts'
import { digest, parseMaterial } from '../adapters/assets/materials.ts'

interface SourceReader {
  versions(entityId: string): Promise<FixedVersion[]>
  read(fixed: FixedReference): Promise<Uint8Array>
}

/** Read the formally pinned version, preserving it when its scenario has newer accepted content. */
export async function readRequirementSource(projectId: string, requirement: EntityView, sourceEntityId: string, expectedVersion: number, reader: SourceReader): Promise<RequirementSourceView> {
  if (requirement.kind !== 'requirement') throw new Error('此操作只适用于需求材料')
  const binding = requirement.scenarioSources?.find(source => source.entityId === sourceEntityId)
  if (!binding || binding.projectId !== projectId) throw new Error('未找到同项目的正式场景来源')
  if (binding.version !== expectedVersion) throw new Error('来源版本与正式关系不一致，请先保存需求来源并重新查看')
  const version = (await reader.versions(sourceEntityId)).find(value => value.version === binding.version)
  if (!version || version.metadata.kind !== 'scenario' || version.metadata.entityId !== sourceEntityId) throw new Error('来源固定确认版本无效或不可见')
  const bytes = await reader.read(version.fixed)
  if (bytes.byteLength > 1_000_000 || digest(bytes) !== version.fixed.sha256) throw new Error('来源固定内容超限或哈希不符')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let body: string
  if (version.builtin) { parseBuiltinScenario(text, sourceEntityId); body = text.slice(0, text.lastIndexOf('\n```eadp-metadata\n')) }
  else {
    const draft = parseMaterial(Buffer.from(bytes), version.fixed.path)
    if (draft.entityId !== sourceEntityId || draft.metadata.kind !== 'scenario') throw new Error('来源固定内容身份无效')
    body = draft.body
  }
  return { entityId: sourceEntityId, title: version.title ?? version.metadata.title, version: version.version,
    confirmationId: version.confirmationId, fixed: { ...version.fixed }, builtin: version.builtin === true, body }
}
