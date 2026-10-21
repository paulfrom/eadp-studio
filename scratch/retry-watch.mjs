/** After a cold-start deadline, retry the shared read and follow both surfaces until one reports data. */
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

console.log('retry:', await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find(node => node.innerText.trim() === '重试')
  if (!button) return 'no retry button'
  button.click()
  return 'clicked at ' + Math.round(performance.now()) + 'ms'
})()`))
let last = ''
const started = Date.now()
for (;;) {
  if (Date.now() - started > 120_000) { console.log('stop: 120s without data'); break }
  const sample = JSON.parse(await evaluate(`JSON.stringify({
    page: Math.round(performance.now()),
    section: (() => {
      const text = [...document.querySelectorAll('[class*=section]')].map(node => node.innerText).join(' | ')
      if (text.includes('无法获取登录状态')) return 'error'
      if (text.includes('退出登录')) return 'signed-in'
      if (text.includes('登录协同工作台')) return 'signed-out'
      if (text.includes('正在读取')) return 'loading'
      return 'absent'
    })(),
    panel: document.body.innerText.includes('@songlin.liu') ? 'data' : 'empty',
  })`))
  const line = `${sample.page}ms section=${sample.section} panel=${sample.panel}`
  if (line !== last) { console.log(line); last = line }
  if (sample.section === 'signed-in' || sample.section === 'signed-out') break
  await sleep(1000)
}
socket.close()
