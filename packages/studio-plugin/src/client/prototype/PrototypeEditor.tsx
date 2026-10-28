import { useEffect, useRef } from 'react'
import { EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { css as cssLanguage } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { MergeView } from '@codemirror/merge'
import styles from './prototype.module.css'

function languageFor(path: string): Extension {
  if (/\.[cm]?[jt]sx?$/i.test(path)) return javascript({ typescript: /\.[cm]?tsx?$/i.test(path), jsx: /\.[jt]sx$/i.test(path) })
  if (/\.(css|less)$/i.test(path)) return cssLanguage()
  if (/\.json$/i.test(path)) return json()
  return []
}

function extensions(path: string, label: string, readOnly: boolean, onChange?: (value: string) => void): Extension[] {
  return [
    lineNumbers(), drawSelection(), highlightActiveLine(), history(), highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }), languageFor(path),
    EditorView.theme({
      '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)', font: '12px/1.65 var(--mono)' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)' },
      '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-3)', borderColor: 'var(--border)' },
    }),
    EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
    EditorView.updateListener.of(update => { if (update.docChanged) onChange?.(update.state.doc.toString()) }),
  ]
}

function syncDocument(view: EditorView, content: string) {
  if (view.state.doc.toString() !== content) view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    annotations: Transaction.addToHistory.of(false),
  })
}

/** One controlled editor; the Host remains the authority for saves and permissions. */
export function PrototypeEditor({ path, content, readOnly, onChange }: {
  path: string
  content: string
  readOnly: boolean
  onChange?(content: string): void
}) {
  const parent = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange
  const syncing = useRef(false)
  useEffect(() => {
    if (!parent.current) return
    const view = new EditorView({ parent: parent.current, doc: content, extensions: extensions(path, `${path} 文件内容`, readOnly, value => { if (!syncing.current) onChangeRef.current?.(value) }) })
    editor.current = view
    return () => { editor.current = null; view.destroy() }
  }, [path, readOnly])
  useEffect(() => {
    if (!editor.current) return
    syncing.current = true
    try { syncDocument(editor.current, content) } finally { syncing.current = false }
  }, [content])
  return <div className={styles.codeEditor} ref={parent} />
}

/** Compare two real text versions, optionally editing the right-hand buffer. */
export function PrototypeComparison({ path, base, current, baseLabel, currentLabel, onChange }: {
  path: string
  base: string
  current: string
  baseLabel: string
  currentLabel: string
  onChange?(content: string): void
}) {
  const parent = useRef<HTMLDivElement>(null)
  const merge = useRef<MergeView | null>(null)
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange
  const editable = !!onChange
  const syncing = useRef(false)
  useEffect(() => {
    if (!parent.current) return
    const view = new MergeView({
      parent: parent.current,
      a: { doc: base, extensions: extensions(path, baseLabel, true) },
      b: { doc: current, extensions: extensions(path, currentLabel, !editable, value => { if (!syncing.current) onChangeRef.current?.(value) }) },
    })
    merge.current = view
    return () => { merge.current = null; view.destroy() }
  }, [path, baseLabel, currentLabel, editable])
  useEffect(() => {
    if (!merge.current) return
    syncing.current = true
    try { syncDocument(merge.current.a, base); syncDocument(merge.current.b, current) } finally { syncing.current = false }
  }, [base, current])
  return <div className={styles.comparison}>
    <div className={styles.comparisonLabels}><span>{baseLabel}</span><span>{currentLabel}</span></div>
    <div className={styles.comparisonView} ref={parent} />
  </div>
}
