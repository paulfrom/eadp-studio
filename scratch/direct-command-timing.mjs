/** Capture the real studio command envelope from the panel refresh, then call the route directly with a long timeout. */
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(target => target.type === 'page' && target.url.includes('dsh-app'))
const socket = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
const events = []
let sequence = 0
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (message.method?.startsWith('Network.')) events.push(message)
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
const send = (method, params = {}) => {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) return `EXCEPTION ${result.exceptionDetails.exception?.description}`
  return result.result.value
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await send('Network.enable')
console.log('refresh:', await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find(node => node.innerText.trim() === '刷新')
  if (!button) return 'no refresh button'
  button.click()
  return 'clicked'
})()`))
await sleep(4000)
let postData
for (const event of events) {
  if (event.method === 'Network.requestWillBeSent' && event.params.request.url.includes('/api/')) {
    console.log('envelope:', String(event.params.request.postData ?? '').slice(0, 300))
    postData = event.params.request.postData
  }
  if (event.method === 'Network.responseReceived' && event.params.response.url.includes('/api/')) {
    console.log('response:', event.params.response.status)
  }
}
if (!postData) { console.log('no envelope captured'); socket.close(); process.exit(0) }

console.log('--- direct call with 300s timeout ---')
console.log(await evaluate(`(async () => {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 300000)
  try {
    const response = await fetch('api/studio/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(postData)}, signal: controller.signal })
    const text = await response.text()
    return response.status + ' in ' + Math.round(performance.now() - started) + 'ms body=' + text.slice(0, 200)
  } catch (error) {
    return 'failed after ' + Math.round(performance.now() - started) + 'ms: ' + error.message
  } finally { clearTimeout(timer) }
})()`))
socket.close()
