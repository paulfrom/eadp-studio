import { useEffect, useRef, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Candidate, EntityView, MaterialMetadata, StudioCommand, StudioReply } from '../../shared/studio.ts'
import type { RequirementSourceView } from '../../shared/requirement-workspace.ts'
import { markdownLabels } from '../scenarios/document.ts'
import css from '../studio.module.css'

/**
 * Formal scenario sources of one requirement: each pinned version links back
 * to the scenario stage, and the excerpt locations show where the source text
 * justified this requirement. Potential relations never appear here.
 */
export function RequirementSourcePanel({ entity, metadata, entities, candidates, busy, call, onOpenScenario }: {
  entity: EntityView; metadata: MaterialMetadata; entities: EntityView[]; candidates: Candidate[]; busy: boolean;
  call(command: StudioCommand): Promise<StudioReply | undefined>;
  onOpenScenario(entityId: string): void;
}) {
  const [fixedSource, setFixedSource] = useState<RequirementSourceView>()
  const [sourceError, setSourceError] = useState('')
  const [loadingSource, setLoadingSource] = useState(false)
  const requestId = useRef(0)
  const sourceKey = metadata.kind === 'requirement' ? metadata.sources.map(source => `${source.entityId}:${source.version}`).join(',') : ''
  useEffect(() => {
    requestId.current += 1; setFixedSource(undefined); setSourceError(''); setLoadingSource(false)
    return () => { requestId.current += 1 }
  }, [entity.id, sourceKey])
  const readSource = async (sourceEntityId: string, expectedVersion: number) => {
    const request = ++requestId.current
    setLoadingSource(true); setSourceError(''); setFixedSource(undefined)
    try {
      const result = await call({ action: 'readRequirementSource', entityId: entity.id, sourceEntityId, expectedVersion })
      if (request !== requestId.current) return
      if (result?.ok && result.requirementSource) setFixedSource(result.requirementSource)
      else setSourceError(result && !result.ok ? result.message : '固定来源未能读取，请重试。')
    } catch (error) { if (request === requestId.current) setSourceError(error instanceof Error ? error.message : '固定来源未能读取，请重试。') }
    finally { if (request === requestId.current) setLoadingSource(false) }
  }
  if (metadata.kind !== 'requirement') return null
  const candidate = candidates.find(value => value.selectedEntityId === entity.id)
  const excerptSources = candidate?.sources.filter(source => source.excerpts.length > 0) ?? []
  const evidenceRanges = metadata.businessEvidence.flatMap(evidence => evidence.ranges)
  return <section className={css.specSection} aria-label="来源场景">
    <header className={css.sectionHead}><h3>来源场景</h3><small>{metadata.sources.length} 项</small></header>
    {metadata.sources.length === 0 && <p className={css.muted}>尚未绑定来源场景。</p>}
    {metadata.sources.map(source => {
      const scenario = entities.find(value => value.id === source.entityId)
      const label = scenario?.builtinKey === 'general'
        ? `通用场景 · 系统内置 · 预置版本 v${source.version}`
        : `${scenario?.code ?? source.entityId} · ${scenario?.title ?? source.entityId} · 固定版本 v${source.version}`
      return <div key={source.entityId} className={css.candidateRow}><button disabled={busy} onClick={() => onOpenScenario(source.entityId)} title="打开场景当前材料"><span>{label}</span></button><button disabled={loadingSource} onClick={() => void readSource(source.entityId, source.version)}>查看固定来源 v{source.version}</button></div>
    })}
    {loadingSource && <p className={css.muted}>正在读取固定来源原文…</p>}
    {sourceError && <p role="alert" className={css.error}>{sourceError}</p>}
    {fixedSource && <section className={css.specSection} aria-label="固定来源原文">
      <header className={css.sectionHead}><h3>{fixedSource.title} · {fixedSource.builtin ? '系统内置 · ' : ''}固定版本 v{fixedSource.version}</h3><button onClick={() => setFixedSource(undefined)}>关闭固定来源</button></header>
      <p className={css.muted}>{fixedSource.fixed.path} · {fixedSource.fixed.commitSha.slice(0, 12)}</p>
      <MarkdownText text={fixedSource.body} labels={markdownLabels} />
    </section>}
    {candidate
      ? excerptSources.length > 0
        ? excerptSources.map(source => <details key={source.entityId}>
          <summary>{source.title} · 固定版本 v{source.version} · {source.excerpts.length} 处原文片段</summary>
          {source.excerpts.map((excerpt, index) => <p key={index}><small className={css.muted}>第 {excerpt.startLine}-{excerpt.endLine} 行</small><br />{excerpt.text}</p>)}
        </details>)
        : <p className={css.muted}>未记录片段定位</p>
      : evidenceRanges.length > 0
        ? <ul>{evidenceRanges.map((range, index) => <li key={index}>{range.path}:{range.startLine}-{range.endLine}</li>)}</ul>
        : <p className={css.muted}>未记录片段定位</p>}
  </section>
}
