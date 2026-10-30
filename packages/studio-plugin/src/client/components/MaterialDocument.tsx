import { useDeferredValue, useMemo, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EntityView, MaterialDraft } from '../../shared/studio.ts'
import { exportMarkdown, listItemCount, markdownLabels, sectionSummary, splitSections } from '../scenarios/document.ts'
import { MaterialActionMenu } from './MaterialActionMenu.tsx'
import css from '../studio.module.css'
import doc from './document.module.css'

/** File identity, save feedback and view controls shared by material documents. */
export function DocumentToolbar({ draft, title, body, preview, syncState, state, readOnly, saveDisabled, onPreview, onSave, onCollapse, retry }: {
  draft: MaterialDraft; title: string; body: string; preview: boolean; syncState: string;
  state: 'error' | 'pending' | 'synced'; readOnly: boolean; saveDisabled: boolean; retry: boolean;
  onPreview(preview: boolean): void; onSave(): void; onCollapse(): void;
}) {
  const filename = draft.path.replaceAll('\\', '/').split('/').slice(-2).join('/')
  return <header className={doc.toolbar}>
    <span className={css.assetIcon}>MD</span>
    <span className={doc.filename} title={draft.path}>{filename}</span>
    <span className={`${css.syncState} ${doc.sync}`} data-state={state} title={syncState} role="status" aria-live="polite"><i aria-hidden="true" />{syncState}</span>
    <div className={`${css.segmented} ${doc.views}`} role="group" aria-label="文档视图">
      <button aria-pressed={preview} onClick={() => onPreview(true)}>预览</button>
      <button aria-pressed={!preview} onClick={() => onPreview(false)}>源码</button>
    </div>
    <MaterialActionMenu label="文档操作" actions={[{ id: 'export', label: '导出 Markdown', run: () => exportMarkdown(title, body) }]} />
    {!readOnly && <button className={doc.save} disabled={saveDisabled} onClick={onSave}>{retry ? '重试保存' : '保存'}</button>}
    <button className={doc.collapse} onClick={onCollapse} aria-label="收起文档预览" title="收起文档预览">›</button>
  </header>
}

/** Compact facts from the live document and its recorded audit metadata. */
export function DocumentMeta({ entity, body, readOnly, confirmedAt, recoveryLabel }: {
  entity: EntityView; body: string; readOnly: boolean; confirmedAt?: string | undefined; recoveryLabel?: string | undefined;
}) {
  const timestamp = readOnly ? confirmedAt ?? entity.current?.confirmedAt : entity.lastEditor?.at ?? entity.creator?.at
  const time = timestamp ? new Date(timestamp) : undefined
  const timeLabel = time && !Number.isNaN(time.valueOf()) ? time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : undefined
  return <div className={doc.metadata} aria-label="文档版本信息">
    <span>{recoveryLabel ?? (readOnly ? `固定版本 v${entity.materialVersion}` : entity.materialVersion > 0 ? `v${entity.materialVersion} · 修订草稿` : '本地草稿')}</span>
    <span>{Array.from(body.replace(/\s/gu, '')).length.toLocaleString('zh-CN')} 字</span>
    {timeLabel && <time dateTime={timestamp} title={timestamp}>{timeLabel} 更新</time>}
    <span>作者 {entity.creator?.name ?? `#${entity.authorId}`}</span>
  </div>
}

/** One independently collapsible business section with an always visible summary. */
function DocumentSection({ title, body, ordinal, initialOpen }: { title: string; body: string; ordinal: number; initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  const entries = listItemCount(body)
  if (!title) return <div className={doc.preamble}><MarkdownText text={body} labels={markdownLabels} /></div>
  return <details className={doc.section} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className={doc.number}>{String(ordinal).padStart(2, '0')}</span>
      <span className={doc.title} title={title}>{title}</span>
      <span className={doc.summary} title={sectionSummary(body)}>{sectionSummary(body)}</span>
      {entries > 0 && <span className={doc.count}>{entries} 条</span>}
      <span className={doc.chevron} aria-hidden="true">⌄</span>
    </summary>
    <div className={doc.sectionBody}><MarkdownText text={body} labels={markdownLabels} /></div>
  </details>
}

/** Renders the same section navigation and empty template outline for both material kinds. */
export function DocumentSections({ body, templateBody, materialLabel }: { body: string; templateBody: string; materialLabel: string }) {
  const deferredBody = useDeferredValue(body)
  const sections = useMemo(() => splitSections(deferredBody), [deferredBody])
  const flowIndex = sections.findIndex(section => /流程/.test(section.title))
  const firstOpen = flowIndex >= 0 ? flowIndex : sections.findIndex(section => section.title)
  let ordinal = 0
  return <div className={doc.sections} aria-label="文档章节">
    {sections.map((section, index) => <DocumentSection key={`${index}-${section.title}`} {...section} ordinal={section.title ? ++ordinal : 0} initialOpen={index === firstOpen || /待澄清/.test(section.title)} />)}
    {!sections.length && <section className={doc.empty}>
      <strong>还没有正文</strong>
      <p>按模板章节补充{materialLabel}内容，或与左侧 AI 讨论后审阅写入提议。</p>
      <ul>{splitSections(templateBody).filter(section => section.title).map((section, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span>{section.title}</li>)}</ul>
    </section>}
  </div>
}
