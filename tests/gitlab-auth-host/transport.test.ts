import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { CollaborationSession } from '../../packages/studio-plugin/src/host/adapters/collaboration/session.ts'
import { CollaborationClient, CollaborationError } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { CollaborationTransport } from '../../packages/studio-plugin/src/host/adapters/collaboration/transport.ts'
import type { SecretStore } from '../../packages/studio-plugin/src/host/adapters/platform/credentials.ts'

const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = createRequire(new URL('../../packages/studio-plugin/package.json', import.meta.url))('undici')
const token = `studio_${'a'.repeat(43)}`
const profile = { user: { id: 1, username: 'tester', name: '测试用户', email: 'tester@example.test', admin: true, gitlabUserId: 17, gitlabUsername: 'tester' }, gitlabOrigin: 'http://gitlab.example.test' }
const loginResult = { ...profile, token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
class Secrets implements SecretStore {
  value: unknown
  async read() { return this.value }
  async write(_key: string, value: unknown) { this.value = value }
  async delete() { this.value = undefined }
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }

test('collaboration auth and API reach their backend while ordinary fetch keeps the global proxy dispatcher', async t => {
  const requests: string[] = []
  const backend = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/auth/login') {
      let body = ''; for await (const chunk of request) body += chunk
      assert.deepEqual(JSON.parse(body), { username: 'tester', password: 'fixture-password' })
      response.end(JSON.stringify(loginResult)); return
    }
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    response.end(JSON.stringify(request.url === '/v1/me' ? profile : request.url === '/v1/projects' ? [] : { loggedOut: true }))
  })
  const origin = await listen(backend)
  t.after(() => close(backend))
  const previous = getGlobalDispatcher(), proxy = new MockAgent()
  proxy.disableNetConnect()
  proxy.get(origin).intercept({ path: '/v1/auth/login', method: 'POST' }).reply(502, '').persist()
  proxy.get('http://model.example.test').intercept({ path: '/v1/models' }).reply(200, { routedThroughProxy: true }).persist()
  setGlobalDispatcher(proxy)
  t.after(async () => { setGlobalDispatcher(previous); await proxy.close() })
  const credentials = new Secrets()
  const transport = new CollaborationTransport(origin)
  t.after(() => transport.dispose())
  const session = new CollaborationSession(origin, credentials, transport.request)
  const api = new CollaborationClient(origin, () => session.getAccessToken(), undefined, transport.request)
  assert.deepEqual(await session.login('tester', 'fixture-password'), profile)
  assert.deepEqual(await session.current(), profile)
  assert.deepEqual(await api.request('GET', '/v1/projects'), [])
  await session.logout()
  assert.equal(credentials.value, undefined)
  assert.deepEqual(requests, ['POST /v1/auth/login', 'GET /v1/me', 'GET /v1/projects', 'POST /v1/auth/logout'])
  assert.deepEqual(await (await fetch('http://model.example.test/v1/models')).json(), { routedThroughProxy: true })
  assert.equal(getGlobalDispatcher(), proxy)
})

test('configured origins stay isolated and redirects cannot forward credentials', async t => {
  let destinationRequests = 0
  const destination = createServer((_request, response) => { destinationRequests++; response.end('destination') })
  const destinationOrigin = await listen(destination)
  t.after(() => close(destination))
  const backend = createServer((_request, response) => { response.writeHead(307, { location: `${destinationOrigin}/stolen` }); response.end() })
  const origin = await listen(backend)
  t.after(() => close(backend))
  const first = new CollaborationTransport(origin), second = new CollaborationTransport(destinationOrigin)
  t.after(async () => { await first.dispose(); await second.dispose() })
  await assert.rejects(first.request(`${destinationOrigin}/v1/me`), /已配置的服务地址/)
  await assert.rejects(first.request(`${origin}/v1/auth/login`, { method: 'POST', body: 'fixture-password', redirect: 'follow' }), /fetch failed/)
  assert.equal(destinationRequests, 0)
  assert.equal(await (await second.request(`${destinationOrigin}/v1/me`)).text(), 'destination')
  assert.equal(destinationRequests, 1)
})

test('caller cancellation and disposal terminate pending collaboration requests', async t => {
  const backend = createServer(() => { /* Wait for cancellation without sending headers. */ })
  const origin = await listen(backend), transport = new CollaborationTransport(origin)
  t.after(async () => { await transport.dispose(); await close(backend) })
  const controller = new AbortController(), received = once(backend, 'request')
  const cancelled = assert.rejects(transport.request(`${origin}/v1/me`, { signal: controller.signal }), { name: 'AbortError' })
  await received; controller.abort(); await cancelled
  const nextReceived = once(backend, 'request')
  const disposed = assert.rejects(transport.request(`${origin}/v1/projects`), { name: 'AbortError' })
  await nextReceived; await transport.dispose(); await disposed
  await assert.rejects(transport.request(`${origin}/v1/me`), { name: 'AbortError' })
  assert.equal(transport.dispose(), transport.dispose())
})

test('a failed direct connection never retries through the ambient proxy', async t => {
  const backend = createServer(), origin = await listen(backend)
  await close(backend)
  const previous = getGlobalDispatcher(), proxy = new MockAgent()
  let proxyRequests = 0
  proxy.disableNetConnect()
  proxy.get(origin).intercept({ path: '/v1/me' }).reply(() => { proxyRequests++; return { statusCode: 200, data: '{}' } }).persist()
  setGlobalDispatcher(proxy)
  const transport = new CollaborationTransport(origin)
  t.after(async () => { await transport.dispose(); setGlobalDispatcher(previous); await proxy.close() })
  await assert.rejects(transport.request(`${origin}/v1/me`), /fetch failed/)
  assert.equal(proxyRequests, 0)
  assert.equal(getGlobalDispatcher(), proxy)
})

test('upstream GitLab failures show local diagnostics while other codes keep the backend message', async t => {
  const privateText = 'PRIVATE_UPSTREAM_DIAGNOSTIC'
  let code = 'GITLAB_UNAVAILABLE'
  const backend = createServer((_request, response) => {
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code, message: privateText } }))
  })
  const origin = await listen(backend), transport = new CollaborationTransport(origin)
  const api = new CollaborationClient(origin, async () => token, undefined, transport.request)
  t.after(async () => { await transport.dispose(); await close(backend) })
  await assert.rejects(api.request('GET', '/v1/projects'), error => error instanceof CollaborationError && error.code === 'GITLAB_UNAVAILABLE' && /无法访问 GitLab/.test(error.message) && !error.message.includes(privateText))
  code = 'PROJECT_REPOSITORY_CHANGED'
  await assert.rejects(api.request('GET', '/v1/projects'), error => error instanceof CollaborationError && error.code === 'PROJECT_REPOSITORY_CHANGED' && error.message === privateText)
})

test('login HTTP diagnostics show only local messages, status and configured origin', async t => {
  const privateText = 'PRIVATE_PASSWORD_TOKEN_RESPONSE_BODY'
  let status = 503, body = ''
  const backend = createServer((_request, response) => { response.writeHead(status); response.end(body) })
  const origin = await listen(backend), transport = new CollaborationTransport(origin), credentials = new Secrets()
  const session = new CollaborationSession(origin, credentials, transport.request)
  t.after(async () => { session.dispose(); await transport.dispose(); await close(backend) })
  for (const scenario of [
    { status: 401, body: privateText, expected: /用户名或密码错误/ },
    { status: 503, body: JSON.stringify({ error: { code: 'GITLAB_MANAGEMENT_DENIED', message: privateText } }), expected: /GitLab 访问凭据无效/ },
    { status: 502, body: JSON.stringify({ error: { code: 'GITLAB_UNAVAILABLE', message: privateText } }), expected: /无法访问 GitLab/ },
    { status: 503, body: JSON.stringify({ error: { code: 'ACCOUNT_NOT_INITIALIZED', message: privateText } }), expected: /账号尚未初始化/ },
    { status: 503, body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: privateText } }), expected: /协同后端暂时无法完成登录/ },
    { status: 502, body: `<html>${privateText}</html>`, expected: /协同登录失败/ },
    { status: 502, body: '', expected: /协同登录失败/ },
    { status: 503, body: JSON.stringify({ error: { code: privateText, message: privateText } }), expected: /协同登录失败/ },
    { status: 503, body: JSON.stringify({ error: { code: '__proto__', message: privateText } }), expected: /协同登录失败/ },
    { status: 503, body: privateText.repeat(70_000), expected: /协同登录失败/ },
  ]) {
    status = scenario.status; body = scenario.body
    await assert.rejects(session.login('tester', 'fixture-password'), error => {
      const message = String(error)
      assert.match(message, scenario.expected); assert.ok(message.includes(`HTTP ${status}`)); assert.ok(message.includes(origin))
      assert.equal(message.includes(privateText), false); assert.equal(message.includes('fixture-password'), false)
      assert.equal(credentials.value, undefined)
      return true
    })
  }
})
