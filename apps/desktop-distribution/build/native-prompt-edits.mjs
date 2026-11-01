/** Route native input through Studio admission before the official inbox consumes it. */
export const STUDIO_NATIVE_PROMPT_EDIT = {
  file: 'packages/api/session-controller/src/index.ts',
  apply(source) {
    const before = "    return this.commands.prompt(request, source)"
    const after = `    signal.throwIfAborted()
    if (request.sessionId.startsWith('studio-')) {
      const admission = { request, signal, handled: false, pass: false }
      await this.ctx.serial('session/prompt-admission', admission)
      if (!admission.handled && !admission.pass) throw new Error('Studio native prompt admission unavailable')
      if (admission.handled) return { accepted: true }
    }
    return this.commands.prompt(request, source)`
    const typeBefore = "  interface Context {\n    /** Host Session business API and Remote namespace owner. */"
    const typeAfter = `  interface Events {
    'session/prompt-admission'(admission: { request: SessionPromptRequest; signal: AbortSignal; handled: boolean; pass: boolean }): Promise<void>
    'session/control-admission'(admission: { sessionId: string; action: 'updateQueue' | 'cancel'; pass: boolean; execute?: () => Promise<void> }): Promise<void>
  }
  interface Context {
    /** Host Session business API and Remote namespace owner. */`
    const updateBefore = `    return this.commands.updateQueue(request)`
    const updateAfter = `    return (async () => {
      if (request.sessionId.startsWith('studio-')) {
        const admission = { sessionId: request.sessionId, action: 'updateQueue' as const, pass: false, execute: async () => { await this.commands.updateQueue(request) } }
        await this.ctx.serial('session/control-admission', admission)
        if (!admission.pass) throw new Error('Studio queue admission unavailable')
        return { accepted: true as const }
      }
      return this.commands.updateQueue(request)
    })()`
    const cancelBefore = `  cancel(request: SessionCancelRequest): SessionCancelValue {
    return this.commands.cancel(request)`
    const cancelAfter = `  async cancel(request: SessionCancelRequest): Promise<SessionCancelValue> {
    if (request.sessionId.startsWith('studio-')) {
      const admission = { sessionId: request.sessionId, action: 'cancel' as const, pass: false }
      await this.ctx.serial('session/control-admission', admission)
      if (!admission.pass) throw new Error('Studio cancel admission unavailable')
    }
    return this.commands.cancel(request)`
    const anchors = [[before, after], [typeBefore, typeAfter], [updateBefore, updateAfter], [cancelBefore, cancelAfter]]
    if (anchors.every(([, value]) => source.split(value).length === 2)) return source
    if (!anchors.every(([value]) => source.split(value).length === 2)) throw new Error('Studio native prompt admission anchor missing, duplicated, or partially applied')
    return anchors.reduce((value, [before, after]) => value.replace(before, after), source)
  },
}
