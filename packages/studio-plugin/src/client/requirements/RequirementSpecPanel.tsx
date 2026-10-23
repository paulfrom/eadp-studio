import { useDeferredValue, useMemo, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Candidate, EntityView, MaterialDraft, MaterialMetadata, StudioCommand, StudioReply, TemplateCatalogView } from '../../shared/studio.ts'
import type { ScenarioWorkspace as Workspace } from '../../shared/scenarios.ts'
import type { DraftBuffer, DraftSnapshot } from '../scenarios/DraftBuffer.ts'
import { exportMarkdown, listItemCount, markdownLabels, splitSections } from '../scenarios/document.ts'
import { ScenarioConflict } from '../scenarios/ScenarioConflict.tsx'
import { RequirementMetadataForm, type RequirementMetadataFormHandle } from './RequirementMetadataForm.tsx'
import { RequirementSourcePanel } from './RequirementSourcePanel.tsx'
import css from '../studio.module.css'

/** Formats an audit timestamp for the frontmatter row; the raw value stays a wire format. */
const auditTime = (value: string | undefined) => value ? value.replace('T', ' ').slice(0, 19) : '—'

/** Compact identity and template metadata for the requirement document. */
function RequirementFrontmatter({ entity, buffer, snapshot, readOnly, templates, busy, onBindTemplate }: {
  entity: EntityView; buffer: DraftBuffer; snapshot: DraftSnapshot; readOnly: boolean;
  templates?: TemplateCatalogView | undefined; busy: boolean; onBindTemplate(templateId: string): void;
}) {
  const [templateId, setTemplateId] = useState('')
  const metadata = snapshot.metadata
  const edit = (change: Partial<MaterialMetadata>) => buffer.edit({ body: snapshot.body, metadata: { ...metadata, ...change } as MaterialMetadata })
  const editable = !readOnly
  const template = templates?.templates.find(item => item.id === metadata.templateId)
  const requirementCode = entity.code ?? (entity.sequence ? `#${entity.sequence}` : entity.id)
  return <section className={css.scenarioMeta} aria-label="需求身份与版本">
    <div className={css.scenarioMetaHeading}><strong>{requirementCode} · {metadata.title || entity.title}</strong><span>{readOnly ? `固定版本 v${entity.materialVersion}` : '本地草稿'}</span></div>
    <dl className={css.frontmatterRows}>
      <div><dt>名称</dt><dd>{editable
        ? <input aria-label="需求名称" value={metadata.title} onChange={event => edit({ title: event.target.value })} />
        : <span>{metadata.title}</span>}</dd></div>
      <div><dt>模板</dt><dd>{template?.name ?? metadata.templateId}{metadata.templateRef && <small>固定版本 {metadata.templateRef.path} · {metadata.templateRef.commitSha.slice(0, 12)}</small>}</dd></div>
      <div><dt>审计时间</dt><dd>{auditTime(readOnly ? entity.current?.confirmedAt : entity.lastEditor?.at ?? entity.creator?.at)}</dd></div>
    </dl>
    {editable && templates && <details className={css.templateBinding}>
      <summary>模板绑定设置</summary>
      <label>切换固定模板<select value={templateId || metadata.templateId} onChange={event => setTemplateId(event.target.value)}>{templates.templates.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === templates.defaultTemplateId ? '（项目默认）' : ''}</option>)}</select></label>
      <p className={css.muted}>切换仅更新模板绑定，正文保持原样。</p>
      <button disabled={busy || !(templateId && templateId !== metadata.templateId) || !!snapshot.conflict} onClick={() => onBindTemplate(templateId)}>切换固定模板</button>
    </details>}
  </section>
}

/**
 * Spec pane of the requirement page: the material file's frontmatter and one
 * card per business section, with source editing, business fields, export, the
 * formal source panel and the gate footer the caller composes as children.
 */
export function RequirementSpecPanel({ entity, draft, buffer, snapshot, workspace, templates, entities, projectId, candidates, busy, call, metadataForm, onFlush, onCollapse, onBindTemplate, onResolve, onOpenScenario, children }: {
  entity: EntityView; draft: MaterialDraft; buffer: DraftBuffer; snapshot: DraftSnapshot; workspace: Workspace;
  templates?: TemplateCatalogView | undefined; entities: EntityView[]; projectId: string; candidates: Candidate[];
  busy: boolean; metadataForm: Ref<RequirementMetadataFormHandle>; onFlush(): Promise<boolean>; onCollapse(): void;
  call(command: StudioCommand): Promise<StudioReply | undefined>;
  onBindTemplate(templateId: string): void; onResolve(body: string, metadata: MaterialMetadata, actualHash: string): void;
  onOpenScenario(entityId: string): void; children?: ReactNode;
}) {
  const [preview, setPreview] = useState(true)
  const [fieldError, setFieldError] = useState('')
  const deferredBody = useDeferredValue(snapshot.body)
  const cards = useMemo(() => {
    let ordinal = 0
    return splitSections(deferredBody).map(section => ({ ...section, ordinal: section.title ? ++ordinal : 0, entries: listItemCount(section.body) }))
  }, [deferredBody])
  const templateSections = useMemo(() => cards.length ? [] : splitSections(workspace.template.body).map(section => section.title).filter(Boolean), [cards.length, workspace.template.body])
  const editable = !workspace.readOnly
  const syncState = workspace.readOnly ? `固定版本 v${entity.materialVersion}`
    : snapshot.saving ? '正在保存本地草稿…'
    : snapshot.error ? snapshot.error
    : snapshot.dirty ? '有未保存输入' : '本地草稿已保存'
  return <section className={css.specPanel} aria-label="需求说明">
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
        {!workspace.readOnly && <button className={css.primary} disabled={busy || snapshot.saving || !!snapshot.conflict || !snapshot.dirty} onClick={() => void onFlush()}>{snapshot.error ? '重试保存' : '保存'}</button>}
        <button onClick={onCollapse} title="收起需求说明">收起</button>
      </div>
    </header>
    <div className={css.specBody}>
      <RequirementFrontmatter entity={entity} buffer={buffer} snapshot={snapshot} readOnly={workspace.readOnly} templates={templates} busy={busy} onBindTemplate={onBindTemplate} />
      <ScenarioConflict draft={draft} snapshot={snapshot} busy={busy} onResolve={onResolve} />
      {fieldError && <p role="alert" className={css.reviewError}>{fieldError}</p>}
      {preview ? <div className={css.specSections}>
        {cards.map((card, key) => <section className={css.specSection} key={key}>
          {card.ordinal > 0 && <header className={css.sectionHead}><span className={css.sectionIndex}>{String(card.ordinal).padStart(2, '0')}</span><h3>{card.title}</h3>{card.entries > 0 && <small>{card.entries} 条</small>}</header>}
          <div className={css.sectionBody}><MarkdownText text={card.body} labels={markdownLabels} /></div>
        </section>)}
        {!cards.length && <section className={css.specSection}>
          <header className={css.sectionHead}><h3>还没有正文</h3><small>{templateSections.length} 个模板章节</small></header>
          <div className={css.sectionBody}><p className={css.muted}>当前需求正文为空。按模板章节补充内容，或与左侧 AI 讨论并通过写入提议更新整篇正文。</p><ul className={css.templateSections}>{templateSections.map(title => <li key={title}>{title}</li>)}</ul></div>
        </section>}
      </div> : <label className={css.bodyLabel}>需求 Markdown<textarea className={css.materialBody} spellCheck={false} readOnly={!editable} aria-label="需求 Markdown 正文" value={snapshot.body} onChange={event => buffer.edit({ body: event.target.value, metadata: snapshot.metadata })} /></label>}
      <RequirementMetadataForm ref={metadataForm} hidden={preview} buffer={buffer} snapshot={snapshot} entities={entities} projectId={projectId} readOnly={workspace.readOnly} onValidityChange={setFieldError} />
      <RequirementSourcePanel entity={entity} metadata={snapshot.metadata} entities={entities} candidates={candidates} busy={busy} call={call} onOpenScenario={onOpenScenario} />
    </div>
    {children}
  </section>
}
