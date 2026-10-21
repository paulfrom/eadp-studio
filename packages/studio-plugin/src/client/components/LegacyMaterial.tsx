import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EntityView } from '../../shared/studio.ts'
import { markdownLabels } from '../scenarios/document.ts'
import css from '../studio.module.css'

/**
 * Read-only view of an accepted material whose document predates the current
 * contract. The accepted bytes are shown exactly as they were accepted; no
 * editor, confirmation, review or reuse entry point is offered here.
 * @param entity - entity carrying `legacyCurrent`.
 * @param body - accepted fixed body already read locally, when available.
 */
export function LegacyMaterial({ entity, body }: { entity: EntityView; body?: string | undefined }) {
  const legacy = entity.legacyCurrent!
  return <div className={`${css.workspace} ${css.materialWorkspace}`}><section className={css.taskArea}>
    <div className={css.taskHeader}><div><span className={css.eyebrow}>{entity.code ?? entity.id}</span><h2>{entity.title}</h2></div><span className={css.statusPill}><i />旧契约 · 只读</span></div>
    <div className={css.notice}>该材料的已接受版本早于当前项目契约（{legacy.reason}），只能只读查看，不能编辑、确认、评审或复用。固定版本 <code>{legacy.fixed.commitSha.slice(0, 12)}</code> · {legacy.fixed.path}</div>
    {body ? <article aria-label="固定正文"><MarkdownText text={body} labels={markdownLabels} /></article> : <div className={css.empty}>固定正文正在后台同步，请稍后重新读取。</div>}
  </section></div>
}
