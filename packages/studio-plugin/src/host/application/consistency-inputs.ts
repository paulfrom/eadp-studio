import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isMaterialPathOf, parseBuiltinScenario } from '@eadp/asset-domain'
import type { ConsistencyContextView } from '@eadp/contracts'
import type { ConsistencyModelInput } from '../../shared/consistency.ts'
import { containedFile, digest, parseMaterial } from '../adapters/assets/materials.ts'
import type { TaskView } from '../../shared/studio.ts'

const maxFiles = 200, maxFileBytes = 1_000_000, maxInputBytes = 200_000
type InputMaterial = ConsistencyModelInput['materials'][number]

/** Read an ordinary contained file once; the returned bytes are also the model's hash input. */
export async function readComparisonBytes(root: string, relative: string): Promise<Buffer> {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('对比工作区必须是本机实际目录')
  const filename = await containedFile(root, relative)
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxFileBytes) throw new Error('对比文件不是范围内的普通材料')
    // A bounded read also refuses files that grow after fstat, without allocating their full contents.
    const buffer = Buffer.alloc(maxFileBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > maxFileBytes) throw new Error('对比文件超过读取边界')
    return buffer.subarray(0, length)
  } finally { await handle.close() }
}

function identify(bytes: Buffer, relative: string, builtin: ConsistencyContextView['builtinScenario']): Pick<InputMaterial, 'entityId' | 'kind' | 'text' | 'sha256' | 'path'> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (relative === '场景/通用场景.md') {
    if (!builtin || builtin.path !== relative) throw new Error('内置场景缺少后台目录身份')
    parseBuiltinScenario(text, builtin.entityId)
    return { entityId: builtin.entityId, kind: 'scenario', text, sha256: digest(bytes), path: relative }
  }
  const draft = parseMaterial(bytes, relative)
  if (draft.metadata.kind !== 'scenario' && draft.metadata.kind !== 'requirement') throw new Error('对比只接受场景与需求')
  return { entityId: draft.entityId, kind: draft.metadata.kind, text, sha256: draft.sha256, path: relative }
}

/** Catalog paths and titles prioritize the target and formal relationships before bounded discovery. */
function inputPriority(relative: string, context: ConsistencyContextView | undefined): number {
  if (!context) return 2
  const target = context.entity
  if (target.path === relative || (target.kind === 'scenario' || target.kind === 'requirement') && isMaterialPathOf(target.kind, relative, target.title)) return 0
  if (context.sources.some(source => source.fixed.path === relative || isMaterialPathOf('scenario', relative, source.title))
    || [...context.requirements, ...context.prerequisites].some(value => value.path === relative || isMaterialPathOf('requirement', relative, value.title))) return 1
  return 2
}

function expectedKind(entityId: string, context: ConsistencyContextView | undefined): string | undefined {
  if (context?.entity.id === entityId) return context.entity.kind
  if (context?.sources.some(source => source.entityId === entityId) || context?.builtinScenario?.entityId === entityId) return 'scenario'
  if (context?.requirements.some(value => value.id === entityId) || context?.prerequisites.some(value => value.requirementId === entityId)) return 'requirement'
  return undefined
}

/** Inputs never use fixed-version loaders, project state refreshes, Git, or another task's worktree. */
export async function collectComparisonInputs(root: string, projectId: string, targetId: string, context: ConsistencyContextView | undefined, tasks: TaskView[], signal: AbortSignal): Promise<ConsistencyModelInput> {
  const limitations: string[] = context ? [] : ['正式关系目录不可用']
  const formalIds = new Set(context ? [...context.sources.map(value => value.entityId), ...context.requirements.map(value => value.id), ...context.prerequisites.map(value => value.requirementId)] : [])
  const materials: InputMaterial[] = [], duplicates = new Set<string>()
  const files: string[] = []
  for (const directory of ['场景', '需求']) {
    try {
      const info = await lstat(path.join(root, directory))
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('材料目录无效')
      files.push(...(await readdir(path.join(root, directory))).filter(name => name.endsWith('.md')).map(name => `${directory}/${name}`))
    } catch { limitations.push(`${directory}目录缺失或不可读取`); continue }
  }
  files.sort((left, right) => inputPriority(left, context) - inputPriority(right, context) || left.localeCompare(right))
  if (files.length > maxFiles) limitations.push('本地材料数量超过读取边界')
  for (const relative of files.slice(0, maxFiles)) {
    signal.throwIfAborted()
    try {
      const value = identify(await readComparisonBytes(root, relative), relative, context?.builtinScenario)
      const kind = expectedKind(value.entityId, context)
      if (kind && kind !== value.kind) throw new Error('本地材料类型与正式关系身份不一致')
      if (materials.some(material => material.entityId === value.entityId)) { duplicates.add(value.entityId); limitations.push('本地材料身份重复'); continue }
      const task = tasks.find(task => task.projectId === projectId && task.entityId === value.entityId && task.purpose === 'material' && path.resolve(task.worktree) === path.resolve(root) && !task.cleanup)
      const occupied = value.entityId === context?.entity.id ? context.entity.occupied : context?.requirements.find(item => item.id === value.entityId)?.occupied
      materials.push({ ...value, relation: value.entityId === targetId ? 'target' : formalIds.has(value.entityId) ? 'formal' : 'potential', state: task ? 'local-draft' : occupied ? 'unverified' : 'current-file' })
    } catch { limitations.push('部分本地材料缺失、不可读、编码或身份无效，或超过读取边界') }
  }
  const rank = { target: 0, formal: 1, potential: 2 }
  const ordered = materials.filter(material => !duplicates.has(material.entityId)).sort((a, b) => rank[a.relation] - rank[b.relation] || a.path.localeCompare(b.path))
  const selected: InputMaterial[] = []
  let bytes = 0
  for (const material of ordered) {
    const size = Buffer.byteLength(JSON.stringify(material))
    if (bytes + size > maxInputBytes) { limitations.push('模型输入超过上下文读取边界'); continue }
    selected.push(material); bytes += size
  }
  for (const id of formalIds) if (!selected.some(material => material.entityId === id)) limitations.push('正式关联材料在当前工作区缺失或不可用')
  if (!selected.some(material => material.entityId === targetId)) limitations.push('目标材料在当前工作区缺失或不可用')
  return { targetId, coverage: limitations.length ? 'partial' : 'complete', materials: selected, limitations: [...new Set(limitations)] }
}
