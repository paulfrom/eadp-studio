import { STUDIO_MODEL_SELECTION_FIXTURE_EDITS } from './model-selection-fixture-edits.mjs'

/** Share one scope-owned model-switch notice listener across official selection installers. */
const selectionEdit = {
  file: 'packages/core/agent/src/model-selection.ts',
  apply(source) {
    const notice = `  const disposeNotice = agentCtx.on(
    'agent/pre-step',
    async ({ agent, messages, signal, step }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      // The loop skips an empty first step and an emptied offered continuation.
      if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision
      const selected = selection.assembled
      const previous = agent.session.requestHeader()?.config
      if (selected === undefined || previous === undefined || sameRoute(selected, previous)) return decision
      return { ...decision, messages: [...decision.messages, modelSwitchNotice(previous, selected)] }
    },
    { prepend: true },
  )`
    const finalNotice = notice
      .replace('const disposeNotice = agentCtx.on(', 'const dispose = agentCtx.on(')
      .replace('async ({ agent, messages, signal, step }', 'async ({ agent, messages, signal, step, assembly }')
      .replace('      const selected = selection.assembled', '      const { provider, model } = assembly.variables\n      if (!provider || !model) return decision\n      const selected = { provider, model }')
    const editedNotice = [
      "  let sharedNotice = modelSelectionNotices.get(agentCtx)",
      "  if (sharedNotice === undefined) {",
      finalNotice.split('\n').map(line => '  ' + line).join('\n'),
      "    sharedNotice = { count: 0, dispose }",
      "    modelSelectionNotices.set(agentCtx, sharedNotice)",
      "  }",
      "  const notice = sharedNotice",
      "  notice.count += 1",
      "  let released = false",
    ].join('\n')
    const beforeDispose = `  return () => {
    disposeAssembly()
    disposeRequest()
    disposeNotice()
  }`
    const afterDispose = `  const disposeSelection = () => {
    if (released) return
    released = true
    disposeAssembly()
    disposeRequest()
    notice.count -= 1
    if (notice.count === 0) {
      modelSelectionNotices.delete(agentCtx)
      notice.dispose()
    }
  }
  agentCtx.effect(() => disposeSelection, 'agent: model selection')
  return disposeSelection`
    return applyAnchors(source, [
      ['  assembled: ModelSelection | undefined\n}\n\nfunction sameRoute', '  assembled: ModelSelection | undefined\n}\n\nconst modelSelectionNotices = new WeakMap<Context, { count: number; dispose: () => void }>()\n\nfunction sameRoute'],
      [notice, editedNotice],
      [beforeDispose, afterDispose],
    ])
  },
}

/** Final assembly facts must reach notice handlers, including middleware that awaited during selection. */
export const STUDIO_MODEL_SELECTION_EDITS = [
  selectionEdit,
  {
    file: 'packages/core/agent/src/runtime-types.ts',
    apply(source) {
      return applyAnchors(source, [
        ["import type {} from '@deepseek-ai/dsh-system-prompt'", "import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'"],
        ["    'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>", "    'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal; assembly: PromptAssembly }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>"],
        ['     * @param payload.messages - messages removed from the inbox for this step.\n     * @param payload.turn', '     * @param payload.messages - messages removed from the inbox for this step.\n     * @param payload.assembly - final prompt assembly for this step.\n     * @param payload.turn'],
      ])
    },
  },
  {
    file: 'packages/core/agent-loop/src/agent.ts',
    apply(source) {
      return applyAnchors(source, [["      'agent/pre-step', { messages: claimed, ...position, signal },", "      'agent/pre-step', { messages: claimed, ...position, signal, assembly },"]])
    },
  },
  ...STUDIO_MODEL_SELECTION_FIXTURE_EDITS,
]

function applyAnchors(source, anchors) {
  const exact = (anchor) => source.split(anchor).length === 2
  if (anchors.every(([before, after]) => exact(after) && !source.includes(before))) return source
  if (!anchors.every(([before, after]) => exact(before) && !source.includes(after))) throw new Error('Studio model-selection edit anchor missing, duplicated, or partially applied.')
  return anchors.reduce((value, [before, after]) => value.replace(before, after), source)
}
