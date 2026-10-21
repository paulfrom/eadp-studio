/** Cold-start timeline: re-dispatch the settings event until the section exists, then follow it to a verdict. */
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sample = () => evaluate(`JSON.stringify({
  page: Math.round(performance.now()),
  shell: Boolean(document.body && document.body.innerText.includes('项目工作台')),
  section: (() => {
    const text = [...document.querySelectorAll('[class*=section]')].map(node => node.innerText).join(' | ')
    if (text.includes('无法获取登录状态')) return 'error'
    if (text.includes('退出登录')) return 'signed-in'
    if (text.includes('登录协同工作台')) return 'signed-out'
    if (text.includes('正在读取')) return 'loading'
    return 'absent'
  })(),
  panel: document.body && document.body.innerText.includes('@songlin.liu') ? 'data' : 'empty',
})`)

const started = Date.now()
let last = ''
let lastDispatch = 0
for (;;) {
  if (Date.now() - started > 300_000) { console.log('gave up'); break }
  let current
  try { current = JSON.parse(await sample()) } catch { await sleep(1000); continue }
  if (!current.shell) { await sleep(500); continue }
  if (current.section === 'absent' && Date.now() - lastDispatch > 3000) {
    lastDispatch = Date.now()
    await evaluate("window.dispatchEvent(new CustomEvent('eadp:open-settings', { detail: { section: 'studio-collab' } })), 'opened'")
  }
  const line = `${current.page}ms section=${current.section} panel=${current.panel}`
  if (line !== last) { console.log(line); last = line }
  if (current.section === 'error' || current.section === 'signed-in' || current.section === 'signed-out') break
  await sleep(500)
}
socket.close()
