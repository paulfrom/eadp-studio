/** Read every Studio settings section from the shared projection. */
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
const read = () => evaluate(`(() => {
  const text = [...document.querySelectorAll('[class*=section]')].map(node => node.innerText).join(' | ')
  return text.replace(/\\n/g, ' / ').slice(0, 420)
})()`)

for (const [id, label] of [['studio-collab', '协同账号'], ['studio-connection', '协同连接'], ['studio-about', '关于'], ['studio-appearance', '外观']]) {
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('button, [role=tab], a')].find(node => node.innerText.trim() === ${JSON.stringify(label)})
    if (tab) tab.click()
    return 'clicked'
  })()`)
  await sleep(700)
  console.log(`${label}: ${await read()}`)
}
socket.close()
