import type { MaterialDraft, TaskView } from '../../shared/studio.ts'

/** Keep a generated handoff tied to the prototype baseline selected for its task. */
export function assertHandoffSource(task: TaskView, draft: MaterialDraft): void {
  if (!task.handoff) return
  const source = draft.metadata.kind === 'handoff' ? draft.metadata.prototypeBaseline : undefined
  if (!source || source.baselineId !== task.handoff.baselineId || source.commitSha !== task.handoff.commitSha) {
    throw new Error('交接草稿的原型基线与任务来源不一致，请保留草稿并核对来源')
  }
}
