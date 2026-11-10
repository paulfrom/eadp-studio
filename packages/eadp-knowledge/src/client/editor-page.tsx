import { useId, type RefObject } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { isKnowledgeCategory, KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from '@eadp/contracts/knowledge'
import { Button, Field, IconChevronRight, Input, Notice } from '@eadp/shell/client/ui'
import { MarkdownEditor, type MarkdownEditorHandle } from '@eadp/shell/client/document-editor'
import { NS } from './locales.ts'
import layout from './panel.module.css'
import css from './editor-page.module.css'

/**
 * One editing session. `markdown` and `assets` are the values the editor
 * mounts with; later refreshes never replace them, so unsaved input survives.
 */
export interface EditorSession {
  /** Changes per opened session so the editor remounts with the new initial content. */
  key: number
  mode: 'create' | 'edit' | 'manual'
  /** Page to return to when the editor is cancelled. */
  returnTo: 'library' | 'imports' | 'detail'
  documentId: string | null
  expectedRevisionId: string | null
  importId: string | null
  fileName: string
  markdown: string
  assets: Record<string, string>
  autoReference: boolean
  title: string
  category: KnowledgeCategory
  scope: string
}

export interface EditorPageProps extends PropsLocale<typeof NS> {
  session: EditorSession
  saving: boolean
  error: string
  editorRef: RefObject<MarkdownEditorHandle>
  onChange(changes: Partial<Pick<EditorSession, 'title' | 'category' | 'scope'>>): void
  onSave(): void
  onCancel(): void
}

const TITLE_KEYS: Record<EditorSession['mode'], 'newDocumentTitle' | 'editDocumentTitle' | 'manualDocumentTitle'> = {
  create: 'newDocumentTitle',
  edit: 'editDocumentTitle',
  manual: 'manualDocumentTitle',
}

/** Editor page: business metadata, the shared rich-text body, and save/cancel only. */
export function EditorPage(props: EditorPageProps) {
  const { session, saving, error, editorRef, t } = props
  const titleId = useId()
  const scopeId = useId()
  const categoryId = useId()
  return <div className={layout.page}>
    <div className={css.shell}>
      <div className={layout.backRow}>
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          <span className={layout.backIcon}><IconChevronRight /></span>
          {t('back')}
        </Button>
      </div>
      <header className={layout.heading}>
        <div className={layout.headingText}>
          <div className={layout.eyebrow}>{t('editorEyebrow')}</div>
          <h1 className={layout.pageTitle}>{t(TITLE_KEYS[session.mode])}</h1>
          <p className={layout.intro}>{session.mode === 'manual' ? t('manualIntro') : t('editorIntro')}</p>
          {session.mode === 'manual' && session.fileName !== ''
            ? <p className={css.sourceLine}>{t('manualSourceLabel')} · {session.fileName}</p>
            : null}
        </div>
      </header>
      <form className={css.form} onSubmit={event => { event.preventDefault(); props.onSave() }}>
        <div className={css.panel}>
          <div className={css.metadata}>
            <Field label={t('titleField')} htmlFor={titleId}>
              <Input
                id={titleId}
                autoFocus
                value={session.title}
                disabled={saving}
                placeholder={t('titlePlaceholder')}
                onChange={event => props.onChange({ title: event.target.value })} />
            </Field>
            <Field label={t('categoryField')} htmlFor={categoryId}>
              <select
                id={categoryId}
                className={layout.select}
                value={session.category}
                disabled={saving}
                onChange={event => {
                  const next = event.target.value
                  if (isKnowledgeCategory(next)) props.onChange({ category: next })
                }}>
                {KNOWLEDGE_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
              </select>
            </Field>
          </div>
          <Field label={t('scopeField')} htmlFor={scopeId} hint={t('scopeHint')}>
            <Input
              id={scopeId}
              value={session.scope}
              disabled={saving}
              placeholder={t('scopePlaceholder')}
              onChange={event => props.onChange({ scope: event.target.value })} />
          </Field>
          <div className={layout.fieldBlock}>
            <span className={layout.fieldLabel}>{t('bodyField')}</span>
            <div className={css.editorSurface}>
              <MarkdownEditor
                key={session.key}
                ref={editorRef}
                markdown={session.markdown}
                assets={session.assets}
                ariaLabel={t('bodyField')} />
            </div>
            <span className={layout.hint}>{t('editorNote')}</span>
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className={css.actions}>
            <Button variant="ghost" disabled={saving} onClick={props.onCancel}>{t('cancel')}</Button>
            <Button type="submit" variant="primary" loading={saving}>
              {saving ? t('saving') : session.mode === 'edit' ? t('saveChangesAction') : t('saveDocumentAction')}
            </Button>
          </div>
        </div>
      </form>
    </div>
  </div>
}
