import { useEffect, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RequirementDocument } from '@eadp/contracts'
import type { DraftBuffer } from './DraftBuffer.ts'
import type { RequirementsApi } from './api.ts'
import { NS } from './locales.ts'
import css from './requirements.module.css'

export interface Selection { projectId: string; path: string; buffer: DraftBuffer }
/** Polls versions without replacing dirty input and preserves IME composition. */
export function RequirementEditor({ selection, api, discardMissing, locked, t }: { selection: Selection; api: RequirementsApi; locked: boolean; discardMissing(): void } & PropsLocale<typeof NS>) {
  const { buffer, projectId, path } = selection
  const snapshot = useSyncExternalStore(buffer.subscribe, buffer.getSnapshot)
  useEffect(() => {
    let active = true, reading = false
    const refresh = async () => {
      if (reading || (buffer.getSnapshot().saving || buffer.getSnapshot().applying)) return
      reading = true
      try {
        const version = await api.statVersion(projectId, path)
        if (!active || version === buffer.getSnapshot().version) return
        let document: RequirementDocument | null = null
        if (version !== null) {
          if (path === 'CONTEXT.md') {
            const context = await api.readContext(projectId)
            if (context.kind === 'present') document = { relativePath: path, text: context.text, version: context.version }
          } else document = await api.read(projectId, path)
        }
        if (active) buffer.receive(document)
      } catch (error) {
        if (active) buffer.reportError(error instanceof Error ? error.message : String(error))
      } finally { reading = false }
    }
    const timer = setInterval(() => { void refresh() }, 2000)
    const focused = () => { void refresh() }
    window.addEventListener('focus', focused)
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', focused) }
  }, [buffer, api, projectId, path])
  return <section className={css.editor} aria-label={path}>
    <header className={css.editorHeader}><strong>{path}</strong><span role="status">{t(snapshot.composing ? 'composing' : snapshot.applying ? 'applyingProposal' : snapshot.saving ? 'saving' : snapshot.dirty ? 'dirty' : 'saved')}</span><button disabled={locked || snapshot.applying || snapshot.composing || snapshot.saving} onClick={() => { void buffer.flush() }}>{t('save')}</button></header>
    {snapshot.error && <p role="alert" className={css.error}>{snapshot.error}</p>}
    {snapshot.external !== undefined && <section className={css.conflict} role="alert">
      <p>{t('conflict')}</p>
      {snapshot.external ? <><button disabled={locked || snapshot.applying || snapshot.composing || snapshot.saving} onClick={() => buffer.loadExternal()}>{t('loadDisk')}</button>{' '}<button disabled={locked || snapshot.applying || snapshot.composing || snapshot.saving} onClick={() => buffer.keepDraft()}>{t('keepDraft')}</button><details><summary>{t('disk')}</summary><pre>{snapshot.external.text}</pre></details></> : <><p>{t('missing')}</p><button disabled={locked || snapshot.applying || snapshot.composing || snapshot.saving} onClick={() => { void buffer.recreate(text => path === 'CONTEXT.md' ? api.saveContext(projectId, text, null) : api.create(projectId, path, text)) }}>{t('recreate')}</button>{' '}<button disabled={locked || snapshot.applying || snapshot.composing || snapshot.saving} onClick={discardMissing}>{t('discardMissing')}</button></>}
    </section>}
    <textarea className={css.textarea} aria-label={path} value={snapshot.text} readOnly={locked} spellCheck={false} onChange={event => buffer.edit(event.target.value)} onCompositionStart={() => buffer.compose(true)} onCompositionEnd={() => buffer.compose(false)} onBlur={() => { void buffer.flush() }} />
  </section>
}
