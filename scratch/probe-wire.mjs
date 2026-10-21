/** Capture the exact wire request the Studio section sends when it retries. */
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
console.log('retry:', await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find(node => node.innerText.trim() === '重试')
  if (!button) return 'no retry button: ' + [...document.querySelectorAll('button')].map(node => node.innerText.trim()).join('|')
  button.click()
  return 'clicked'
})()`))
await sleep(6000)
for (const event of events) {
  const params = event.params
  if (event.method === 'Network.requestWillBeSent' && params.request.url.includes('/api/')) {
    console.log('REQUEST', params.request.method, params.request.url)
    console.log('headers', JSON.stringify(params.request.headers))
    console.log('postData', String(params.request.postData ?? '').slice(0, 400))
    console.log('hasPostData', params.request.hasPostData, 'mixedContentType', params.request.mixedContentType, 'type', params.type)
  }
  if (event.method === 'Network.requestWillBeSentExtraInfo') console.log('extraRequestHeaders', JSON.stringify(params.headers))
  if (event.method === 'Network.responseReceived' && params.response.url.includes('/api/')) console.log('RESPONSE', params.response.status, JSON.stringify(params.response.headers))
  if (event.method === 'Network.responseReceivedExtraInfo' && String(params.headers?.[':status'] ?? '').length) console.log('extraResponseHeaders', JSON.stringify(params.headers))
  if (event.method === 'Network.loadingFailed') console.log('FAILED', params.errorText, params.blockedReason ?? '', params.corsErrorStatus ? JSON.stringify(params.corsErrorStatus) : '')
}
socket.close()
