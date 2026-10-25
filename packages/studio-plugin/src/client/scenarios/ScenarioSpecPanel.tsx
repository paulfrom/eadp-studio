import { useState } from 'react'
import type { ReactNode } from 'react'
import type { EntityView, MaterialDraft, MaterialMetadata, TemplateCatalogView } from '../../shared/studio.ts'
import type { ScenarioWorkspace as Workspace } from '../../shared/scenarios.ts'
import type { DraftBuffer, DraftSnapshot } from './DraftBuffer.ts'
import { DocumentMeta, DocumentSections, DocumentToolbar } from '../components/MaterialDocument.tsx'
import { ScenarioConflict } from './ScenarioConflict.tsx'
import { ScenarioFrontmatter } from './ScenarioFrontmatter.tsx'
import css from '../studio.module.css'
import doc from '../components/document.module.css'

/**
 * Scenario document with collapsible business sections, source editing and
 * identity details. Workspace actions can be composed after the document.
 */
export function ScenarioSpecPanel({ entity, draft, buffer, snapshot, workspace, templates, busy, onCollapse, onBindTemplate, onResolve, children }: {
  entity: EntityView; draft: MaterialDraft; buffer: DraftBuffer; snapshot: DraftSnapshot; workspace: Workspace;
  templates?: TemplateCatalogView | undefined; busy: boolean; onCollapse(): void;
  onBindTemplate(templateId: string): void; onResolve(body: string, metadata: MaterialMetadata, actualHash: string): void;
  children?: ReactNode;
}) {
  const [preview, setPreview] = useState(true)
  const editable = !workspace.readOnly && workspace.repair?.status !== 'active'
  const syncState = workspace.readOnly ? `固定版本 v${entity.materialVersion}`
    : snapshot.saving ? '正在保存本地草稿…'
    : snapshot.error ? snapshot.error
    : snapshot.dirty ? '有未保存输入' : '本地草稿已保存'
  return <section className={css.specPanel} aria-label="场景契约">
    <DocumentToolbar draft={draft} title={snapshot.metadata.title} body={snapshot.body} preview={preview} syncState={syncState} state={snapshot.error ? 'error' : snapshot.dirty || snapshot.saving ? 'pending' : 'synced'} readOnly={workspace.readOnly} saveDisabled={busy || !editable || snapshot.saving || !!snapshot.conflict || !snapshot.dirty} retry={!!snapshot.error} onPreview={setPreview} onSave={() => void buffer.flush()} onCollapse={onCollapse} />
    <div className={css.specBody}>
      {workspace.readOnly && <div className={doc.confirmed}><span aria-hidden="true">✓</span>已确认为固定版本 v{entity.materialVersion}</div>}
      <DocumentMeta entity={entity} body={snapshot.body} readOnly={workspace.readOnly} confirmedAt={workspace.confirmedAt} />
      <ScenarioConflict draft={draft} snapshot={snapshot} busy={busy} onResolve={onResolve} />
      {preview ? <DocumentSections body={snapshot.body} templateBody={workspace.template.body} materialLabel="场景" /> : <label className={css.bodyLabel}>场景 Markdown<textarea className={css.materialBody} spellCheck={false} readOnly={!editable} aria-label="场景 Markdown 正文" value={snapshot.body} onChange={event => buffer.edit({ body: event.target.value, metadata: snapshot.metadata })} /></label>}
      <details className={doc.fields}><summary>场景信息与模板</summary><div className={doc.fieldsBody}><ScenarioFrontmatter entity={entity} buffer={buffer} snapshot={snapshot} readOnly={workspace.readOnly} editingDisabled={workspace.repair?.status === 'active'} templates={templates} busy={busy} onBindTemplate={onBindTemplate} /></div></details>
    </div>
    {children}
  </section>
}
