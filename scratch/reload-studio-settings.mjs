/** Reload the renderer, then time how long the Studio settings section takes to leave its loading state. */
const endpoint = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const targets = await (await fetch(`${endpoint}/json`)).json()
const page = targets.find(target => target.type === 'page' && target.url.includes('dsh-app'))
if (!page) throw new Error('no dsh-app page')
const socket = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
const events = []
let sequence = 0
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
    events.push(`${message.params.type}: ${message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 300)}`)
  }
  if (message.method === 'Runtime.exceptionThrown') events.push(`exception: ${(message.params.exceptionDetails.exception?.description ?? '').slice(0, 400)}`)
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
const send = (method, params = {}) => {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return result.result.value
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await send('Runtime.enable')
await send('Page.enable')
const started = Date.now()
await send('Page.reload', { ignoreCache: false })
// Wait for the shell, then open the Studio settings section.
for (;;) {
  if (Date.now() - started > 60_000) throw new Error('renderer did not come back')
  try {
    if (await evaluate("document.body.innerText.includes('项目工作台')")) break
  } catch { /* context swaps during reload */ }
  await sleep(400)
}
console.log(`shell ready after ${((Date.now() - started) / 1000).toFixed(1)}s`)
await evaluate("window.dispatchEvent(new CustomEvent('eadp:open-settings', { detail: { section: 'studio-collab' } })), 'opened'")
const opened = Date.now()
let last = ''
for (;;) {
  const text = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[class*=section]')].map(node => node.innerText).filter(text => text && (text.includes('正在读取') || text.includes('登录协同') || text.includes('无法获取')))
    return nodes.join(' ||| ').replace(/\\n/g, ' / ').slice(0, 300)
  })()`)
  const elapsed = ((Date.now() - opened) / 1000).toFixed(1)
  if (text !== last) { console.log(`${elapsed}s: ${text}`); last = text }
  if (text && !text.includes('正在读取') && !text.includes('正在从本机')) { console.log(`settled after ${elapsed}s`); break }
  if (Date.now() - opened > 40_000) { console.log('still loading after 40s'); break }
  await sleep(500)
}
console.log('--- console errors/warnings ---')
for (const event of events.slice(0, 20)) console.log(event)
socket.close()
