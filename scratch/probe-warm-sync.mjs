/** Time a warm projection read and watch whether the sync indicator clears. */
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

console.log('warm direct read:', await evaluate(`(async () => {
  const started = performance.now()
  const response = await fetch('api/studio/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'probe-' + Math.round(started), method: 'studio/command', payload: { args: { command: { action: 'state' } } } }),
  })
  const text = await response.text()
  return response.status + ' in ' + Math.round(performance.now() - started) + 'ms len=' + text.length
})()`))

await evaluate(`(() => {
  const tab = [...document.querySelectorAll('button, [role=tab], a')].find(node => node.innerText.trim() === '协同连接')
  if (tab) tab.click()
  return 'clicked'
})()`)
for (let index = 0; index < 12; index += 1) {
  await sleep(500)
  const text = await evaluate(`[...document.querySelectorAll('[class*=section]')].map(node => node.innerText).join(' | ')`)
  console.log(`${(index + 1) * 500}ms syncing=${text.includes('正在同步')} connected=${text.includes('已连接')}`)
}
socket.close()
