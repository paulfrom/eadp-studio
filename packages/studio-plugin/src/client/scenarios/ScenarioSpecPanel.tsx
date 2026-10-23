import { useDeferredValue, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EntityView, MaterialDraft, MaterialMetadata, TemplateCatalogView } from '../../shared/studio.ts'
import type { ScenarioWorkspace as Workspace } from '../../shared/scenarios.ts'
import type { DraftBuffer, DraftSnapshot } from './DraftBuffer.ts'
import { exportMarkdown, listItemCount, markdownLabels, splitSections } from './document.ts'
import { ScenarioConflict } from './ScenarioConflict.tsx'
import { ScenarioFrontmatter } from './ScenarioFrontmatter.tsx'
import css from '../studio.module.css'

/**
 * Spec pane of the scenario page: the material file's frontmatter and one card
 * per business section, with source editing, export and the gate footer the
 * caller composes as children.
 */
export function ScenarioSpecPanel({ entity, draft, buffer, snapshot, workspace, templates, busy, onCollapse, onBindTemplate, onResolve, children }: {
  entity: EntityView; draft: MaterialDraft; buffer: DraftBuffer; snapshot: DraftSnapshot; workspace: Workspace;
  templates?: TemplateCatalogView | undefined; busy: boolean; onCollapse(): void;
  onBindTemplate(templateId: string): void; onResolve(body: string, metadata: MaterialMetadata, actualHash: string): void;
  children?: ReactNode;
}) {
  const [preview, setPreview] = useState(true)
  const deferredBody = useDeferredValue(snapshot.body)
  const cards = useMemo(() => {
    let ordinal = 0
    return splitSections(deferredBody).map(section => ({ ...section, ordinal: section.title ? ++ordinal : 0, entries: listItemCount(section.body) }))
  }, [deferredBody])
  const templateSections = useMemo(() => cards.length ? [] : splitSections(workspace.template.body).map(section => section.title).filter(Boolean), [cards.length, workspace.template.body])
  const editable = !workspace.readOnly && workspace.repair?.status !== 'active'
  const syncState = workspace.readOnly ? `固定版本 v${entity.materialVersion}`
    : snapshot.saving ? '正在保存本地草稿…'
    : snapshot.error ? snapshot.error
    : snapshot.dirty ? '有未保存输入' : '本地草稿已保存'
  return <section className={css.specPanel} aria-label="场景契约">
    <header className={css.panelBar}>
      <div className={css.panelIdentity}>
        <span className={css.assetIcon}>MD</span>
        <strong className={css.panelPath}>{draft.path}</strong>
        <span className={css.syncState} data-state={snapshot.error ? 'error' : snapshot.dirty || snapshot.saving ? 'pending' : 'synced'}><i />{syncState}</span>
      </div>
      <div className={css.panelActions}>
        <div className={css.segmented} role="group" aria-label="文档视图">
          <button aria-pressed={preview} onClick={() => setPreview(true)}>预览</button>
          <button aria-pressed={!preview} onClick={() => setPreview(false)}>源码</button>
        </div>
        <button onClick={() => exportMarkdown(snapshot.metadata.title, snapshot.body)} title="导出 Markdown 文件">导出</button>
        {!workspace.readOnly && <button className={css.primary} disabled={busy || !editable || snapshot.saving || !!snapshot.conflict || !snapshot.dirty} onClick={() => void buffer.flush()}>{snapshot.error ? '重试保存' : '保存'}</button>}
        <button onClick={onCollapse} title="收起契约规范">收起</button>
      </div>
    </header>
    <div className={css.specBody}>
      <ScenarioFrontmatter entity={entity} buffer={buffer} snapshot={snapshot} readOnly={workspace.readOnly} editingDisabled={workspace.repair?.status === 'active'} templates={templates} busy={busy} onBindTemplate={onBindTemplate} />
      <ScenarioConflict draft={draft} snapshot={snapshot} busy={busy} onResolve={onResolve} />
      {preview ? <div className={css.specSections}>
        {cards.map((card, key) => <section className={css.specSection} key={key}>
          {card.ordinal > 0 && <header className={css.sectionHead}><span className={css.sectionIndex}>{String(card.ordinal).padStart(2, '0')}</span><h3>{card.title}</h3>{card.entries > 0 && <small>{card.entries} 条</small>}</header>}
          <div className={css.sectionBody}><MarkdownText text={card.body} labels={markdownLabels} /></div>
        </section>)}
        {!cards.length && <section className={css.specSection}>
          <header className={css.sectionHead}><h3>还没有正文</h3><small>{templateSections.length} 个模板章节</small></header>
          <div className={css.sectionBody}><p className={css.muted}>当前材料正文为空。按模板章节补充内容，或与左侧 AI 讨论并通过写入提议更新整篇正文。</p><ul className={css.templateSections}>{templateSections.map(title => <li key={title}>{title}</li>)}</ul></div>
        </section>}
      </div> : <label className={css.bodyLabel}>场景 Markdown<textarea className={css.materialBody} spellCheck={false} readOnly={!editable} aria-label="场景 Markdown 正文" value={snapshot.body} onChange={event => buffer.edit({ body: event.target.value, metadata: snapshot.metadata })} /></label>}
    </div>
    {children}
  </section>
}
