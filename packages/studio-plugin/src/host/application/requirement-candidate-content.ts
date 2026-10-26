import { isBuiltinScenarioMetadata } from '@eadp/contracts'
import { readFile, writeFile } from 'node:fs/promises'
import type { FixedReference, MaterialMetadata } from '@eadp/contracts'
import type { Candidate } from '../../shared/requirements.ts'
import { containedFile, digest, parseMaterial } from '../adapters/assets/materials.ts'

/** Archive only the accepted ordinary scene bytes actually used by the adopted candidate. */
export async function candidateBusinessEvidence(root: string, candidate: Candidate,
  readFixed: (projectId: string, fixed: FixedReference) => Promise<Uint8Array>): Promise<MaterialMetadata['businessEvidence']> {
  const evidence: MaterialMetadata['businessEvidence'] = []
  for (const source of candidate.sources) {
    const bytes = Buffer.from(await readFixed(source.projectId, source.fixed))
    if (digest(bytes) !== source.fixed.sha256) throw new Error('候选来源固定内容已变化')
    const draft = parseMaterial(bytes, source.fixed.path)
    if (draft.metadata.kind !== 'scenario' || draft.entityId !== source.entityId || isBuiltinScenarioMetadata(draft.metadata)) throw new Error('候选依据必须是真实已确认普通场景')
    const text = bytes.toString('utf8'), lines = draft.body.split('\n')
    const offset = text.slice(0, text.length - draft.body.length).split('\n').length - 1
    for (const excerpt of source.excerpts) if (lines.slice(excerpt.startLine - 1, excerpt.endLine).join('\n') !== excerpt.text) throw new Error('候选原文片段与固定输入不符')
    const relative = `.eadp/evidence/${source.fixed.sha256}/scenario.md`
    const target = await containedFile(root, relative, true)
    try { await writeFile(target, bytes, { flag: 'wx' }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!bytes.equals(await readFile(await containedFile(root, relative)))) throw new Error('候选依据归档已变化，请保留当前文件并核对')
    }
    evidence.push({ label: '已确认普通场景', reference: `${source.entityId} v${source.version} / ${source.confirmationId}`,
      files: [{ path: relative, sha256: source.fixed.sha256 }],
      ranges: source.excerpts.map(excerpt => ({ path: relative, startLine: offset + excerpt.startLine, endLine: offset + excerpt.endLine })),
    })
  }
  return evidence
}
