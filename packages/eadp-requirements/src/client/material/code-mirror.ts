/**
 * React-free CodeMirror 6 setup for the material editor.
 *
 * The view is created once per document pane and driven imperatively: React
 * pushes authoritative text through `syncDocument`, user edits flow back
 * through the update listener, and `externalSync` marks React-originated
 * replacements so the listener never echoes them as user input.
 */

import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder, type Panel, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { defineLanguageFacet, HighlightStyle, Language, LanguageSupport, syntaxHighlighting } from '@codemirror/language'
import { Emoji, GFM, Subscript, Superscript, parser as lezerMarkdownParser } from '@lezer/markdown'
import { tags } from '@lezer/highlight'
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  search,
  searchKeymap,
  setSearchQuery,
} from '@codemirror/search'

/* Markdown assembled directly from @lezer/markdown. @codemirror/lang-markdown
 * is deliberately not used: it statically pulls autocomplete, lint and the
 * css/js/html languages into the client bundle. */
const markdownLanguage = new Language(
  defineLanguageFacet({ commentTokens: { block: { open: '<!--', close: '-->' } } }),
  lezerMarkdownParser.configure([GFM, Subscript, Superscript, Emoji]),
  [],
  'markdown',
)
const markdownSupport: Extension = new LanguageSupport(markdownLanguage)

/** Markdown heading positions from the same parser used by source highlighting. */
export function documentHeadings(text: string): { title: string; line: number; depth: number }[] {
  const document = EditorState.create({ doc: text }).doc
  const headings: { title: string; line: number; depth: number }[] = []
  lezerMarkdownParser.configure([GFM]).parse(text).iterate({
    enter(node) {
      const heading = /^(ATX|Setext)Heading([1-6])$/.exec(node.name)
      if (!heading) return
      const line = document.lineAt(node.from)
      const title = heading[1] === 'ATX' ? line.text.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '') : line.text
      headings.push({ title, line: line.number, depth: Number(heading[2]) })
    },
  })
  return headings
}

/** Marks full-document replacements pushed from React so the listener skips them. */
export const externalSync = Annotation.define<boolean>()

/** Caller-owned copy for the in-document find panel. */
export interface SearchLabels {
  find: string
  previous: string
  next: string
  close: string
}

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--eadp-text)', fontWeight: '650', fontSize: '1.3em' },
  { tag: [tags.heading2, tags.heading3], color: 'var(--eadp-text)', fontWeight: '600' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--eadp-text)', fontWeight: '600', fontSize: '1.02em' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--eadp-accent)' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  { tag: [tags.quote, tags.list], color: 'var(--eadp-muted)' },
  { tag: [tags.processingInstruction, tags.comment, tags.contentSeparator], color: 'var(--eadp-faint)' },
])

const markdownTheme = EditorView.theme({
  // The editor fills its flex host; a percentage height would defeat stretch.
  '&': {
    flex: '1 1 0%',
    minWidth: '0',
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
    color: 'var(--eadp-text)',
    fontFamily: 'var(--eadp-font-doc)',
    fontSize: '15px',
    lineHeight: '1.75',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: 'inherit' },
  '.cm-content': {
    padding: '24px 32px',
    boxSizing: 'border-box',
    minHeight: '100%',
    caretColor: 'var(--eadp-accent)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--eadp-accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--eadp-selected)' },
  '.cm-content ::selection': { backgroundColor: 'var(--eadp-selected)' },
  '.cm-placeholder': { color: 'var(--eadp-faint)' },
  '.cm-panels': {
    backgroundColor: 'var(--eadp-raised)',
    color: 'var(--eadp-text)',
    fontFamily: 'var(--eadp-font-ui)',
  },
  '.cm-panels-top': { borderBottom: '1px solid var(--eadp-line)' },
  '.cm-eadp-search': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 10px',
    fontSize: 'var(--eadp-text-sm)',
  },
  '.cm-eadp-search input': {
    flex: '1 1 12em',
    minWidth: '8em',
    height: '28px',
    padding: '0 8px',
    border: '1px solid var(--eadp-line-strong)',
    borderRadius: 'var(--eadp-radius-sm)',
    backgroundColor: 'var(--eadp-surface)',
    color: 'var(--eadp-text)',
    font: 'inherit',
  },
  '.cm-eadp-search input:focus-visible': { outline: 'none', boxShadow: 'var(--eadp-focus-ring)' },
  '.cm-eadp-search button': {
    minWidth: '28px',
    height: '28px',
    padding: '0 8px',
    border: '1px solid var(--eadp-line-strong)',
    borderRadius: 'var(--eadp-radius-sm)',
    backgroundColor: 'transparent',
    color: 'var(--eadp-muted)',
    font: 'inherit',
    cursor: 'pointer',
  },
  '.cm-eadp-search button:hover': { backgroundColor: 'var(--eadp-hover)', color: 'var(--eadp-text)' },
  '.cm-eadp-search-count': {
    color: 'var(--eadp-muted)',
    fontVariantNumeric: 'tabular-nums',
    minWidth: '3.5em',
    textAlign: 'center',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--eadp-warning-soft)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--eadp-accent-soft)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--eadp-accent-soft)' },
})

/** Matches before and after a find query changes; both counts are caller-facing numbers only. */
function matchCount(state: EditorState, query: SearchQuery): { current: number; total: number } {
  if (!query.valid) return { current: 0, total: 0 }
  const selection = state.selection.main
  let total = 0
  let current = 0
  const cursor = query.getCursor(state)
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    total += 1
    if (step.value.from === selection.from && step.value.to === selection.to) current = total
  }
  return { current, total }
}

function button(name: string, label: string, text: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.name = name
  element.textContent = text
  element.setAttribute('aria-label', label)
  element.title = label
  return element
}

/** Compact find bar; the default English panel is replaced because UI copy is locale-owned. */
function findPanel(labels: SearchLabels) {
  return (view: EditorView): Panel => {
    const input = document.createElement('input')
    input.type = 'text'
    input.name = 'search'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.placeholder = labels.find
    input.setAttribute('aria-label', labels.find)
    input.setAttribute('main-field', 'true')
    input.value = getSearchQuery(view.state).search

    const count = document.createElement('span')
    count.className = 'cm-eadp-search-count'

    const previous = button('previous', labels.previous, '↑')
    const next = button('next', labels.next, '↓')
    const close = button('close', labels.close, '×')

    const dom = document.createElement('div')
    dom.className = 'cm-eadp-search'
    dom.setAttribute('role', 'search')
    dom.setAttribute('aria-label', labels.find)
    dom.append(input, count, previous, next, close)

    const commit = (): void => {
      const query = new SearchQuery({ search: input.value, literal: true })
      if (!query.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(query) })
    }
    const renderCount = (state: EditorState): void => {
      const matches = matchCount(state, getSearchQuery(state))
      count.textContent = `${matches.current} / ${matches.total}`
    }

    input.addEventListener('input', commit)
    previous.addEventListener('click', () => findPrevious(view))
    next.addEventListener('click', () => findNext(view))
    close.addEventListener('click', () => closeSearchPanel(view))
    dom.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeSearchPanel(view)
        return
      }
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) findPrevious(view)
        else findNext(view)
      }
    })

    return {
      dom,
      top: true,
      mount() {
        input.focus()
        input.select()
      },
      update(update: ViewUpdate) {
        const query = getSearchQuery(update.state)
        if (input.value !== query.search) input.value = query.search
        renderCount(update.state)
      },
    }
  }
}

/** Everything the mount needs to create one view. */
export interface EditorOptions {
  sessionKey: object
  parent: HTMLElement
  text: string
  readOnly: boolean
  ariaLabel: string
  placeholder: string
  labels: SearchLabels
  onEdit(text: string): void
  onCompose(composing: boolean): void
  onSave(): void
  onBlur(): void
}

/** Imperative handle for a mounted view; React owns creation and disposal. */
export interface EditorMount {
  readonly view: EditorView
  /** Replace the whole document from React state without echoing it as a user edit. */
  syncDocument(text: string): void
  /** Drop undo entries so another document's history can never be restored into this view. */
  resetHistory(): void
  setReadOnly(readOnly: boolean): void
  setLabel(label: string): void
  openFind(): boolean
  focus(): void
  destroy(): void
}

/** Source sessions live only as long as their owning document buffer. */
const sourceSessions = new WeakMap<object, { state: EditorState; scrollTop: number; history: Compartment; editability: Compartment; attributes: Compartment; callbacks: Pick<EditorOptions, 'onEdit' | 'onCompose' | 'onSave' | 'onBlur'> }>()

/** Mount one editor view; the caller keeps the returned mount for the component lifetime. */
export function createEditor(options: EditorOptions): EditorMount {
  const retained = sourceSessions.get(options.sessionKey)
  const historyCompartment = retained?.history ?? new Compartment()
  const editability = retained?.editability ?? new Compartment()
  const attributes = retained?.attributes ?? new Compartment()
  const callbacks = retained?.callbacks ?? {
    onEdit: options.onEdit,
    onCompose: options.onCompose,
    onSave: options.onSave,
    onBlur: options.onBlur,
  }
  Object.assign(callbacks, { onEdit: options.onEdit, onCompose: options.onCompose, onSave: options.onSave, onBlur: options.onBlur })
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        historyCompartment.of(history()),
        editability.of([EditorState.readOnly.of(options.readOnly), EditorView.editable.of(!options.readOnly)]),
        attributes.of(EditorView.contentAttributes.of({ 'aria-label': options.ariaLabel })),
        markdownSupport,
        syntaxHighlighting(markdownHighlight),
        markdownTheme,
        search({ top: true, literal: true, createPanel: findPanel(options.labels) }),
        placeholder(options.placeholder),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
        Prec.high(keymap.of([{ key: 'Mod-s', run: () => { callbacks.onSave(); return true } }])),
        Prec.highest(EditorView.domEventHandlers({
          compositionstart() {
            callbacks.onCompose(true)
            return false
          },
          compositionend() {
            callbacks.onCompose(false)
            return false
          },
          blur() {
            callbacks.onBlur()
            return false
          },
        })),
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return
          if (update.transactions.some(transaction => transaction.annotation(externalSync))) return
          callbacks.onEdit(update.state.doc.toString())
        }),
      ],
    }),
  })
  if (retained?.state.doc.toString() === options.text) {
    view.setState(retained.state)
    // Restored state keeps history; mutable callback dispatch belongs to the current mount.
    view.dispatch({ effects: [
      editability.reconfigure([EditorState.readOnly.of(options.readOnly), EditorView.editable.of(!options.readOnly)]),
      attributes.reconfigure(EditorView.contentAttributes.of({ 'aria-label': options.ariaLabel })),
    ] })
    requestAnimationFrame(() => { if (view.dom.isConnected) view.scrollDOM.scrollTop = retained.scrollTop })
  }
  return {
    view,
    syncDocument(text) {
      const current = view.state.doc.toString()
      if (current === text) return
      /* Drop undo entries from the replaced document so undo never restores it. */
      view.dispatch({ effects: historyCompartment.reconfigure([]) })
      view.dispatch({
        changes: { from: 0, to: current.length, insert: text },
        selection: { anchor: Math.min(view.state.selection.main.anchor, text.length) },
        annotations: externalSync.of(true),
      })
      view.dispatch({ effects: historyCompartment.reconfigure(history()) })
    },
    resetHistory() {
      view.dispatch({ effects: historyCompartment.reconfigure([]) })
      view.dispatch({ effects: historyCompartment.reconfigure(history()) })
    },
    setReadOnly(readOnly) {
      view.dispatch({ effects: editability.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) })
    },
    setLabel(label) {
      view.dispatch({ effects: attributes.reconfigure(EditorView.contentAttributes.of({ 'aria-label': label })) })
    },
    openFind() {
      return openSearchPanel(view)
    },
    focus() {
      view.focus()
    },
    destroy() {
      sourceSessions.set(options.sessionKey, { state: view.state, scrollTop: view.scrollDOM.scrollTop, history: historyCompartment, editability, attributes, callbacks })
      if (view.composing) callbacks.onCompose(false)
      view.destroy()
    },
  }
}
