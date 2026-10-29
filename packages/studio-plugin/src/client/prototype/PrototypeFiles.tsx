import { useCallback, useEffect, useRef, useState } from 'react'
import type { StudioCommand, StudioReply } from '../../shared/studio.ts'
import type { PrototypeFileResult, PrototypeFileSource } from '../../shared/prototype.ts'
import { PrototypeComparison, PrototypeEditor } from './PrototypeEditor.tsx'
import css from './prototype.module.css'
import { PrototypeDirectoryTree } from './PrototypeDirectoryTree.tsx'
import filesCss from './files.module.css'

type FileView = Extract<PrototypeFileResult, { kind: 'file' }>
type DirectoryView = Extract<PrototypeFileResult, { kind: 'directory' }>
type SearchView = Extract<PrototypeFileResult, { kind: 'search' }>
type DiffView = Extract<PrototypeFileResult, { kind: 'diff' }>
interface Buffer { file: FileView; content: string; savedContent: string }

interface PrototypeFilesProps {
  source: PrototypeFileSource
  requestDiff?: number
  call(command: StudioCommand): Promise<StudioReply | undefined>
  registerFlush(flush?: () => Promise<boolean>): void
  onNeedsAttention(): void
}

/** Browse and edit the files of the selected, Host-registered task workspace. */
export function PrototypeFiles(props: PrototypeFilesProps) {
  return <PrototypeFilesForSource key={JSON.stringify(props.source)} {...props} />
}

function PrototypeFilesForSource({ source, call, registerFlush, onNeedsAttention, requestDiff }: PrototypeFilesProps) {
  const taskId = source.kind === 'task' ? source.prototypeTaskId : ''
  const sourceKey = JSON.stringify(source)
  const [directory, setDirectory] = useState('')
  const [listing, setListing] = useState<DirectoryView>()
  const [search, setSearch] = useState('')
  const [matches, setMatches] = useState<SearchView>()
  const [diff, setDiff] = useState<DiffView>()
  const [diffPath, setDiffPath] = useState<string>()
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({})
  const buffersRef = useRef(buffers); buffersRef.current = buffers
  const [ranges, setRanges] = useState<Record<string, FileView>>({})
  const [selected, setSelected] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [closed, setClosed] = useState<string[]>([])
  const [treeHidden, setTreeHidden] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState<{ path: string; disk: FileView }>()
  const [comparePath, setComparePath] = useState<string>()
  const [working, setWorking] = useState(false)
  const saves = useRef(new Map<string, { fingerprint: string; id: string }>())
  const bufferWrites = useRef<Promise<void>>(Promise.resolve())
  const bufferErrors = useRef(new Set<string>())
  const bufferUnsaved = useRef(new Set<string>())
  const pendingBuffers = useRef(new Map<string, Buffer>())
  const bufferTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const request = useRef(0)

  const list = useCallback(async (path: string, cursor?: string) => {
    const sequence = ++request.current
    const reply = await call({ action: 'listPrototypeDirectory', source, directory: path, ...(cursor ? { cursor } : {}) })
    if (sequence !== request.current) return
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'directory') { setError(reply && !reply.ok ? reply.message : '无法读取目录'); return }
    const next = reply.prototypeFiles
    setListing(previous => cursor && previous?.observation === next.observation ? { ...next, entries: [...previous.entries, ...next.entries] } : next)
    setDirectory(path); setMatches(undefined); setDiff(undefined); setDiffPath(undefined); setError('')
  }, [call, sourceKey])
  useEffect(() => { void list(''); return () => { request.current += 1 } }, [list])

  const open = async (path: string) => {
    setClosed(previous => previous.filter(item => item !== path)); setSelected(path); setDiffPath(undefined); setEditing(false); setError(''); setConflict(undefined); setComparePath(undefined)
    if (buffersRef.current[path]) return
    const reply = await call({ action: 'readPrototypeFile', source, path })
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'file') { setError(reply && !reply.ok ? reply.message : '无法读取文件'); return }
    const file = reply.prototypeFiles
    if (!taskId) { setBuffers(previous => previous[path] ? previous : { ...previous, [path]: { file, content: file.content ?? '', savedContent: file.content ?? '' } }); return }
    const stored = await call({ action: 'readPrototypeBuffer', prototypeTaskId: taskId, path })
    if (!stored?.ok) { setError(stored && !stored.ok ? stored.message : '无法读取已保存的编辑缓冲'); return }
    const draft = stored.prototypeBuffer
    if (draft && draft.baseHash !== file.hash) { setError('磁盘文件在上次编辑后发生变化；已恢复编辑内容，保存时会核对原始版本。'); setComparePath(path) }
    const buffer: Buffer = draft ? { file: { ...file, hash: draft.baseHash }, content: draft.content, savedContent: draft.baseContent } : { file, content: file.content ?? '', savedContent: file.content ?? '' }
    setBuffers(previous => previous[path] ? previous : { ...previous, [path]: buffer })
  }

  const openRange = async (path: string, start: number) => {
    const hasDraft = () => {
      const buffer = buffersRef.current[path]
      return !!buffer && buffer.content !== buffer.savedContent
    }
    if (hasDraft()) { setError('文件存在未保存的编辑缓冲，请先保存或保留当前缓冲。'); return }
    const reply = await call({ action: 'readPrototypeFile', source, path, lineRange: { start, end: start + 199 } })
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'file') { setError(reply && !reply.ok ? reply.message : '无法读取文件范围'); return }
    if (hasDraft()) { setError('读取期间出现未保存的编辑缓冲，已保留编辑内容。'); return }
    setRanges(previous => ({ ...previous, [path]: reply.prototypeFiles as FileView }))
    setError('')
  }

  const queueBuffer = (path: string) => {
    const timer = bufferTimers.current.get(path)
    if (timer) clearTimeout(timer)
    bufferTimers.current.delete(path)
    const buffer = pendingBuffers.current.get(path)
    if (!buffer || !buffer.file.hash) return
    pendingBuffers.current.delete(path)
    const record = { prototypeTaskId: taskId, path: buffer.file.path, baseHash: buffer.file.hash, baseContent: buffer.savedContent, content: buffer.content }
    bufferWrites.current = bufferWrites.current.then(async () => {
      const reply = await call({ action: 'savePrototypeBuffer', operationId: crypto.randomUUID(), buffer: record })
      if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.message : '编辑缓冲保存失败')
      bufferErrors.current.delete(record.path)
      const current = buffersRef.current[record.path]
      if (current?.content === record.content && current.file.hash === record.baseHash && current.savedContent === record.baseContent) bufferUnsaved.current.delete(record.path)
    }).catch(error => { bufferErrors.current.add(record.path); setError(error instanceof Error ? error.message : '编辑缓冲保存失败') })
  }
  const persistBuffer = (buffer: Buffer) => {
    const path = buffer.file.path
    bufferUnsaved.current.add(path)
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
    if (!buffer.file.hash) { setError('文件缺少完整内容指纹，不能保存'); return false }
    await flushBuffers()
    const content = buffer.content
    const fingerprint = JSON.stringify([buffer.file.hash, content])
    let operation = saves.current.get(path)
    if (!operation || operation.fingerprint !== fingerprint) { operation = { fingerprint, id: crypto.randomUUID() }; saves.current.set(path, operation) }
    const reply = await call({ action: 'savePrototypeFile', prototypeTaskId: taskId, path, expectedHash: buffer.file.hash, content, operationId: operation.id })
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'saved') {
      setError(reply && !reply.ok ? `${reply.message}；编辑内容仍保留在当前缓冲中。` : '保存结果未知；编辑内容仍保留在当前缓冲中。')
      setComparePath(reply && !reply.ok ? path : undefined)
      return false
    }
    const hash = reply.prototypeFiles.hash
    saves.current.delete(path)
    setComparePath(undefined); setConflict(undefined)
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
  const compareDisk = async (path: string) => {
    const reply = await call({ action: 'readPrototypeFile', source, path })
    const current = buffersRef.current[path]
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'file' || !current) { setError(reply && !reply.ok ? reply.message : '无法读取当前磁盘文件'); return }
    const disk = reply.prototypeFiles
    if (!disk.hash || disk.binary || disk.truncated || disk.content === undefined) { setError('当前磁盘文件不能作为文本合并，编辑缓冲已保留'); return }
    if (disk.hash === current.file.hash) { setError('磁盘版本没有变化，请核对原保存操作后重试'); return }
    setConflict({ path, disk }); setEditing(true); setError('磁盘文件已变化。对照三个版本调整编辑内容后，可以使用当前磁盘版本作为保存依据。')
  }
  const mergeConflict = async () => {
    if (!conflict || !conflict.disk.hash || conflict.disk.content === undefined) return
    const current = buffersRef.current[conflict.path]
    if (!current?.file.hash) return
    const reply = await call({ action: 'mergePrototypeConflict', prototypeTaskId: taskId, path: conflict.path, baseHash: current.file.hash, baseContent: current.savedContent, diskHash: conflict.disk.hash, diskContent: conflict.disk.content, content: current.content })
    if (!reply?.ok || reply.prototypeMergedText === undefined) { setError(reply && !reply.ok ? reply.message : '合并结果不可用，编辑缓冲未改动'); return }
    const next: Buffer = { ...current, file: conflict.disk, savedContent: conflict.disk.content, content: reply.prototypeMergedText }
    buffersRef.current = { ...buffersRef.current, [conflict.path]: next }
    setBuffers(buffersRef.current); persistBuffer(next)
    setConflict(undefined); setComparePath(undefined); setError('合并结果已写入编辑缓冲，请审阅后保存。')
  }
  const useDiskAsBase = async () => {
    if (!conflict || !conflict.disk.hash || conflict.disk.content === undefined) return
    await flushBuffers()
    if (bufferErrors.current.size) { setError('原编辑缓冲尚未保存，请先重试'); return }
    const current = buffersRef.current[conflict.path]
    if (!current) return
    const next: Buffer = { ...current, file: conflict.disk, savedContent: conflict.disk.content }
    buffersRef.current = { ...buffersRef.current, [conflict.path]: next }
    setBuffers(buffersRef.current); persistBuffer(next)
    await flushBuffers()
    if (bufferErrors.current.has(conflict.path)) { setError('合并缓冲尚未保存，请保留当前内容'); return }
    setConflict(undefined); setComparePath(undefined); setError('已采用当前磁盘版本作为保存依据；保存时仍会核对磁盘是否再次变化。')
  }
  useEffect(() => {
    registerFlush(async () => {
      await flushBuffers()
      if (bufferErrors.current.size) { onNeedsAttention(); return false }
      return true
    })
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!bufferUnsaved.current.size && !bufferErrors.current.size) return
      event.preventDefault(); event.returnValue = ''
      void flushBuffers().then(() => { if (bufferErrors.current.size) onNeedsAttention() })
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { window.removeEventListener('beforeunload', beforeUnload); for (const path of [...pendingBuffers.current.keys()]) queueBuffer(path); registerFlush(undefined) }
  }, [registerFlush, save, onNeedsAttention])

  const submitSearch = async (cursor?: string) => {
    if (!search.trim()) { await list(directory); return }
    const reply = await call({ action: 'searchPrototypeFiles', source, query: search.trim(), directory, ...(cursor ? { cursor } : {}) })
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'search') { setError(reply && !reply.ok ? reply.message : '无法搜索工程'); return }
    const next = reply.prototypeFiles
    setMatches(previous => cursor && previous?.observation === next.observation ? { ...next, matches: [...previous.matches, ...next.matches] } : next); setDiff(undefined); setDiffPath(undefined); setError('')
  }
  const loadDiff = async (cursor?: string) => {
    const reply = await call({ action: 'readPrototypeDiff', prototypeTaskId: taskId, ...(cursor ? { cursor } : {}) })
    if (!reply?.ok || reply.prototypeFiles?.kind !== 'diff') { setError(reply && !reply.ok ? reply.message : '无法读取工程差异'); return }
    const next = reply.prototypeFiles
    setDiff(previous => cursor && previous?.observation === next.observation ? { ...next, files: [...previous.files, ...next.files] } : next)
    if (!cursor) { setSelected(undefined); setDiffPath(undefined) }
    setMatches(undefined); setError('')
  }
  useEffect(() => { if (requestDiff) void loadDiff() }, [requestDiff])
  const current = selected ? buffers[selected] : undefined
  const range = selected && current && current.content === current.savedContent ? ranges[selected] : undefined
  const displayedFile = range ?? current?.file
  const selectedDiff = diff?.files.find(file => file.path === diffPath)
  const updateBuffer = (path: string, content: string) => {
    const buffer = buffersRef.current[path]
    if (!buffer) return
    const next = { ...buffer, content }
    buffersRef.current = { ...buffersRef.current, [path]: next }
    setBuffers(buffersRef.current); persistBuffer(next)
  }
  return <div className={`${css.files} ${filesCss.files}`} style={treeHidden ? { gridTemplateColumns: 'minmax(0, 1fr)' } : undefined}>
    <aside className={css.fileSidebar} aria-label="工程文件" hidden={treeHidden}>
      <div className={filesCss.treeHeader}><strong>文件</strong><button aria-pressed={showHidden} title="显示或隐藏点文件" onClick={() => setShowHidden(value => !value)}>隐藏文件</button><button aria-label="收起文件树" onClick={() => setTreeHidden(true)}>‹</button></div>
      <form className={css.fileSearch} onSubmit={event => { event.preventDefault(); void submitSearch() }}>
        <input aria-label="搜索工程文件内容" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索文件内容" maxLength={200} /><button>搜索</button>
      </form>
      <div className={css.directoryHead}><span>{diff ? '工程变更' : directory || '原型代码'}</span>{diff ? <button onClick={() => void list('')}>文件</button> : taskId && <button onClick={() => void loadDiff()}>变更</button>}{!diff && directory && <button onClick={() => void list(directory.split('/').slice(0, -1).join('/'))}>上一级</button>}</div>
      <div className={css.fileList}>
        {diff ? <>{diff.files.map(file => <button key={file.path} onClick={() => setDiffPath(file.path)}><span>{file.path}</span><small>{file.status === 'added' ? '新增' : file.status === 'deleted' ? '删除' : '修改'}</small></button>)}{diff.nextCursor && <button onClick={() => void loadDiff(diff.nextCursor)}>加载更多</button>}{diff.truncated && <p>部分文件或内容已截断。</p>}{!diff.truncated && !diff.files.length && <p>当前磁盘工程没有变更。</p>}</> : matches ? <>{matches.matches.map((match, index) => <button key={`${match.path}:${match.line}:${match.column}:${index}`} onClick={() => void open(match.path)}><strong>{match.path}:{match.line}</strong><small>{match.excerpt}</small></button>)}{matches.nextCursor && <button onClick={() => void submitSearch(matches.nextCursor)}>加载更多</button>}{matches.truncated && !matches.nextCursor && <p>{matches.truncationReason ?? '结果已截断，请缩小搜索范围。'}</p>}{!matches.truncated && !matches.matches.length && <p>没有找到匹配内容。</p>}</> : <>{listing && <PrototypeDirectoryTree showHidden={showHidden} source={source} listing={listing} call={call} selected={selected} onOpen={path => void open(path)} />}{listing?.nextCursor && <button onClick={() => void list(directory, listing.nextCursor)}>加载更多</button>}{listing?.truncated && !listing.nextCursor && <p>{listing.truncationReason ?? '目录结果已截断。'}</p>}{listing && !listing.truncated && !listing.entries.length && <p>目录为空。</p>}</>}
      </div>
    </aside>
    <section className={css.fileContent} aria-label="文件内容">
      <div className={filesCss.tabs} role="tablist" aria-label="已打开的文件">
        {treeHidden && <button aria-label="展开文件树" onClick={() => setTreeHidden(false)}>文件</button>}
        {Object.keys(buffers).filter(path => !closed.includes(path)).map(path => <div className={filesCss.tab} key={path}>
          <button role="tab" aria-selected={selected === path && !diffPath} onClick={() => void open(path)} title={path}>{path.split('/').pop()}{buffers[path]!.content !== buffers[path]!.savedContent ? ' ●' : ''}</button>
          <button aria-label={`关闭 ${path}`} onClick={() => {
            // Closing a tab preserves its editing buffer, including pending Host writes.
            setClosed(previous => [...previous, path])
            if (selected === path) { setSelected(Object.keys(buffers).find(item => item !== path && !closed.includes(item))); setEditing(false) }
          }}>×</button>
        </div>)}
      </div>
      {selected && <div className={filesCss.breadcrumb} aria-label="文件路径">原型代码 / {selected.split('/').join(' / ')}<small>UTF-8</small></div>}
      {error && <div className={css.fileError} role="alert">{error}</div>}
      {comparePath && comparePath === selected && !conflict && <button onClick={() => void compareDisk(comparePath)}>比较当前磁盘版本</button>}
      {conflict && conflict.path === selected && current && <div className={css.mergeReview}>
        <p>对照原始内容和当前磁盘内容，编辑下方的缓冲；磁盘不会在此步骤被覆盖。</p>
        <PrototypeComparison path={current.file.path} base={current.savedContent} current={conflict.disk.content ?? ''} baseLabel="编辑前的原始内容" currentLabel="当前磁盘内容" />
        <button onClick={() => void mergeConflict()}>AI 合并到编辑缓冲</button>
        <button onClick={() => void useDiskAsBase()}>用当前磁盘版本作为保存依据</button>
        <button onClick={() => setConflict(undefined)}>继续保留原缓冲</button>
      </div>}
      {selectedDiff ? <><header className={css.fileHeader}><strong>{selectedDiff.path}</strong><span>起始版本与当前磁盘内容</span>{selectedDiff.status !== 'deleted' && <button onClick={() => void open(selectedDiff.path)}>打开文件</button>}</header>{selectedDiff.binary ? <p className={css.empty}>二进制文件不显示正文。</p> : (selectedDiff.baseContent !== undefined || selectedDiff.status === 'added') && (selectedDiff.currentContent !== undefined || selectedDiff.status === 'deleted') ? <PrototypeComparison path={selectedDiff.path} base={selectedDiff.baseContent ?? ''} current={selectedDiff.currentContent ?? ''} baseLabel={selectedDiff.status === 'added' ? '起始版本（新文件）' : '起始版本'} currentLabel={selectedDiff.status === 'deleted' ? '当前磁盘（已删除）' : '当前磁盘'} /> : <p className={css.empty}>差异内容不可用。</p>}{selectedDiff.truncated && <p className={css.muted}>部分内容超过显示限制或不可读取。</p>}</> : diff && !selected ? <p className={css.empty}>选择一项变更，查看两侧磁盘内容。</p> : current && displayedFile ? <><header className={css.fileHeader}><strong>{current.file.path}</strong><span>{range ? '范围只读' : current.content !== current.savedContent ? '未保存' : current.file.readOnly ? '只读' : '已保存'}</span>{!range && !current.file.readOnly && current.file.content !== undefined && !current.file.truncated && <><button onClick={() => setEditing(value => !value)}>{editing ? '退出编辑' : '编辑'}</button><button disabled={working || current.content === current.savedContent || conflict?.path === current.file.path} onClick={() => { setWorking(true); void save(current.file.path).finally(() => setWorking(false)) }}>保存</button></>}</header>
        {range ? range.binary ? <p className={css.empty}>二进制文件不显示正文。</p> : range.content === undefined ? <p className={css.empty}>文件范围不可用。</p> : <PrototypeEditor path={range.path} content={range.content} readOnly /> : current.content !== current.savedContent && (current.file.content === undefined || current.file.binary) ? <PrototypeEditor path={current.file.path} content={current.content} readOnly /> : current.file.binary ? <p className={css.empty}>二进制文件不显示正文。</p> : current.file.content === undefined ? <p className={css.empty}>文件正文不可用。</p> : conflict?.path === current.file.path ? <PrototypeComparison path={current.file.path} base={conflict.disk.content ?? ''} current={current.content} baseLabel="当前磁盘内容" currentLabel="编辑缓冲" onChange={content => updateBuffer(current.file.path, content)} /> : <PrototypeEditor path={current.file.path} content={current.content} readOnly={!editing || current.file.readOnly || !!current.file.truncated} onChange={content => updateBuffer(current.file.path, content)} />}
        {displayedFile.truncated && <p className={css.empty}>{displayedFile.truncationReason ?? '文件内容已截断，仅供查看。'}</p>}
        {current.file.size > 1024 * 1024 && <div><button onClick={() => void openRange(current.file.path, Math.max(1, (range?.lineRange?.start ?? 201) - 200))} disabled={range?.lineRange?.start === 1}>上一段</button><button disabled={!!range?.lineRange && !range.nextLine} onClick={() => void openRange(current.file.path, range?.nextLine ?? 1)}>{range?.lineRange ? '下一段' : '读取前 200 行'}</button>{range?.lineRange && <span>{range.rangeComplete ? `第 ${range.lineRange.start}–${range.lineRange.end} 行` : '行范围读取未完成'}</span>}{range && <button onClick={() => setRanges(previous => { const next = { ...previous }; delete next[current.file.path]; return next })}>返回文件</button>}</div>}</> : <p className={css.empty}>{selected ? '正在读取文件…' : '选择文件查看内容。'}</p>}
    </section>
  </div>
}
