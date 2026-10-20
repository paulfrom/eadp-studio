import { useEffect, useRef, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import { markdownLabels, readTemplateFile } from '../scenarios/document.ts'
import css from './sections.module.css'

type TemplateInput = { id: string; name: string; body: string }

/** Edits project templates inside DSH's native settings section; publication is an explicit second action. */
export function ScenarioTemplateSettings({ state, call, onState }: { state: StudioState; call(command: StudioCommand): Promise<StudioReply>; onState(state: StudioState): void }) {
  const [templates, setTemplates] = useState<TemplateInput[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [previewSignature, setPreviewSignature] = useState('')
  const catalog = state.scenarioTemplates
  const loaded = useRef<{ projectId: string; signature: string }>()
  useEffect(() => {
    if (!catalog) return
    const incoming = catalog.templates.map(template => ({ id: template.id, name: template.name, body: template.body }))
    const projectId = state.project!.id, current = JSON.stringify({ templates, defaultId })
    const signature = JSON.stringify({ templates: incoming, defaultId: catalog.defaultTemplateId })
    if (loaded.current?.projectId === projectId && current !== loaded.current.signature && current !== signature) {
      setError('项目版本已变化，当前模板输入已保留，请核对后重新生成预览。')
      setTemplates(previous => [...previous, ...incoming.filter(template => !previous.some(item => item.id === template.id))])
      setPreviewSignature(''); return
    }
    loaded.current = { projectId, signature }
    setTemplates(incoming)
    setDefaultId(catalog.defaultTemplateId); setSelectedId(catalog.defaultTemplateId); setPreviewSignature('')
  }, [catalog?.acceptedHead, state.project?.id])
  const selected = templates.find(template => template.id === selectedId)
  const signature = JSON.stringify({ templates, defaultId })
  const run = async (command: StudioCommand) => {
    setBusy(true); setError('')
    try {
      const result = await call(command)
      if (!result.ok) { setError(result.message); return undefined }
      onState(result.state)
      window.dispatchEvent(new CustomEvent('eadp:studio-state-changed'))
      return result
    } catch (reason) { setError(reason instanceof Error ? reason.message : '模板操作失败，请核对状态后重试。'); return undefined }
    finally { setBusy(false) }
  }
  const update = (change: Partial<TemplateInput>) => setTemplates(previous => previous.map(template => template.id === selectedId ? { ...template, ...change } : template))
  if (!state.project) return <p className={css.sectionIntro}>打开项目后管理该项目的场景模板。</p>
  return <>
    <p className={css.sectionIntro}>模板保存在项目 .template/，随 Git 共享。发布新默认仅影响新建场景；已有场景须显式切换固定模板。</p>
    <div className={css.kvBlock}>{catalog?.templates.map(template => <div key={template.id} className={css.kv}><span className={css.kvK}>{template.name}{template.id === catalog.defaultTemplateId ? ' · 当前默认' : ''}</span><span className={css.kvV}>{template.fixed.commitSha.slice(0, 12)} · {template.fixed.path}</span></div>)}</div>
    <div className={css.group}><h3 className={css.groupTitle}>新增或更新模板</h3><label>模板<select disabled={busy} value={selectedId} onChange={event => setSelectedId(event.target.value)}>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label><label>上传 Markdown<input type="file" disabled={busy} accept=".md,text/markdown" onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
      setError('')
      try { const template = { id: crypto.randomUUID(), name: file.name.replace(/\.md$/i, ''), body: await readTemplateFile(file) }; setTemplates(previous => [...previous, template]); setSelectedId(template.id); if (!defaultId) setDefaultId(template.id) }
      catch { setError('模板文件读取失败，请重试。') }
    }} /></label>{selected && <><label>名称<input value={selected.name} disabled={busy} onChange={event => update({ name: event.target.value })} /></label><label>Markdown 模板<textarea rows={12} value={selected.body} disabled={busy} onChange={event => update({ body: event.target.value })} /></label><label>替换当前模板文件<input type="file" disabled={busy} accept=".md,text/markdown" onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) { try { update({ body: await readTemplateFile(file) }) } catch { setError('模板文件读取失败，请重试。') } } }} /></label></>}<label>发布后默认模板<select disabled={busy} value={defaultId} onChange={event => setDefaultId(event.target.value)}>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label><button className={css.ghostBtn} disabled={busy || !templates.length || !defaultId || templates.some(template => !template.name.trim() || !template.body.trim())} onClick={async () => { const result = await run({ action: 'previewScenarioTemplates', templates, defaultTemplateId: defaultId }); if (result) setPreviewSignature(signature) }}>生成发布预览</button></div>
    {state.templatePreview && <div className={css.group}><h3 className={css.groupTitle}>待发布预览</h3><p>预期项目版本 {state.templatePreview.expectedRevision} · 认可 Git 头 {state.templatePreview.expectedHead.slice(0, 12)}</p>{state.templatePreview.templates.map(template => <details key={template.id}><summary>{template.name}{template.id === state.templatePreview?.defaultTemplateId ? ' · 新默认' : ''}</summary><MarkdownText text={template.body} labels={markdownLabels} /></details>)}<button className={css.primaryBtn} disabled={busy || signature !== previewSignature} onClick={() => void run({ action: 'publishScenarioTemplates', operationId: state.templatePreview!.operationId })}>确认发布项目模板</button>{signature !== previewSignature && <p>内容已修改，请重新生成预览。</p>}</div>}
    {error && <p role="alert" className={css.inlineError}>{error}</p>}
  </>
}
