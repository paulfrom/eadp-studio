import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { ConsistencyModelInput } from '../../packages/studio-plugin/src/shared/consistency.ts'

// Resolve the actual staged DSH runtime, including its native BlockAssembler;
// the only mock is the provider stream, so assembly behavior stays upstream's.
const nativeRequire = createRequire(path.resolve(import.meta.dirname, '../../.local/build/dsh/packages/preset/agent-preset-registry/package.json'))
const llmUrl = pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-llm')).href
const hook = registerHooks({ resolve(specifier, context, next) { return specifier === '@deepseek-ai/dsh-llm' ? { url: llmUrl, shortCircuit: true } : next(specifier, context) } })
const { compareLocalMaterials } = await import('../../packages/studio-plugin/src/host/adapters/dsh/consistency.ts').finally(() => hook.deregister())

type Chunk = Record<string, unknown>
type StreamOptions = { signal: AbortSignal; tools: unknown[]; messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>; [key: string]: unknown }
type Stream = (options: StreamOptions) => AsyncIterable<Chunk>
const content = '当前本机正文：退回后允许重新提交。'
const input: ConsistencyModelInput = { targetId: 'scene', coverage: 'complete', limitations: [], materials: [{ entityId: 'scene', kind: 'scenario', path: '场景/审批.md', relation: 'target', state: 'current-file', text: content, sha256: createHash('sha256').update(content).digest('hex') }] }
const resultText = JSON.stringify({ summary: '本次已读范围未发现冲突', conflicts: [] })
const textChunks: Chunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: resultText.slice(0, 15) }, { type: 'text-delta', index: 0, text: resultText.slice(15) }, { type: 'block-end', index: 0, block: { type: 'text', text: resultText } }]
const chunks = (values: Chunk[]): Stream => async function* () { yield* values }

function fixture(stream: Stream) {
  let selections = 0
  const prepared: Array<{ selection: Record<string, unknown>; signal: AbortSignal }> = [], requested: StreamOptions[] = [], unexpected: string[] = []
  const current = { provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high' }
  const resolved = { provider: 'normalized-provider', model: 'normalized-model', reasoningEffort: 'high', maxTokens: 8192 }
  const services = { agentDefaultModel: { currentSelection() { selections++; return current } }, llm: {
    async prepareCall(selection: Record<string, unknown>, signal: AbortSignal) {
      prepared.push({ selection, signal }); signal.throwIfAborted()
      return { config: resolved, stream(options: StreamOptions) { requested.push(options); return stream(options) } }
    },
  } }
  const context = new Proxy(services, { get(target, key: string) {
    if (key !== 'agentDefaultModel' && key !== 'llm') { unexpected.push(key); throw new Error(`One-shot comparison cannot access ${key}`) }
    return target[key]
  } })
  return { context, prepared, requested, current, resolved, unexpected, selections: () => selections }
}

test('DSH comparison uses the selected model and native text assembly with zero tools or durable conversation identity', async () => {
  const f = fixture(chunks([
    ...textChunks,
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: 'PRIVATE-REASONING-CONTENT' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]))
  const signal = new AbortController().signal
  assert.equal(await compareLocalMaterials(f.context as never, input, signal), resultText)
  assert.equal(f.selections(), 1)
  assert.deepEqual(f.prepared[0]!.selection, { ...f.current, maxTokens: 8192 })
  assert.equal(f.prepared[0]!.signal, signal)
  const request = f.requested[0]!
  for (const [key, value] of Object.entries(f.resolved)) assert.equal(request[key], value)
  assert.equal(request.signal, signal)
  assert.deepEqual(request.tools, [])
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }])
  assert.equal(JSON.parse(request.messages[0]!.content[0]!.text).materials[0].sha256, createHash('sha256').update(content).digest('hex'))
  for (const field of ['sessionId', 'session', 'agent', 'agentId', 'source', 'id']) {
    assert.equal(field in request, false)
    assert.equal(field in request.messages[0]!, false)
  }
  assert.deepEqual(f.unexpected, [], 'session, Agent creation and log services remain inaccessible')
})

for (const kind of ['tool-calls', 'max-tokens', 'error', 'aborted']) test(`a ${kind} finish cannot become a completed comparison even with complete-looking JSON`, async () => {
  const f = fixture(chunks([...textChunks, { type: 'finish', reason: { kind, ...(kind === 'error' || kind === 'aborted' ? { failure: { kind: 'unknown', message: 'PRIVATE-PROVIDER-DETAIL' } } : {}) } }]))
  await assert.rejects(compareLocalMaterials(f.context as never, input, new AbortController().signal), /未产生完整文本结果/)
  assert.deepEqual(f.unexpected, [])
})

test('a provider tool-call block is rejected even when the provider declares a stop finish', async () => {
  const f = fixture(chunks([...textChunks,
    { type: 'tool-call-delta', index: 1, id: 'provider-call', name: 'bash', argumentsDelta: '{"command":"touch forbidden"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]))
  await assert.rejects(compareLocalMaterials(f.context as never, input, new AbortController().signal), /未产生完整文本结果/)
  assert.deepEqual(f.requested[0]!.tools, [])
  assert.deepEqual(f.unexpected, [])
})

test('an unterminated stream cannot turn the native assembler default finish into a completed comparison', async () => {
  const f = fixture(chunks(textChunks))
  await assert.rejects(compareLocalMaterials(f.context as never, input, new AbortController().signal), /未产生完整文本结果/)
})

test('provider stream errors reject the call instead of returning the partial text', async () => {
  const providerError = new Error('provider stream failed')
  const f = fixture(async function* () { yield* textChunks; throw providerError })
  await assert.rejects(compareLocalMaterials(f.context as never, input, new AbortController().signal), error => error === providerError)
})

test('the same abort signal reaches preparation and streaming and cancels a pending provider iterator', async () => {
  const controller = new AbortController(), reason = new DOMException('用户取消', 'AbortError')
  let started!: () => void, closed = false
  const streaming = new Promise<void>(resolve => { started = resolve })
  const f = fixture(async function* (options) {
    try {
      yield textChunks[0]!
      started()
      await new Promise<never>((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    } finally { closed = true }
  })
  const comparison = compareLocalMaterials(f.context as never, input, controller.signal)
  await streaming
  controller.abort(reason)
  await assert.rejects(comparison, error => error === reason)
  assert.equal(f.prepared[0]!.signal, controller.signal)
  assert.equal(f.requested[0]!.signal, controller.signal)
  assert.equal(closed, true)
  assert.deepEqual(f.unexpected, [])
})
