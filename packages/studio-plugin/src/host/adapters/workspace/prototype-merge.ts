import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PlatformRuntime, ProcessResult } from '../platform/runtime.ts'
import { withPathWriteLock } from '../platform/path-write-lock.ts'

interface FileEntry { path: string; mode: '100644' | '100755'; oid: string }
interface Tree { oid: string; files: FileEntry[] }
interface RunOptions { input?: string; env?: Record<string, string>; allowFailure?: boolean }
type LocalGit = (args: string[], options?: RunOptions) => Promise<ProcessResult>

export type PrototypeMergeResult =
  | { status: 'merged'; candidateSha: string; mergeBaseSha: string; changedPaths: string[]; retainedDirectory: string }
  | { status: 'conflicted'; mergeBaseSha: string; conflictFiles: string[]; directory: string }

const shaPattern = /^[a-f0-9]{40}$/
const sha = (value: string): string => { if (!shaPattern.test(value)) throw new Error('原型合并对象身份无效'); return value }
const safePath = (value: string): string => {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.includes(':') || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('原型合并路径无效')
  return value
}
const MAX_FILES = 3000, MAX_FILE_BYTES = 2 * 1024 * 1024, MAX_BYTES = 64 * 1024 * 1024

function treeEntries(result: ProcessResult): FileEntry[] {
  if (!Buffer.from(result.stdout, 'utf8').equals(result.stdoutBytes)) throw new Error('原型文件路径不是有效 UTF-8')
  const entries = result.stdout.split('\0')
  if (entries.pop() !== '' || entries.length > MAX_FILES) throw new Error('原型合并文件列表不完整或超过限制')
  return entries.map(entry => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry)
    if (!match) throw new Error('原型合并只允许普通文件')
    return { mode: match[1] as FileEntry['mode'], oid: sha(match[2]!), path: safePath(match[3]!) }
  })
}

function conflictOutput(bytes: Buffer): { conflictTree: string; files: string[]; hash: string } {
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw new Error('原型冲突输出不是有效 UTF-8')
  const entries = bytes.toString('utf8').split('\0'), conflictTree = sha(entries.shift() ?? '')
  if (entries.pop() !== '') throw new Error('原型冲突输出不完整')
  const files = new Set<string>()
  for (const entry of entries) {
    const match = /^(?:100644|100755) [a-f0-9]{40} [123][ \t]([\s\S]+)$/.exec(entry)
    if (match) files.add(safePath(match[1]!))
  }
  if (!files.size) throw new Error('原型冲突输出没有涉及文件')
  return { conflictTree, files: [...files].sort(), hash: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * Reconstructs only the fixed prototype subtrees in a fresh bare object database.
 * The synthetic database never reads project configuration or custom merge drivers.
 */
export async function mergePrototype(input: {
  runtime: PlatformRuntime; local: LocalGit; operationRoot: string; operationId: string
  sourceBaseHead: string; sourceSha: string; expectedHead: string
  writeScope: readonly string[]; identity: { name: string; email: string }
}): Promise<PrototypeMergeResult> {
  const { runtime, local } = input
  if (runtime.manifest.tools.git.version !== '2.56.0.windows.2') throw new Error('原型合并需要随包固定的 Git 2.56.0.windows.2')
  const source = sha(input.sourceSha), expected = sha(input.expectedHead), sourceBase = sha(input.sourceBaseHead)
  if (expected === sourceBase) throw new Error('认可头未变化，请直接使用确认的来源')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.operationId)) throw new Error('原型合并操作身份无效')
  if (!input.identity.name.trim() || !input.identity.email.includes('@') || /[\r\n\0]/.test(input.identity.name + input.identity.email)) throw new Error('Git 提交身份无效')
  const scopes = input.writeScope.map(value => value.endsWith('/') ? `${safePath(value.slice(0, -1))}/` : safePath(value))
  if (!scopes.length) throw new Error('事项没有可写原型范围')
  const allows = (value: string): boolean => value.startsWith('原型代码/') && scopes.some(scope => {
    const relative = value.slice('原型代码/'.length)
    return scope.endsWith('/') ? relative.startsWith(scope) : relative === scope
  })
  const parents = (await local(['rev-list', '--parents', '-n', '1', source])).stdout.trim().split(/\s+/)
  if (parents.length !== 2 || parents[0] !== source || parents[1] !== sourceBase) throw new Error('确认的原型来源与登记基头不一致')
  const mergeBases = (await local(['merge-base', '--all', expected, source])).stdout.trim().split(/\s+/).filter(Boolean)
  if (mergeBases.length !== 1) throw new Error('原型合并无法确定唯一共同祖先，已保留原来源')
  const base = sha(mergeBases[0]!)
  const changes = async (left: string, right: string) => {
    const result = (await local(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', left, right, '--'])).stdout
    const entries = result.split('\0'); if (entries.pop() !== '') throw new Error('原型合并路径结果不完整')
    return entries.map(safePath)
  }
  const sourceChanges = await changes(sourceBase, source)
  if (!sourceChanges.length || sourceChanges.some(value => !allows(value))) throw new Error('原型来源包含未授权变更或没有代码变化')
  if ((await changes(base, source)).some(value => !value.startsWith('原型代码/'))) throw new Error('原型来源相对共同祖先包含其他项目内容，不能自动合并')

  await mkdir(input.operationRoot, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(path.join(input.operationRoot, 'prototype-merge-'))
  const objects = path.join(directory, 'repository'), blobDirectory = path.join(directory, 'blobs')
  await mkdir(objects, { mode: 0o700 }); await mkdir(blobDirectory, { mode: 0o700 })
  const attributesFile = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const run = async (args: string[], options: RunOptions = {}): Promise<ProcessResult> => {
    const process = await runtime.start('git', ['--no-replace-objects', '-c', `core.attributesFile=${attributesFile}`, '-c', `core.hooksPath=${attributesFile}`, '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'core.autocrlf=false', ...args], {
      cwd: objects, timeoutMs: 120_000, maxOutputBytes: 8 * 1024 * 1024,
      env: { GIT_ATTR_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Studio', GIT_AUTHOR_EMAIL: 'studio@localhost', GIT_COMMITTER_NAME: 'Studio', GIT_COMMITTER_EMAIL: 'studio@localhost', ...options.env },
      ...(options.input === undefined ? {} : { input: options.input }),
    })
    const result = await process.done
    if (result.exitCode !== 0 && !options.allowFailure) throw new Error(`原型隔离 Git 执行失败（退出码 ${result.exitCode}）`)
    return result
  }
  try {
    if ((await run(['--version'])).stdout.trim() !== 'git version 2.56.0.windows.2') throw new Error('原型合并 Git 版本与固定工具链不一致')
    await run(['init', '--bare', '--quiet'])
    let bytes = 0, objectsRead = 0
    const copied = new Set<string>()
    const blobFile = (oid: string) => path.join(blobDirectory, oid)
    const copyBlob = async (oid: string, from: LocalGit | typeof run): Promise<void> => {
      if (copied.has(oid)) return
      if (++objectsRead > MAX_FILES * 3) throw new Error('原型合并对象数量超过限制')
      const result = await from(['cat-file', 'blob', oid])
      const data = result.stdoutBytes
      bytes += data.length
      if (data.length > MAX_FILE_BYTES || bytes > MAX_BYTES) throw new Error('原型合并对象字节超过限制')
      if (createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') !== oid) throw new Error('原型合并对象内容与身份不一致')
      await writeFile(blobFile(oid), data, { flag: 'wx', mode: 0o600 })
      copied.add(oid)
    }
    const list = async (git: LocalGit | typeof run, tree: string): Promise<FileEntry[]> => treeEntries(await git(['ls-tree', '-r', '-z', tree]))
    const materialize = async (git: LocalGit | typeof run, files: FileEntry[]): Promise<string> => {
      const directories = new Set([''])
      for (const entry of files) {
        const parts = entry.path.split('/')
        for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
      }
      const built = new Map<string, string>()
      const depth = (value: string): number => value ? value.split('/').length : 0
      for (const directory of [...directories].sort((a, b) => depth(b) - depth(a))) {
        const prefix = directory ? `${directory}/` : ''
        const children = new Map<string, { mode: string; type: 'blob' | 'tree'; oid: string }>()
        for (const file of files) {
          if (!file.path.startsWith(prefix)) continue
          const rest = file.path.slice(prefix.length), slash = rest.indexOf('/')
          if (slash < 0) children.set(rest, { mode: file.mode, type: 'blob', oid: file.oid })
          else {
            const name = rest.slice(0, slash), child = `${prefix}${name}`, oid = built.get(child)
            if (!oid) throw new Error('原型合并目录对象缺失')
            children.set(name, { mode: '040000', type: 'tree', oid })
          }
        }
        const records = [...children].map(([name, item]) => `${item.mode} ${item.type} ${item.oid}\t${name}\0`).join('')
        built.set(directory, sha((await git(['mktree', '-z'], { input: records })).stdout.trim()))
      }
      return built.get('')!
    }
    const reconstruct = async (commit: string): Promise<Tree> => {
      const oid = sha((await local(['rev-parse', `${commit}:原型代码`])).stdout.trim())
      const files = await list(local, oid)
      for (const file of files) {
        await copyBlob(file.oid, local)
        const created = sha((await run(['hash-object', '-w', '--no-filters', '--', blobFile(file.oid)])).stdout.trim())
        if (created !== file.oid) throw new Error('原型合并源对象重建失败')
      }
      const rebuilt = await materialize(run, files)
      if (rebuilt !== oid) throw new Error('原型合并源树重建失败')
      return { oid, files }
    }
    const baseTree = await reconstruct(base), headTree = await reconstruct(expected), sourceTree = await reconstruct(source)
    const commit = async (tree: string, parent?: string) => sha((await run(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Studio synthetic prototype merge'])).stdout.trim())
    const ancestor = await commit(baseTree.oid)
    const syntheticHead = await commit(headTree.oid, ancestor), syntheticSource = await commit(sourceTree.oid, ancestor)
    const merged = await run(['merge-tree', '--write-tree', '-z', syntheticHead, syntheticSource], { allowFailure: true })
    if (merged.exitCode === 1) {
      const conflict = conflictOutput(merged.stdoutBytes)
      if (conflict.files.some(value => !allows(`原型代码/${value}`))) throw new Error('原型冲突涉及事项可写范围外的文件，隔离现场已保留')
      await run(['update-ref', 'refs/studio/conflict/head', syntheticHead])
      await run(['update-ref', 'refs/studio/conflict/source', syntheticSource])
      await run(['update-ref', 'refs/studio/conflict/result', conflict.conflictTree])
      await writeFile(path.join(directory, 'conflict-output.bin'), merged.stdoutBytes, { flag: 'wx', mode: 0o600 })
      await writeFile(path.join(directory, 'identity.json'), JSON.stringify({ operationId: input.operationId, sourceSha: source, sourceBaseHead: sourceBase, expectedHead: expected, mergeBaseSha: base, syntheticHead, syntheticSource, conflictTree: conflict.conflictTree, conflictFiles: conflict.files, conflictOutputSha256: conflict.hash }), { flag: 'wx', mode: 0o600 })
      return { status: 'conflicted', mergeBaseSha: base, conflictFiles: conflict.files, directory }
    }
    if (merged.exitCode !== 0) throw new Error(`原型隔离合并失败（退出码 ${merged.exitCode}）`)
    const output = merged.stdout.split('\0')
    if (output.length !== 2 || output[1] !== '') throw new Error('原型合并结果格式无效')
    const mergedTree = sha(output[0]!)
    const mergedFiles = await list(run, mergedTree)
    for (const file of mergedFiles) {
      await copyBlob(file.oid, run)
      const written = sha((await local(['hash-object', '-w', '--no-filters', '--', blobFile(file.oid)])).stdout.trim())
      if (written !== file.oid) throw new Error('原型候选对象写入失败')
    }
    if (await materialize(local, mergedFiles) !== mergedTree) throw new Error('原型候选子树写入不一致')
    const index = path.join(directory, 'candidate-index'), env = { GIT_INDEX_FILE: index }
    await local(['read-tree', expected], { env })
    await local(['rm', '-r', '--cached', '--force', '--ignore-unmatch', '--', '原型代码'], { env })
    await local(['read-tree', `--prefix=原型代码/`, mergedTree], { env })
    const candidateTree = sha((await local(['write-tree'], { env })).stdout.trim())
    const ref = `refs/eadp/archive/prototype-candidate/${input.operationId}/${expected}`
    const existing = await local(['rev-parse', '--verify', ref], { allowFailure: true })
    let candidate: string
    if (existing.exitCode === 0) {
      candidate = sha(existing.stdout.trim())
    } else {
      candidate = sha((await local(['-c', `user.name=${input.identity.name}`, '-c', `user.email=${input.identity.email}`, 'commit-tree', candidateTree, '-p', expected, '-p', source, '-m', `合并原型 ${input.operationId}`])).stdout.trim())
      await local(['update-ref', ref, candidate, '0000000000000000000000000000000000000000'])
    }
    const candidateParents = (await local(['rev-list', '--parents', '-n', '1', candidate])).stdout.trim().split(/\s+/)
    const actualTree = sha((await local(['rev-parse', `${candidate}^{tree}`])).stdout.trim())
    if (candidateParents.length !== 3 || candidateParents[0] !== candidate || candidateParents[1] !== expected || candidateParents[2] !== source || actualTree !== candidateTree) throw new Error('原合并操作与固定父关系或候选树不一致，现场已保留')
    const changedPaths = await changes(expected, candidate)
    if (!changedPaths.length || changedPaths.some(value => !allows(value) || !sourceChanges.includes(value))) throw new Error('合并候选没有代码变化或超出作者确认范围')
    // Other processes can write into an operation directory while Git is running.
    // We cannot prove every entry still belongs to this operation, so do not
    // recursively delete it after success; retain its identity for later inspection.
    await writeFile(path.join(directory, 'identity.json'), JSON.stringify({ status: 'merged', sourceSha: source, sourceBaseHead: sourceBase, expectedHead: expected, mergeBaseSha: base, candidateSha: candidate, changedPaths }), { flag: 'wx', mode: 0o600 })
    return { status: 'merged', candidateSha: candidate, mergeBaseSha: base, changedPaths, retainedDirectory: directory }
  } catch (error) {
    throw new Error(`原型合并未完成，隔离现场已保留：${directory}`, { cause: error })
  }
}

interface WorkingFile { bytes: Buffer; mode: '100644' | '100755' }
export type PrototypeConflictObservation = { kind: 'missing' } | { kind: 'file'; sha256: string; mode: '100644' | '100755' }
export interface PrototypeConflictWritebackFile { path: string; before: PrototypeConflictObservation; temporary: string; status: 'pending' | 'written' }
export interface PrototypeConflictWriteback { files: PrototypeConflictWritebackFile[] }

/** Materialize only the retained conflict result in the original prototype worktree. */
export async function restorePrototypeConflict(input: {
  runtime: PlatformRuntime; local: LocalGit; root: string; directory: string; operationId: string
  sourceBaseHead: string; sourceSha: string; expectedHead: string; mergeBaseSha: string; writeScope: readonly string[]
  writeback?: PrototypeConflictWriteback
  onPlan(writeback: PrototypeConflictWriteback): Promise<void>
  onPathRestored(path: string): Promise<void>
}): Promise<{ conflictFiles: string[]; writeback: PrototypeConflictWriteback }> {
  const { runtime, local } = input
  if (runtime.manifest.tools.git.version !== '2.56.0.windows.2') throw new Error('原型冲突恢复需要随包固定的 Git 2.56.0.windows.2')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.operationId)) throw new Error('原型冲突操作身份无效')
  const source = sha(input.sourceSha), expected = sha(input.expectedHead), sourceBase = sha(input.sourceBaseHead), mergeBase = sha(input.mergeBaseSha)
  const scopes = input.writeScope.map(value => value.endsWith('/') ? `${safePath(value.slice(0, -1))}/` : safePath(value))
  if (!scopes.length) throw new Error('事项没有可写原型范围')
  const allows = (value: string): boolean => scopes.some(scope => scope.endsWith('/') ? value.startsWith(scope) : value === scope)
  const sourceRef = `refs/eadp/archive/prototype-source/${input.operationId}`
  if (sha((await local(['rev-parse', '--verify', sourceRef])).stdout.trim()) !== source) throw new Error('原冲突来源引用已变化')
  const parents = (await local(['rev-list', '--parents', '-n', '1', source])).stdout.trim().split(/\s+/)
  if (parents.length !== 2 || parents[0] !== source || parents[1] !== sourceBase) throw new Error('原冲突来源与登记基头不一致')
  const mergeBases = (await local(['merge-base', '--all', expected, source])).stdout.trim().split(/\s+/).filter(Boolean)
  if (mergeBases.length !== 1 || mergeBases[0] !== mergeBase) throw new Error('原冲突共同祖先已无法核对')
  const sourceChanges = (await local(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', sourceBase, source, '--'])).stdout.split('\0').filter(Boolean).map(safePath)
  if (!sourceChanges.length || sourceChanges.some(value => !value.startsWith('原型代码/') || !allows(value.slice('原型代码/'.length)))) throw new Error('原冲突来源包含未授权变更')

  const sceneInfo = await lstat(input.directory)
  if (sceneInfo.isSymbolicLink() || !sceneInfo.isDirectory()) throw new Error('原型冲突隔离目录无效')
  const scene = await realpath(input.directory), objects = path.join(scene, 'repository')
  const objectInfo = await lstat(objects)
  if (objectInfo.isSymbolicLink() || !objectInfo.isDirectory()) throw new Error('原型冲突对象库无效')
  const identityBytes = await readFile(path.join(scene, 'identity.json'))
  if (identityBytes.length > 64 * 1024) throw new Error('原型冲突身份记录超过限制')
  const identity = JSON.parse(identityBytes.toString('utf8')) as Record<string, unknown>
  if (identity.operationId !== input.operationId || identity.sourceSha !== source || identity.sourceBaseHead !== sourceBase || identity.expectedHead !== expected || identity.mergeBaseSha !== mergeBase) throw new Error('原型冲突身份与原操作不一致')
  const output = conflictOutput(await readFile(path.join(scene, 'conflict-output.bin')))
  if (identity.conflictTree !== output.conflictTree || identity.conflictOutputSha256 !== output.hash || JSON.stringify(identity.conflictFiles) !== JSON.stringify(output.files)) throw new Error('原型冲突输出与身份记录不一致')
  if (output.files.some(value => !allows(value))) throw new Error('原型冲突涉及事项可写范围外的文件')

  const attributesFile = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const run = async (args: string[]): Promise<ProcessResult> => {
    const process = await runtime.start('git', ['--no-replace-objects', '-c', `core.attributesFile=${attributesFile}`, '-c', `core.hooksPath=${attributesFile}`, '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'core.autocrlf=false', ...args], {
      cwd: objects, timeoutMs: 120_000, maxOutputBytes: 8 * 1024 * 1024, env: { GIT_ATTR_NOSYSTEM: '1' },
    })
    const result = await process.done
    if (result.exitCode !== 0) throw new Error(`原型冲突恢复 Git 执行失败（退出码 ${result.exitCode}）`)
    return result
  }
  if ((await run(['--version'])).stdout.trim() !== 'git version 2.56.0.windows.2') throw new Error('原型冲突恢复 Git 版本与固定工具链不一致')
  const reference = async (name: 'head' | 'source' | 'result'): Promise<string> => sha((await run(['rev-parse', '--verify', `refs/studio/conflict/${name}`])).stdout.trim())
  if (await reference('head') !== identity.syntheticHead || await reference('source') !== identity.syntheticSource || await reference('result') !== output.conflictTree) throw new Error('原型冲突引用与身份记录不一致')
  const headTree = sha((await run(['rev-parse', 'refs/studio/conflict/head^{tree}'])).stdout.trim()), sourceTree = sha((await run(['rev-parse', 'refs/studio/conflict/source^{tree}'])).stdout.trim())
  if (headTree !== sha((await local(['rev-parse', `${expected}:原型代码`])).stdout.trim()) || sourceTree !== sha((await local(['rev-parse', `${source}:原型代码`])).stdout.trim())) throw new Error('原型冲突树与原 Git 来源不一致')

  const files = new Map<string, FileEntry & { bytes: Buffer }>()
  let total = 0
  for (const entry of treeEntries(await run(['ls-tree', '-r', '-z', output.conflictTree]))) {
    const result = await run(['cat-file', 'blob', entry.oid])
    total += result.stdoutBytes.length
    if (result.stdoutBytes.length > MAX_FILE_BYTES || total > MAX_BYTES || createHash('sha1').update(`blob ${result.stdoutBytes.length}\0`).update(result.stdoutBytes).digest('hex') !== entry.oid) throw new Error('原型冲突对象内容或大小无效')
    files.set(entry.path, { ...entry, bytes: result.stdoutBytes })
  }
  const managed = new Set<string>(files.keys())
  for (const tree of [headTree, sourceTree]) for (const entry of treeEntries(await run(['ls-tree', '-r', '-z', tree]))) managed.add(entry.path)

  const checkout = await realpath(input.root), prototype = path.join(checkout, '原型代码'), prototypeInfo = await lstat(prototype)
  if (prototypeInfo.isSymbolicLink() || !prototypeInfo.isDirectory() || await realpath(prototype) !== prototype) throw new Error('原型代码工作区无效')
  const observe = async (relative: string): Promise<WorkingFile | undefined> => {
    let parent = prototype
    const parts = safePath(relative).split('/')
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part)
      const info = await lstat(parent).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
      if (!info) return undefined
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('原型代码目录不能是符号链接或普通文件')
    }
    const target = path.join(parent, parts.at(-1)!), info = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (!info) return undefined
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('原型代码写回只允许普通文件')
    if (info.size > MAX_FILE_BYTES) throw new Error('原型代码工作区文件超过恢复限制')
    const bytes = await readFile(target)
    return { bytes, mode: process.platform !== 'win32' && info.mode & 0o111 ? '100755' : '100644' }
  }
  const normalizedMode = (mode: '100644' | '100755'): '100644' | '100755' => process.platform === 'win32' ? '100644' : mode
  const same = (actual: WorkingFile | undefined, desired: FileEntry & { bytes: Buffer }): boolean => !!actual && normalizedMode(actual.mode) === normalizedMode(desired.mode) && actual.bytes.equals(desired.bytes)
  const matchesDesired = (actual: WorkingFile | undefined, desired: (FileEntry & { bytes: Buffer }) | undefined): boolean => desired ? same(actual, desired) : actual === undefined
  const observation = (actual: WorkingFile | undefined): PrototypeConflictObservation => actual ? { kind: 'file', sha256: createHash('sha256').update(actual.bytes).digest('hex'), mode: normalizedMode(actual.mode) } : { kind: 'missing' }
  const sameObservation = (left: PrototypeConflictObservation, right: PrototypeConflictObservation): boolean => {
    if (left.kind !== right.kind) return false
    if (left.kind === 'missing' || right.kind === 'missing') return true
    return left.sha256 === right.sha256 && left.mode === right.mode
  }
  const validObservation = (value: unknown): value is PrototypeConflictObservation => {
    if (!value || typeof value !== 'object') return false
    const item = value as Partial<PrototypeConflictObservation>
    return item.kind === 'missing' || item.kind === 'file' && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) && (item.mode === '100644' || item.mode === '100755')
  }
  const temporaryName = (relative: string): string => `.eadp-conflict-${input.operationId}-${createHash('sha256').update(relative).digest('hex').slice(0, 16)}-${randomUUID()}.tmp`
  const paths = [...managed].sort(), observed = new Map<string, WorkingFile | undefined>()
  for (const relative of paths) observed.set(relative, await observe(relative))
  const required = paths.filter(relative => !matchesDesired(observed.get(relative), files.get(relative)))
  if (required.some(relative => !allows(relative))) throw new Error('冲突写回需要修改事项可写范围外的原型文件，现场已保留')
  const writeback = input.writeback ? structuredClone(input.writeback) : { files: required.map(relative => ({ path: relative, before: observation(observed.get(relative)), temporary: temporaryName(relative), status: 'pending' as const })) }
  if (!Array.isArray(writeback.files) || writeback.files.length > MAX_FILES) throw new Error('原型冲突恢复记录无效')
  const planned = new Set<string>()
  for (const entry of writeback.files) {
    if (planned.has(entry.path) || !managed.has(entry.path) || !allows(entry.path) || !validObservation(entry.before) || !['pending', 'written'].includes(entry.status) ||
      !entry.temporary.startsWith(`.eadp-conflict-${input.operationId}-`) || !entry.temporary.endsWith('.tmp') || path.basename(entry.temporary) !== entry.temporary) throw new Error('原型冲突恢复记录与原现场不一致')
    planned.add(entry.path)
    const actual = observed.get(entry.path)
    if (!sameObservation(observation(actual), entry.before) && !matchesDesired(actual, files.get(entry.path))) throw new Error(`冲突写回路径出现外部新改动，已停止：${entry.path}`)
  }
  for (const relative of paths) if (!planned.has(relative) && !matchesDesired(observed.get(relative), files.get(relative))) throw new Error(`冲突写回后出现外部新改动，已停止：${relative}`)
  const temporaryPath = (entry: PrototypeConflictWritebackFile): string => path.join(prototype, ...path.dirname(entry.path).split('/'), entry.temporary)
  if (!input.writeback) {
    for (const entry of writeback.files) {
      const existing = await lstat(temporaryPath(entry)).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })
      if (existing) throw new Error('本操作临时文件路径已被占用，现场已保留')
    }
    await input.onPlan(structuredClone(writeback))
  }

  for (const entry of writeback.files) {
    const relative = entry.path, target = path.join(prototype, ...relative.split('/')), desired = files.get(relative), temporary = temporaryPath(entry)
    await withPathWriteLock(target, async () => {
      const actual = await observe(relative)
      if (!sameObservation(observation(actual), entry.before) && !matchesDesired(actual, desired)) throw new Error(`冲突写回路径出现外部新改动，已停止：${relative}`)
      const temporaryInfo = await lstat(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
      if (temporaryInfo) {
        if (!input.writeback || temporaryInfo.isSymbolicLink() || !temporaryInfo.isFile()) throw new Error('本操作临时文件无法安全核对，现场已保留')
        await unlink(temporary)
      }
      if (matchesDesired(actual, desired)) {
        if (entry.status !== 'written') { entry.status = 'written'; await input.onPathRestored(relative) }
        return
      }
      if (!desired) await unlink(target)
      else {
        let parent = prototype
        for (const part of relative.split('/').slice(0, -1)) {
          parent = path.join(parent, part)
          await mkdir(parent, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
          const info = await lstat(parent)
          if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('原型代码目录在写回期间已变化')
        }
        const file = await open(temporary, 'wx', desired.mode === '100755' ? 0o700 : 0o600)
        try { await file.writeFile(desired.bytes); await file.sync() } finally { await file.close() }
        try { await rename(temporary, target) } finally { await rm(temporary, { force: true }) }
      }
      if (!matchesDesired(await observe(relative), desired)) throw new Error('原型冲突文件写回结果不一致')
      entry.status = 'written'; await input.onPathRestored(relative)
    })
  }
  for (const relative of paths) if (!matchesDesired(await observe(relative), files.get(relative))) throw new Error('原型冲突写回尚未收敛，请按原操作重试')
  for (const entry of writeback.files) {
    const temporary = await lstat(temporaryPath(entry)).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })
    if (temporary) throw new Error('本操作临时产物尚未清理，不能完成冲突恢复')
  }
  return { conflictFiles: output.files, writeback }
}
