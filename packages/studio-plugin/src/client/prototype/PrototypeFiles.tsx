import { useCallback, useEffect, useRef, useState } from 'react'
import type { StudioCommand, StudioReply } from '../../shared/studio.ts'
import type { PrototypeFileResult } from '../../shared/prototype.ts'
import css from './prototype.module.css'

type FileView = Extract<PrototypeFileResult, { kind: 'file' }>
type DirectoryView = Extract<PrototypeFileResult, { kind: 'directory' }>
type SearchView = Extract<PrototypeFileResult, { kind: 'search' }>
type DiffView = Extract<PrototypeFileResult, { kind: 'diff' }>
interface Buffer { file: FileView; content: string; savedContent: string }

/** Browse and edit the files of the selected, Host-registered task workspace. */
export function PrototypeFiles({ taskId, call, registerFlush, onNeedsAttention }: {
  taskId: string
  call(command: StudioCommand): Promise<StudioReply | undefined>
  registerFlush(flush?: () => Promise<boolean>): void
  onNeedsAttention(): void
}) {
  const [directory, setDirectory] = useState('')
  const [listing, setListing] = useState<DirectoryView>()
  const [search, setSearch] = useState('')
  const [matches, setMatches] = useState<SearchView>()
  const [diff, setDiff] = useState<DiffView>()
  const [diffPath, setDiffPath] = useState<string>()
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({})
  const buffersRef = useRef(buffers); buffersRef.current = buffers
  const [selected, setSelected] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const saves = useRef(new Map<string, { fingerprint: string; id: string }>())
  const bufferWrites = useRef<Promise<void>>(Promise.resolve())
  const bufferErrors = useRef(new Set<string>())
  const pendingBuffers = useRef(new Map<string, Buffer>())
  const bufferTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const request = useRef(0)

  const list = useCallback(async (path: string, cursor?: string) => {
    const sequence = ++request.current
    const reply = await call({ action: 'listPrototypeDirectory', prototypeTaskId: taskId, directory: path, ...(cursor ? { cursor } : {}) })
    if (sequence !== request.current) return
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'directory') { setError(reply && !reply.ok ? reply.message : '无法读取目录'); return }
    const next = reply.prototypeFiles
    setListing(previous => cursor && previous?.observation === next.observation ? { ...next, entries: [...previous.entries, ...next.entries] } : next)
    setDirectory(path); setMatches(undefined); setDiff(undefined); setDiffPath(undefined); setError('')
  }, [call, taskId])
  useEffect(() => { void list(''); return () => { request.current += 1 } }, [list])

  const open = async (path: string) => {
    setSelected(path); setDiffPath(undefined); setEditing(false); setError('')
    if (buffersRef.current[path]) return
    const reply = await call({ action: 'readPrototypeFile', prototypeTaskId: taskId, path })
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'file') { setError(reply && !reply.ok ? reply.message : '无法读取文件'); return }
    const file = reply.prototypeFiles
    const stored = await call({ action: 'readPrototypeBuffer', prototypeTaskId: taskId, path })
    if (!stored?.ok) { setError(stored && !stored.ok ? stored.message : '无法读取已保存的编辑缓冲'); return }
    const draft = stored.prototypeBuffer
    if (draft && draft.baseHash !== file.hash) setError('磁盘文件在上次编辑后发生变化；已恢复编辑内容，保存时会核对原始版本。')
    const buffer: Buffer = draft ? { file: { ...file, hash: draft.baseHash }, content: draft.content, savedContent: draft.baseContent } : { file, content: file.content ?? '', savedContent: file.content ?? '' }
    setBuffers(previous => previous[path] ? previous : { ...previous, [path]: buffer })
  }

  const queueBuffer = (path: string) => {
    const timer = bufferTimers.current.get(path)
    if (timer) clearTimeout(timer)
    bufferTimers.current.delete(path)
    const buffer = pendingBuffers.current.get(path)
    if (!buffer) return
    pendingBuffers.current.delete(path)
    const record = { prototypeTaskId: taskId, path: buffer.file.path, baseHash: buffer.file.hash, baseContent: buffer.savedContent, content: buffer.content }
    bufferWrites.current = bufferWrites.current.then(async () => {
      const reply = await call({ action: 'savePrototypeBuffer', operationId: crypto.randomUUID(), buffer: record })
      if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.message : '编辑缓冲保存失败')
      bufferErrors.current.delete(record.path)
    }).catch(error => { bufferErrors.current.add(record.path); setError(error instanceof Error ? error.message : '编辑缓冲保存失败') })
  }
  const persistBuffer = (buffer: Buffer) => {
    const path = buffer.file.path
    pendingBuffers.current.set(path, buffer)
    const previous = bufferTimers.current.get(path)
    if (previous) clearTimeout(previous)
    bufferTimers.current.set(path, setTimeout(() => queueBuffer(path), 300))
  }
  const flushBuffers = async () => {
    for (const path of [...pendingBuffers.current.keys()]) queueBuffer(path)
    await bufferWrites.current
  }

  const save = useCallback(async (path: string): Promise<boolean> => {
    const buffer = buffersRef.current[path]
    if (!buffer || buffer.content === buffer.savedContent) return true
    await flushBuffers()
    const content = buffer.content
    const fingerprint = JSON.stringify([buffer.file.hash, content])
    let operation = saves.current.get(path)
    if (!operation || operation.fingerprint !== fingerprint) { operation = { fingerprint, id: crypto.randomUUID() }; saves.current.set(path, operation) }
    const reply = await call({ action: 'savePrototypeFile', prototypeTaskId: taskId, path, expectedHash: buffer.file.hash, content, operationId: operation.id })
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'saved') {
      setError(reply && !reply.ok ? `${reply.message}；编辑内容仍保留在当前缓冲中。` : '保存结果未知；编辑内容仍保留在当前缓冲中。')
      return false
    }
    const hash = reply.prototypeFiles.hash
    saves.current.delete(path)
    await flushBuffers()
    const cleared = await call({ action: 'clearPrototypeBuffer', prototypeTaskId: taskId, path, expectedContent: content })
    const current = buffersRef.current[path]
    if (current) {
      const next = { ...current, file: { ...current.file, hash }, savedContent: content }
      buffersRef.current = { ...buffersRef.current, [path]: next }
      setBuffers(buffersRef.current)
      if (next.content !== content) persistBuffer(next)
    }
    setError(cleared?.ok ? '' : cleared && !cleared.ok ? cleared.message : '编辑缓冲清理失败')
    return true
  }, [call, taskId])
  useEffect(() => {
    registerFlush(async () => {
      await flushBuffers()
      if (bufferErrors.current.size) { onNeedsAttention(); return false }
      return true
    })
    return () => { for (const path of [...pendingBuffers.current.keys()]) queueBuffer(path); registerFlush(undefined) }
  }, [registerFlush, save, onNeedsAttention])

  const submitSearch = async () => {
    if (!search.trim()) { await list(directory); return }
    const reply = await call({ action: 'searchPrototypeFiles', prototypeTaskId: taskId, query: search.trim(), directory })
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'search') { setError(reply && !reply.ok ? reply.message : '无法搜索工程'); return }
    setMatches(reply.prototypeFiles); setDiff(undefined); setDiffPath(undefined); setError('')
  }
  const loadDiff = async (cursor?: string) => {
    const reply = await call({ action: 'readPrototypeDiff', prototypeTaskId: taskId, ...(cursor ? { cursor } : {}) })
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'diff') { setError(reply && !reply.ok ? reply.message : '无法读取工程差异'); return }
    const next = reply.prototypeFiles
    setDiff(previous => cursor && previous?.observation === next.observation ? { ...next, files: [...previous.files, ...next.files] } : next)
    if (!cursor) { setSelected(undefined); setDiffPath(undefined) }
    setMatches(undefined); setError('')
  }
  const current = selected ? buffers[selected] : undefined
  const selectedDiff = diff?.files.find(file => file.path === diffPath)
  return <div className={css.files}>
    <aside className={css.fileSidebar} aria-label="工程文件">
      <form className={css.fileSearch} onSubmit={event => { event.preventDefault(); void submitSearch() }}>
        <input aria-label="搜索工程文件内容" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索文件内容" maxLength={200} /><button>搜索</button>
      </form>
      <div className={css.directoryHead}><span>{diff ? '工程变更' : directory || '工程文件'}</span>{diff ? <button onClick={() => void list('')}>文件</button> : <button onClick={() => void loadDiff()}>变更</button>}{!diff && directory && <button onClick={() => void list(directory.split('/').slice(0, -1).join('/'))}>上一级</button>}</div>
      <div className={css.fileList}>
        {diff ? <>{diff.files.map(file => <button key={file.path} onClick={() => setDiffPath(file.path)}><span>{file.path}</span><small>{file.status === 'added' ? '新增' : file.status === 'deleted' ? '删除' : '修改'}</small></button>)}{diff.nextCursor && <button onClick={() => void loadDiff(diff.nextCursor)}>加载更多</button>}{diff.truncated && <p>部分文件或内容已截断。</p>}{!diff.truncated && !diff.files.length && <p>当前磁盘工程没有变更。</p>}</> : matches ? <>{matches.matches.map((match, index) => <button key={`${match.path}:${match.line}:${match.column}:${index}`} onClick={() => void open(match.path)}><strong>{match.path}:{match.line}</strong><small>{match.excerpt}</small></button>)}{matches.truncated && <p>结果已截断，请缩小搜索范围。</p>}{!matches.truncated && !matches.matches.length && <p>没有找到匹配内容。</p>}</> : <>{listing?.entries.map(entry => <button key={entry.path} onClick={() => entry.kind === 'directory' ? void list(entry.path) : void open(entry.path)}><span>{entry.kind === 'directory' ? '▸ ' : ''}{entry.name}</span>{entry.readOnly && <small>只读</small>}</button>)}{listing?.nextCursor && <button onClick={() => void list(directory, listing.nextCursor)}>加载更多</button>}{listing?.truncated && !listing.nextCursor && <p>目录结果已截断。</p>}{listing && !listing.truncated && !listing.entries.length && <p>目录为空。</p>}</>}
      </div>
    </aside>
    <section className={css.fileContent} aria-label="文件内容">
      {error && <div className={css.fileError} role="alert">{error}</div>}
      {selectedDiff ? <><header className={css.fileHeader}><strong>{selectedDiff.path}</strong><span>起始版本与当前磁盘内容</span>{selectedDiff.status !== 'deleted' && <button onClick={() => void open(selectedDiff.path)}>打开文件</button>}</header>{selectedDiff.binary ? <p className={css.empty}>二进制文件不显示正文。</p> : <div className={css.diffContent}><div><small>起始版本</small><pre>{selectedDiff.baseContent ?? (selectedDiff.status === 'added' ? '新文件' : '内容不可用')}</pre></div><div><small>当前磁盘</small><pre>{selectedDiff.currentContent ?? (selectedDiff.status === 'deleted' ? '文件已删除' : '内容不可用')}</pre></div></div>}{selectedDiff.truncated && <p className={css.muted}>部分内容超过显示限制或不可读取。</p>}</> : diff && !selected ? <p className={css.empty}>选择一项变更，查看两侧磁盘内容。</p> : current ? <><header className={css.fileHeader}><strong>{current.file.path}</strong><span>{current.content !== current.savedContent ? '未保存' : current.file.readOnly ? '只读' : '已保存'}</span>{!current.file.readOnly && current.file.content !== undefined && !current.file.truncated && <><button onClick={() => setEditing(value => !value)}>{editing ? '退出编辑' : '编辑'}</button><button disabled={working || current.content === current.savedContent} onClick={() => { setWorking(true); void save(current.file.path).finally(() => setWorking(false)) }}>保存</button></>}</header>
        {current.file.binary ? <p className={css.empty}>二进制文件不显示正文。</p> : current.file.content === undefined ? <p className={css.empty}>文件正文不可用。</p> : editing ? <textarea className={css.editor} aria-label={`${current.file.path} 文件内容`} spellCheck={false} value={current.content} onChange={event => { const content = event.target.value, next = { ...current, content }; buffersRef.current = { ...buffersRef.current, [current.file.path]: next }; setBuffers(buffersRef.current); persistBuffer(next) }} /> : <pre className={css.fileText}>{current.content}</pre>}
        {current.file.truncated && <p className={css.empty}>文件内容已截断，仅供查看。</p>}</> : <p className={css.empty}>{selected ? '正在读取文件…' : '选择文件查看内容。'}</p>}
    </section>
  </div>
}
