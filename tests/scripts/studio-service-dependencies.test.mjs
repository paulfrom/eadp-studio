import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Studio declares all native session services used for durable prompt delivery', async () => {
  const entry = await readFile(new URL('../../packages/studio-plugin/src/host/index.ts', import.meta.url), 'utf8')
  const sessions = await readFile(new URL('../../packages/studio-plugin/src/host/adapters/dsh/sessions.ts', import.meta.url), 'utf8')
  const declared = entry.match(/export const inject = \[(.*?)\]/s)?.[1] ?? ''
  for (const service of ['attachments', 'sessions', 'agents', 'agentPresets', 'agentDefaultModel', 'sessionController', 'sessionProjections']) {
    assert.ok(declared.includes(`'${service}'`), `Missing required service ${service}`)
  }
  assert.match(sessions, /this\.ctx\.attachments\.admitPromptContent/)
})
