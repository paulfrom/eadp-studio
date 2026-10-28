/** Send one Studio command through the running desktop with the production request envelope. */
const command = JSON.parse(process.argv[2] ?? '{"action":"state"}')
const endpoint = process.env.STUDIO_CDP_ORIGIN ?? 'http://127.0.0.1:9222'
const targets = await (await fetch(`${endpoint}/json`)).json()
const page = targets.find(target => target.type === 'page' && target.url.includes('dsh-app'))
if (!page) throw new Error(`No desktop Studio page at ${endpoint}`)
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true })
})
const id = Math.floor(Math.random() * 1_000_000_000)
const result = new Promise((resolve, reject) => {
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id !== id) return
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  })
})
socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
  expression: `(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300000)
    try {
      const response = await fetch('api/studio/command', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'scratch-' + crypto.randomUUID(), method: 'studio/command', payload: { args: { command: ${JSON.stringify(command)} } } }),
        signal: controller.signal
      })
      const body = await response.json()
      return body.result?.value ?? body
    } finally { clearTimeout(timer) }
  })()`,
  awaitPromise: true, returnByValue: true,
} }))
const reply = await result
socket.close()
if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
const value = reply.result?.value
if (process.env.STUDIO_STATE_SUMMARY && value?.state) {
  const state = value.state
  console.log(JSON.stringify({ ok: value.ok, message: value.message, project: state.project, selectedProjectId: state.selectedProjectId,
    projects: state.projects, projectInitializations: state.projectInitializations, pending: state.pending,
    entities: state.collaboration?.entities?.map(entity => ({ id: entity.id, code: entity.code, title: entity.title, kind: entity.kind,
      confirmationStatus: entity.confirmationStatus, current: entity.current && { version: entity.current.version, fixed: entity.current.fixed } })) }, null, 2))
} else console.log(JSON.stringify(value, null, 2))
