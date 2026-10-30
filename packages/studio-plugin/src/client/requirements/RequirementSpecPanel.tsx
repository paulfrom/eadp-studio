import { useEffect, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import type { Candidate, EntityView, MaterialDraft, MaterialMetadata, StudioCommand, StudioReply, TemplateCatalogView } from '../../shared/studio.ts'
import type { ScenarioWorkspace as Workspace } from '../../shared/scenarios.ts'
import type { DraftBuffer, DraftSnapshot } from '../scenarios/DraftBuffer.ts'
import { DocumentMeta, DocumentSections, DocumentToolbar } from '../components/MaterialDocument.tsx'
import { ExternalFileNotice } from '../scenarios/ExternalFileNotice.tsx'
import { RequirementMetadataForm, type RequirementMetadataFormHandle } from './RequirementMetadataForm.tsx'
import { RequirementSourcePanel } from './RequirementSourcePanel.tsx'
import css from '../studio.module.css'
import doc from '../components/document.module.css'

/** Formats an audit timestamp for the frontmatter row; the raw value stays a wire format. */
const auditTime = (value: string | undefined) => value ? value.replace('T', ' ').slice(0, 19) : '—'

/** Compact identity and template metadata for the requirement document. */
function RequirementFrontmatter({ entity, buffer, snapshot, readOnly, templates, editingDisabled, recoveryLabel }: {
  entity: EntityView; buffer: DraftBuffer; snapshot: DraftSnapshot; readOnly: boolean;
  templates?: TemplateCatalogView | undefined; editingDisabled: boolean;
  recoveryLabel?: string | undefined;
}) {
  const metadata = snapshot.metadata
  const edit = (change: Partial<MaterialMetadata>) => buffer.edit({ body: snapshot.body, metadata: { ...metadata, ...change } as MaterialMetadata })
  const editable = !readOnly && !editingDisabled
  const template = templates?.templates.find(item => item.id === metadata.templateId)
  const requirementCode = entity.code ?? (entity.sequence ? `#${entity.sequence}` : entity.id)
  return <section className={css.scenarioMeta} aria-label="需求身份与版本">
    <div className={css.scenarioMetaHeading}><strong>{requirementCode} · {metadata.title || entity.title}</strong><span>{recoveryLabel || (readOnly ? `固定版本 v${entity.materialVersion}` : '本地草稿')}</span></div>
    <dl className={css.frontmatterRows}>
      <div><dt>名称</dt><dd>{editable
        ? <input aria-label="需求名称" value={metadata.title} onChange={event => edit({ title: event.target.value })} />
        : <span>{metadata.title}</span>}</dd></div>
      <div><dt>模板</dt><dd>{template?.name ?? metadata.templateId}{metadata.templateRef && <small>固定版本 {metadata.templateRef.path} · {metadata.templateRef.commitSha.slice(0, 12)}</small>}</dd></div>
      <div><dt>审计时间</dt><dd>{auditTime(readOnly ? entity.current?.confirmedAt : entity.lastEditor?.at ?? entity.creator?.at)}</dd></div>
    </dl>

  </section>
}

/**
 * Requirement document with collapsible sections, source editing, persistent
 * business-field validation and fixed-source inspection.
 */
export function RequirementSpecPanel({ entity, draft, buffer, snapshot, workspace, templates, entities, projectId, candidates, busy, call, metadataForm, onFlush, onCollapse, onOpenScenario, confirming = false, editRequested = 0, children }: {
  entity: EntityView; draft: MaterialDraft; buffer: DraftBuffer; snapshot: DraftSnapshot; workspace: Workspace;
  templates?: TemplateCatalogView | undefined; entities: EntityView[]; projectId: string; candidates: Candidate[];
  busy: boolean; metadataForm: Ref<RequirementMetadataFormHandle>; onFlush(): Promise<boolean>; onCollapse(): void;
  call(command: StudioCommand): Promise<StudioReply | undefined>;
  confirming?: boolean; editRequested?: number;
  onOpenScenario(entityId: string): void; children?: ReactNode;
}) {
  const [preview, setPreview] = useState(true)
  const [fieldError, setFieldError] = useState('')
  const [fieldsOpen, setFieldsOpen] = useState(false)
  useEffect(() => { if (editRequested) { setPreview(false); setFieldsOpen(true) } }, [editRequested])
  useEffect(() => { if (fieldError) setFieldsOpen(true) }, [fieldError])
  const editable = !workspace.readOnly && !confirming
  const recoveryLabel = workspace.requirementSave?.input ? '保留的未保存输入' : workspace.requirementSave || workspace.confirmationRecovery ? '本地草稿 · 保存待恢复' : undefined
  const syncState = workspace.requirementSave ? '保存未完成 · 请处理恢复选项'
    : workspace.confirmationRecovery ? '确认待继续'
    : workspace.readOnly ? `固定版本 v${entity.materialVersion}`
    : snapshot.saving ? '正在保存本地草稿…'
    : snapshot.error ? snapshot.error
    : snapshot.dirty ? '有未保存输入' : '本地草稿已保存'
  return <section className={`${css.specPanel} ${doc.panel}`} aria-label="需求说明">
    <DocumentToolbar draft={draft} title={snapshot.metadata.title} body={snapshot.body} preview={preview} syncState={syncState} state={snapshot.error || workspace.requirementSave || workspace.confirmationRecovery ? 'error' : snapshot.dirty || snapshot.saving ? 'pending' : 'synced'} readOnly={workspace.readOnly} saveDisabled={busy || confirming || snapshot.saving || !snapshot.dirty} retry={!!snapshot.error} onPreview={setPreview} onSave={() => void onFlush()} onCollapse={onCollapse} />
    <div className={`${css.specBody} ${doc.body}`}>
      {workspace.readOnly && !recoveryLabel && <div className={doc.confirmed}><span aria-hidden="true">✓</span>已确认为固定版本 v{entity.materialVersion}</div>}
      <DocumentMeta entity={entity} body={snapshot.body} readOnly={workspace.readOnly && !recoveryLabel} confirmedAt={workspace.confirmedAt} recoveryLabel={recoveryLabel} />
      <ExternalFileNotice buffer={buffer} snapshot={snapshot} readOnly={workspace.readOnly} />
      {fieldError && <div className={css.reviewError}><p role="alert">{fieldError}</p><button disabled={busy} onClick={() => setFieldsOpen(true)}>修正业务字段</button></div>}
      {preview ? <DocumentSections body={snapshot.body} templateBody={workspace.template.body} materialLabel="需求" /> : <label className={css.bodyLabel}>需求 Markdown<textarea className={css.materialBody} spellCheck={false} readOnly={!editable} aria-label="需求 Markdown 正文" value={snapshot.body} onChange={event => buffer.edit({ body: event.target.value, metadata: snapshot.metadata })} /></label>}
      <details className={doc.fields} open={fieldsOpen} onToggle={event => setFieldsOpen(event.currentTarget.open)}>
        <summary>需求信息、业务依据与关系</summary>
        <div className={doc.fieldsBody}>
          <RequirementFrontmatter entity={entity} buffer={buffer} snapshot={snapshot} readOnly={workspace.readOnly} templates={templates} editingDisabled={confirming} recoveryLabel={recoveryLabel} />
          <RequirementMetadataForm ref={metadataForm} buffer={buffer} snapshot={snapshot} entities={entities} projectId={projectId} readOnly={workspace.readOnly || confirming} onValidityChange={setFieldError} />
        </div>
      </details>
      <details className={doc.fields}><summary>固定来源与引用片段</summary><div className={doc.fieldsBody}><RequirementSourcePanel entity={entity} metadata={snapshot.metadata} entities={entities} candidates={candidates} busy={busy} call={call} onOpenScenario={onOpenScenario} /></div></details>
    </div>
    {children}
  </section>
}
