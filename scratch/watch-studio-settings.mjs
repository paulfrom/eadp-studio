/** Watch the open Studio settings section until it leaves the loading state, or the deadline reports a failure. */
const endpoint = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const targets = await (await fetch(`${endpoint}/json`)).json()
const page = targets.find(target => target.type === 'page' && target.url.includes('dsh-app'))
if (!page) throw new Error('no dsh-app page')
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
  socket.addEventListener('error', () => reject(new Error('cdp connect failed')), { once: true })
})
const evaluate = async expression => {
  const id = ++sequence
  const result = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return result.result.value
}
const section = () => evaluate(`(() => {
  const active = [...document.querySelectorAll('[class*=section]')].map(node => node.innerText).filter(text => text && (text.includes('登录') || text.includes('连接状态') || text.includes('正在读取')))
  return active.join(' ||| ').slice(0, 400)
})()`)

const started = Date.now()
let last = ''
for (;;) {
  const text = await section()
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  if (text !== last) { console.log(`${elapsed}s: ${text.replace(/\n/g, ' / ')}`); last = text }
  if (text && !text.includes('正在读取') && !text.includes('正在从本机工作台服务读取状态')) { console.log(`${elapsed}s: settled`); break }
  if (Date.now() - started > 60_000) { console.log('still loading after 60s'); break }
  await new Promise(resolve => setTimeout(resolve, 1000))
}
socket.close()
