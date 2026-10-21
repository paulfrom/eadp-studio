/** Dump the renderer's transport/connection facts. */
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(target => target.type === 'page' && target.url.includes('dsh-app'))
const socket = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.error) request.reject(new Error(message.error.message))
  else request.resolve(message.result)
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('cdp failed')), { once: true })
})
const evaluate = async expression => {
  const id = ++sequence
  const result = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (result.exceptionDetails) return `EXCEPTION ${result.exceptionDetails.exception?.description}`
  return result.result.value
}
console.log('transport:', await evaluate(`(() => {
  const transport = window.__DSH_TRANSPORT__
  if (!transport) return 'none'
  const describe = value => value === null || typeof value !== 'object' ? String(value) : Array.isArray(value) ? \`[\${value.length}]\` : Object.keys(value).join(',')
  return typeof transport === 'object' ? Object.keys(transport).map(key => key + '=' + describe(transport[key])).join(' | ') : String(transport)
})()`))
console.log('recovery:', await evaluate(`JSON.stringify(window.__DSH_CONNECTION_RECOVERY__ ?? null).slice(0, 800)`))
console.log('resources:', await evaluate(`performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /stream|rpc|remote|api|sse|events/i.test(name)).slice(0, 12).join('\\n')`))
socket.close()
