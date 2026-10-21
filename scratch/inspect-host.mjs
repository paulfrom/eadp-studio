/** Evaluate an expression in a Node inspector target (default: the desktop Host on 9230). */
const endpoint = process.env.INSPECT_ENDPOINT ?? 'http://127.0.0.1:9230'
const expression = process.argv[2] ?? 'Object.keys(globalThis).slice(0, 40)'
const targets = await (await fetch(`${endpoint}/json`)).json()
const target = targets.find(entry => entry.type === 'node')
if (!target) throw new Error(`no node target at ${endpoint}`)
const socket = new WebSocket(target.webSocketDebuggerUrl)
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
  socket.addEventListener('error', () => reject(new Error('cdp connect failed')), { once: true })
})
const id = ++sequence
const result = await new Promise((resolve, reject) => {
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }))
})
if (result.exceptionDetails) console.log('EXCEPTION:', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
console.log(JSON.stringify(result.result?.value ?? result.result?.description ?? result, null, 2).slice(0, 4000))
socket.close()
