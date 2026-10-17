import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { CollaborationSession } from '../../packages/studio-plugin/src/host/adapters/collaboration/session.ts'
import { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { SecretStore } from '../../packages/studio-plugin/src/host/adapters/platform/credentials.ts'

const token = `studio_${'a'.repeat(43)}`, nextToken = `studio_${'b'.repeat(43)}`
const user = { id: 1, username: 'tester', name: '测试用户', email: 'tester@example.test', admin: true, gitlabUserId: 17, gitlabUsername: 'liu', gitlabEmail: 'liu@example.test' }
const profile = { user, gitlabOrigin: 'http://gitlab.example.test' }
const result = { ...profile, token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
const json = (value: object, status = 200) => new Response(JSON.stringify(value), { status })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
class Secrets implements SecretStore {
  value: unknown
  async read(key: string) { assert.equal(key, 'collaboration-session'); return this.value }
  async write(key: string, value: unknown) { assert.equal(key, 'collaboration-session'); this.value = value }
  async delete(key: string) { assert.equal(key, 'collaboration-session'); this.value = undefined }
}

test('login sends the password once to the backend, stores only its session and returns a safe identity', async () => {
  const credentials = new Secrets(), calls: string[] = []
  const session = new CollaborationSession('http://studio.example.test', credentials, async (url, init) => {
    calls.push(String(url)); assert.equal(init!.redirect, 'error')
    if (String(url).endsWith('/login')) { assert.deepEqual(JSON.parse(String(init!.body)), { username: 'tester', password: 'fixture-password' }); return json(result) }
    assert.equal(new Headers(init!.headers).get('authorization'), `Bearer ${token}`); return json(profile)
  })
  assert.deepEqual(await session.login('tester', 'fixture-password'), profile)
  assert.equal(JSON.stringify(credentials.value).includes('fixture-password'), false)
  assert.equal(JSON.stringify(await session.current()).includes(token), false)
  assert.equal(await session.getAccessToken(), token)
  assert.deepEqual(calls, ['http://studio.example.test/v1/auth/login', 'http://studio.example.test/v1/me'])
})

test('invalid credentials and malformed sessions never persist a password or token', async () => {
  for (const response of [json({ error: { message: 'fixture-password' } }, 401), json({ ...result, token: 'not-a-studio-session' }), json({ ...result, user: { ...user, email: undefined } })]) {
    const credentials = new Secrets(), session = new CollaborationSession('http://studio.example.test', credentials, async () => response)
    await assert.rejects(session.login('tester', 'fixture-password'), error => !String(error).includes('fixture-password'))
    assert.equal(credentials.value, undefined)
  }
})

test('expired and backend-revoked sessions clear local credentials and require login', async () => {
  const credentials = new Secrets()
  credentials.value = { origin: 'http://studio.example.test', token, expiresAt: new Date(Date.now() - 1).toISOString(), userId: 1 }
  const session = new CollaborationSession('http://studio.example.test', credentials, async () => json({}, 401))
  await assert.rejects(session.getAccessToken(), /过期/); assert.equal(credentials.value, undefined)
  credentials.value = { origin: 'http://studio.example.test', token, expiresAt: result.expiresAt, userId: 1 }
  assert.equal(await session.current(), undefined); assert.equal(credentials.value, undefined)
})

test('logout revokes the backend session and clears this device even when revocation is unknown', async () => {
  for (const online of [true, false]) {
    const credentials = new Secrets(); credentials.value = { origin: 'http://studio.example.test', token, expiresAt: result.expiresAt, userId: 1 }
    const session = new CollaborationSession('http://studio.example.test', credentials, async (url, init) => {
      assert.equal(String(url), 'http://studio.example.test/v1/auth/logout'); assert.equal(init!.method, 'POST')
      assert.equal(credentials.value, undefined)
      if (!online) throw new Error('network')
      return new Response(null, { status: 204 })
    })
    if (online) await session.logout(); else await assert.rejects(session.logout(), /撤销结果未知/)
    assert.equal(credentials.value, undefined)
  }
})

test('logout cancels a late login response so a session cannot reappear', async () => {
  const credentials = new Secrets(), response = deferred<Response>()
  const session = new CollaborationSession('http://studio.example.test', credentials, async () => response.promise)
  const login = session.login('tester', 'fixture-password'), rejected = assert.rejects(login, /取消/)
  await setImmediate(); await session.logout(); response.resolve(json(result)); await rejected
  assert.equal(credentials.value, undefined)
})

test('API 401 removes only the matching session and presents a fixed login error', async () => {
  const credentials = new Secrets(), session = new CollaborationSession('http://studio.example.test', credentials, async () => json(result))
  await session.login('tester', 'fixture-password')
  const client = new CollaborationClient('http://studio.example.test', () => session.getAccessToken(), value => session.invalidateToken(value), async () => json({ error: { message: 'private remote body' } }, 401))
  await assert.rejects(client.request('GET', '/v1/projects'), error => { assert.match(String(error), /重新登录/); assert.equal(String(error).includes('private remote body'), false); return true })
  assert.equal(credentials.value, undefined)
  credentials.value = { origin: 'http://studio.example.test', token: nextToken, expiresAt: result.expiresAt, userId: 1 }
  await session.invalidateToken(token); assert.equal(await session.getAccessToken(), nextToken)
})

test('backend identity must match the saved collaboration user', async () => {
  const credentials = new Secrets(); credentials.value = { origin: 'http://studio.example.test', token, expiresAt: result.expiresAt, userId: 1 }
  const session = new CollaborationSession('http://studio.example.test', credentials, async () => json({ ...profile, user: { ...user, id: 2 } }))
  await assert.rejects(session.current(), /身份不一致/); assert.equal(credentials.value, undefined)
})

test('login distinguishes timeout, connection, response and local storage failures without exposing their cause', async () => {
  const privateText = 'PRIVATE_PASSWORD_TOKEN_ERROR'
  for (const scenario of [
    { request: async () => { throw new DOMException(privateText, 'TimeoutError') }, expected: /请求超时/ },
    { request: async () => { throw new Error(privateText) }, expected: /请求未完成/ },
    { request: async () => json({ ...result, token: privateText }), expected: /响应无效/ },
  ]) {
    const session = new CollaborationSession('http://studio.example.test', new Secrets(), scenario.request)
    await assert.rejects(session.login('tester', 'fixture-password'), error => {
      assert.match(String(error), scenario.expected); assert.match(String(error), /http:\/\/studio\.example\.test/)
      assert.equal(String(error).includes(privateText), false); return true
    })
  }
  const credentials = new Secrets()
  credentials.write = async () => { throw new Error(privateText) }
  const session = new CollaborationSession('http://studio.example.test', credentials, async () => json(result))
  await assert.rejects(session.login('tester', 'fixture-password'), error => {
    assert.match(String(error), /本机安全凭据存储/); assert.match(String(error), /HTTP 200/)
    assert.equal(String(error).includes(privateText), false); return true
  })
})
