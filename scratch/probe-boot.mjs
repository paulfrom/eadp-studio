/** Check the renderer's boot facts and whether the Host web server still answers. */
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
console.log('boot keys:', await evaluate('Object.keys(window.__DSH_BOOT__ ?? {}).join(",")'))
console.log('stream:', await evaluate('String(window.__DSH_BOOT__?.streamBaseUrl)'))
console.log('harness globals:', await evaluate('Object.keys(window).filter(key => /dsh|remote|gateway|connection|cordis/i.test(key)).join(",")'))
console.log('http ping:', await evaluate(`(async () => { const t = performance.now(); try { const r = await fetch(location.origin + '/', { method: 'GET', cache: 'no-store' }); return \`\${r.status} in \${Math.round(performance.now() - t)}ms\` } catch (error) { return 'failed ' + error.message } })()`))
socket.close()
