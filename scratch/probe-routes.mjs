/** Compare the studio command route with other Host routes through the desktop protocol forwarder. */
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
const probe = (label, path, init) => evaluate(`(async () => {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch(${JSON.stringify(path)}, { ...${JSON.stringify(init)}, signal: controller.signal })
    const body = await response.text()
    return ${JSON.stringify(label)} + ': ' + response.status + ' in ' + Math.round(performance.now() - started) + 'ms body=' + body.slice(0, 120).replace(/\\n/g, ' ')
  } catch (error) {
    return ${JSON.stringify(label)} + ': ' + (error.name === 'AbortError' ? 'ABORTED after ' + Math.round(performance.now() - started) + 'ms' : 'failed ' + error.message) 
  } finally { clearTimeout(timer) }
})()`)

console.log(await probe('GET unknown', 'dsh-app://app/api/__probe__', { method: 'GET' }))
console.log(await probe('POST unknown', 'dsh-app://app/api/__probe__', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))
console.log(await probe('GET studio', 'dsh-app://app/api/studio/command', { method: 'GET' }))
console.log(await probe('POST studio', 'dsh-app://app/api/studio/command', { method: 'POST', body: JSON.stringify({ command: { action: 'state' } }), headers: { 'content-type': 'application/json' } }))
socket.close()
