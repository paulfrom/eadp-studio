/** Probe the running dev desktop: open the Studio settings section and read what it renders over time. */
const endpoint = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

const targets = await (await fetch(`${endpoint}/json`)).json()
const page = targets.find(target => target.type === 'page' && target.url.includes('dsh-app'))
if (!page) throw new Error(`no dsh-app page in ${targets.map(target => `${target.type}:${target.url}`).join(', ')}`)

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

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

await evaluate("window.dispatchEvent(new CustomEvent('eadp:open-settings', { detail: { section: 'studio-collab' } })), 'opened'")
await settle(150)
const early = await evaluate('document.body.innerText')
console.log('--- 150ms after opening ---')
console.log(early.split('\n').filter(Boolean).slice(0, 40).join(' | '))
await settle(3500)
const settled = await evaluate('document.body.innerText')
console.log('--- 3.6s after opening ---')
console.log(settled.split('\n').filter(Boolean).slice(0, 60).join(' | '))
console.log('--- markers ---')
for (const marker of ['正在读取登录状态', '正在从本机工作台服务读取状态', '无法获取登录状态', '未登录协同工作台', '正在同步', '登录协同工作台', '已登录', '测试管理员']) {
  console.log(`${marker}: ${settled.includes(marker) ? 'present' : 'absent'} (early: ${early.includes(marker) ? 'present' : 'absent'})`)
}
socket.close()
