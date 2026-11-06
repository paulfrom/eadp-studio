import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrototypeContent, PrototypeFileList, PrototypeRunLog, PrototypeRunState } from '@eadp/contracts/prototype'
import type { PrototypeApi } from './api.ts'

type Snapshot<T> = { value?: T; stale: boolean; error?: string }
const message = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/** Isolates replies by the mounted project, view epoch, and individual resource request. */
export function usePrototype(projectId: string, active: boolean, api: PrototypeApi) {
  const [directories, setDirectories] = useState<Record<string, Snapshot<PrototypeFileList>>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [file, setFile] = useState<Snapshot<PrototypeContent>>({ stale: false })
  const [runtime, setRuntime] = useState<Snapshot<PrototypeRunState>>({ stale: false })
  const [logs, setLogs] = useState<Snapshot<PrototypeRunLog>>({ stale: false })
  const [runs, setRuns] = useState<Snapshot<PrototypeRunState[]>>({ stale: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [diagnostics, setDiagnostics] = useState(false)
  const epoch = useRef(0)
  const operation = useRef(false)
  const selected = useRef<string>()
  const fileRequest = useRef(0)
  const observation = useRef(0)
  const directoryRequests = useRef(new Map<string, number>())
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const current = useCallback((token: number) => token === epoch.current, [])

  const read = useCallback(async (path: string, token = epoch.current) => {
    const request = ++fileRequest.current
    selected.current = path
    try {
      const value = await api.readFile(projectId, path)
      if (current(token) && request === fileRequest.current) setFile({ value, stale: false })
    } catch (reason) {
      if (current(token) && request === fileRequest.current) setFile(previous => ({ ...previous, stale: true, error: message(reason) }))
    }
  }, [api, current, projectId])

  const list = useCallback(async (path: string, token = epoch.current) => {
    const request = (directoryRequests.current.get(path) ?? 0) + 1
    directoryRequests.current.set(path, request)
    try {
      const value = await api.listFiles(projectId, path)
      if (current(token) && directoryRequests.current.get(path) === request) setDirectories(previous => ({ ...previous, [path]: { value, stale: false } }))
    } catch (reason) {
      if (current(token) && directoryRequests.current.get(path) === request) setDirectories(previous => ({ ...previous, [path]: { ...previous[path], stale: true, error: message(reason) } }))
    }
  }, [api, current, projectId])

  const observe = useCallback(async (token: number, includeLogs: boolean) => {
    const request = ++observation.current
    const valid = () => current(token) && request === observation.current
    await Promise.all([
      api.status(projectId).then(value => { if (valid()) setRuntime({ value, stale: false }) }).catch(reason => { if (valid()) setRuntime(previous => ({ ...previous, stale: true, error: message(reason) })) }),
      api.listRuns().then(value => { if (valid()) setRuns({ value, stale: false }) }).catch(reason => { if (valid()) setRuns(previous => ({ ...previous, stale: true, error: message(reason) })) }),
      ...(includeLogs ? [api.logs(projectId).then(value => { if (valid()) setLogs({ value, stale: false }) }).catch(reason => { if (valid()) setLogs(previous => ({ ...previous, stale: true, error: message(reason) })) })] : []),
    ])
  }, [api, current, projectId])

  const refresh = useCallback(async (token = epoch.current) => {
    await Promise.all([
      ...[...expandedRef.current].map(path => list(path, token)),
      ...(selected.current ? [read(selected.current, token)] : []),
      observe(token, diagnostics),
    ])
  }, [diagnostics, list, observe, read])

  useEffect(() => {
    const token = ++epoch.current
    if (!active) return
    operation.current = false; setBusy(false)
    void refresh(token)
    return () => { epoch.current += 1 }
    // Diagnostics changes must not invalidate an in-flight explicit user action.
  }, [active, projectId, api])

  useEffect(() => {
    if (!active) return
    const token = epoch.current
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const poll = async () => {
      // Explicit actions own the current state until their reply is received.
      if (!operation.current) await observe(token, diagnostics)
      if (!disposed && current(token)) timer = setTimeout(() => { void poll() }, 1500)
    }
    timer = setTimeout(() => { void poll() }, 1500)
    return () => { disposed = true; clearTimeout(timer) }
  }, [active, current, diagnostics, observe])

  const act = async (action: 'createProject' | 'install' | 'start' | 'stop', target = projectId) => {
    if (operation.current) return
    const token = epoch.current
    operation.current = true; observation.current += 1; setBusy(true); setError('')
    try {
      // Refresh before starting so file changes become visible without implicit writes.
      if (action === 'start') await refresh(token)
      if (!current(token)) return
      await api[action](target)
    } catch (reason) {
      if (current(token)) setError(message(reason))
    } finally {
      if (current(token)) {
        await refresh(token)
        if (current(token)) { operation.current = false; setBusy(false) }
      }
    }
  }

  const toggle = (path: string) => {
    if (expanded.has(path)) setExpanded(previous => { const next = new Set(previous); next.delete(path); return next })
    else { setExpanded(previous => new Set(previous).add(path)); void list(path) }
  }
  return { directories, expanded, file, runtime, logs, runs, busy, error, diagnostics, setDiagnostics, refresh, read, toggle, act }
}
