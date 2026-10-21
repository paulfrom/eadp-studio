/** Trigger the settings retry and record every network request the renderer makes while it waits. */
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
const clicked = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find(node => node.innerText.trim() === '重试')
  if (!button) return 'no retry button: ' + [...document.querySelectorAll('button')].map(node => node.innerText.trim()).join('|')
  button.click()
  return 'clicked'
})()`)
console.log('retry:', clicked)
const started = Date.now()
await sleep(8000)
console.log('--- network events ---')
for (const event of events) {
  const params = event.params
  if (event.method === 'Network.requestWillBeSent') console.log(`${((Date.now() - started) / 1000).toFixed(1)}s request ${params.request.method} ${params.request.url.slice(0, 120)}`)
  if (event.method === 'Network.responseReceived') console.log(`${((Date.now() - started) / 1000).toFixed(1)}s response ${String(params.response.status)} ${params.response.url.slice(0, 120)}`)
  if (event.method === 'Network.loadingFailed') console.log(`${((Date.now() - started) / 1000).toFixed(1)}s failed ${params.errorText} ${params.requestId}`)
}
console.log('--- section text ---')
console.log(await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('[class*=section]')].map(node => node.innerText).filter(text => text && (text.includes('正在读取') || text.includes('登录') || text.includes('无法获取')))
  return nodes.join(' ||| ').replace(/\\n/g, ' / ').slice(0, 300)
})()`))
socket.close()
