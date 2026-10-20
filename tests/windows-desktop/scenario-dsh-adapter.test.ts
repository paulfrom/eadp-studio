import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { studioToolGuard } from '../../packages/studio-plugin/src/host/adapters/platform/execution-guard.ts'

const mocks = {
  '@deepseek-ai/dsh-llm': 'export const createUserMessage = value => value; export const ReasoningEffortId = value => value',
  '@deepseek-ai/dsh-agent': 'export const installModelSelection = () => () => {}',
  '@deepseek-ai/dsh-office-to-pdf': 'export const OfficeSourceKey = value => value',
}
const hook = registerHooks({ resolve(specifier, context, next) {
  const source = mocks[specifier as keyof typeof mocks]
  return source ? { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true } : next(specifier, context)
} })
const { DshTaskSessions } = await import('../../packages/studio-plugin/src/host/adapters/dsh/sessions.ts')
const { readScenarioSource } = await import('../../packages/studio-plugin/src/host/adapters/dsh/scenario-sources.ts')
hook.deregister()

function pdf(text: string): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : ''
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let content = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(content.length); content += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = content.length
  content += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  content += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(content)
}

test('source reading uses real PDF text coverage, handles scanned pages and Office service honestly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-source-reader-'))
  try {
    const source = path.join(root, 'source')
    const ctx = { get: () => undefined } as never
    await writeFile(source, '第一行\n第二行')
    assert.equal((await readScenarioSource(ctx, { path: source, name: '需求.md' })).status, 'read')
    await writeFile(source, pdf('Actual PDF evidence'))
    const parsed = await readScenarioSource(ctx, { path: source, name: '需求.pdf' })
    assert.equal(parsed.status, 'partial'); assert.deepEqual(parsed.ranges, ['page:1']); assert.match(parsed.text, /Actual PDF evidence/)
    assert.match(parsed.error!, /图片.*未读取/)
    await writeFile(source, pdf(''))
    const scanned = await readScenarioSource(ctx, { path: source, name: '扫描.pdf' })
    assert.equal(scanned.status, 'failed'); assert.deepEqual(scanned.ranges, [])
    assert.equal((await readScenarioSource(ctx, { path: source, name: '资料.docx' })).status, 'failed')
    let conversions = 0
    const office = { get: () => ({ convert: async (request: any) => {
      conversions++; assert.equal(request.extension, 'docx')
      const input = await request.source.read(new AbortController().signal, 1024)
      assert.equal(input.version, request.source.version); assert.deepEqual(input.bytes, new Uint8Array(await readFile(source)))
      return { pdf: pdf('Converted Office evidence'), missingFonts: [] }
    } }) } as never
    const converted = await readScenarioSource(office, { path: source, name: '资料.docx' })
    assert.equal(conversions, 1); assert.match(converted.text, /Converted Office evidence/)
    const image = await readScenarioSource(ctx, { path: source, name: '截图.png' })
    assert.equal(image.status, 'failed'); assert.match(image.error!, /read_image/)
    await writeFile(source, Buffer.from([0xff, 0xfe, 0x00, 0x00]))
    assert.equal((await readScenarioSource(ctx, { path: source, name: '损坏.txt' })).status, 'failed')
    assert.equal((await readScenarioSource(ctx, { path: source, name: '损坏.pdf' })).status, 'failed')
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const scenarioRepair of [false, true]) for (const restored of [false, true]) test(`${restored ? 'restored' : 'new'} scenario ${scenarioRepair ? 'repair' : 'material'} uses its own native preset and retains the selected model`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-scenario-native-'))
  const releases: Array<() => void> = [], emitted: unknown[] = []
  const handlers = new Map<string, (...args: any[]) => any>()
  let contextText: () => string = () => '', latest = 'first MD and template'
  let eventListener: (session: any, event: any) => void = () => {}
  const scope = { systemPrompt: { section: () => {}, context: (value: any) => { assert.equal(value.required, true); contextText = value.text } },
    on: (name: string, listener: any) => { handlers.set(name, listener); return () => {} },
    effect: (register: () => () => void) => { releases.push(register()) } }
  const agent = { session: { header: { cwd: root } }, ctx: scope, followup: () => {} }
  const ctx = {
    on: (name: string, listener: any) => { if (name === 'session/event') eventListener = listener; return () => {} }, effect: () => {},
    agentDefaultModel: { currentSelection: () => ({ provider: 'native', model: 'native' }) },
    agentPresets: { resolve: async (id: string) => { assert.equal(id, 'eadp-scenario'); return { id } }, mount: async (_scope: unknown, id: string) => { assert.equal(id, 'eadp-scenario') } },
    sessionProjections: { restore: () => ({ snapshot: { values: { agentPreset: 'standard', modelSelection: { next: { provider: 'configured-provider', model: 'configured-native-model' } } } } }) },
    sessionController: { inspect: async () => { if (!restored) throw new Error('new'); return { meta: {}, events: [], inheritedEventCount: 0 } } },
    agents: { get: () => undefined,
      create: async ({ setup, meta, agentOptions }: any) => { assert.equal(restored, false); assert.equal(meta.agentPreset, 'eadp-scenario'); assert.deepEqual(agentOptions, { provider: 'native', model: 'native' }); await setup(scope, agent); return { agent, dispose: async () => {} } },
      resume: async ({ setup, agentOptions }: any) => { assert.equal(restored, true); assert.deepEqual(agentOptions, { provider: 'configured-provider', model: 'configured-native-model' }); await setup(scope, agent); return { agent, dispose: async () => {} } },
    },
  }
  const external = path.join(path.dirname(root), `${path.basename(root)}-image.png`)
  const sessions = new DshTaskSessions(ctx as never, '', async (_id, output) => { emitted.push(output) }, async (_task, signal) => { signal.throwIfAborted(); return { text: latest, readPaths: [external] } })
  try {
    await mkdir(path.join(root, '场景')); await writeFile(path.join(root, '场景', 'scenario.md'), '# draft')
    await sessions.open({ projectId: 'p', entityId: 'scenario', purpose: scenarioRepair ? 'review' : 'material', scenarioRepair, sessionId: 's', inputHash: '', worktree: root }, 'read only', undefined)
    for (const name of ['write', 'edit', 'bash']) assert.ok(studioToolGuard({ name, arguments: { file_path: '场景/scenario.md' }, agent }))
    assert.equal(studioToolGuard({ name: 'read_image', arguments: { file_path: '场景/scenario.md' }, agent }), undefined)
    assert.ok(studioToolGuard({ name: 'read_image', arguments: { file_path: '../outside.png' }, agent }))
    const request = handlers.get('agent/request')!
    await writeFile(external, 'imported source outside Git')
    assert.ok(studioToolGuard({ name: 'read_image', arguments: { file_path: external }, agent }))
    const callConfig = { model: 'native-selected-model' }
    assert.equal(await request({ signal: new AbortController().signal }, async () => callConfig), callConfig)
    assert.equal(contextText(), latest)
    assert.equal(studioToolGuard({ name: 'read_image', arguments: { file_path: external }, agent }), undefined)
    assert.ok(studioToolGuard({ name: 'write', arguments: { file_path: external }, agent }))
    assert.ok(studioToolGuard({ name: 'glob', arguments: { path: path.dirname(root) }, agent }))
    latest = 'changed MD, template, selected evidence'
    await request({ signal: new AbortController().signal }, async () => callConfig)
    assert.equal(contextText(), latest)
    const aborted = AbortSignal.abort(new Error('cancelled'))
    await assert.rejects(request({ signal: aborted }, async () => { throw new Error('must not route') }), /cancelled/)
    eventListener({ id: 's' }, { type: 'tool/call', data: { name: 'read_image', callId: 'image', arguments: '{"file_path":"资料/photo.png"}' } })
    eventListener({ id: 's' }, { type: 'tool/result', data: { message: { toolCallId: 'image', content: [{ type: 'image', attachment: { attachmentId: 'actual', width: 20, height: 10 } }] } } })
    assert.deepEqual(emitted, [{ kind: 'source-read', path: '资料/photo.png', attachmentId: 'actual', ranges: ['image:1 (20×10); attachment:actual'] }])
    eventListener({ id: 's' }, { type: 'tool/call', data: { name: 'read_image', callId: 'failed', arguments: '{"file_path":"资料/photo.png"}' } })
    eventListener({ id: 's' }, { type: 'tool/result', data: { message: { toolCallId: 'failed', isError: true, content: [{ type: 'text', text: 'model does not support images' }] } } })
    assert.equal(emitted.length, 1)
  } finally { await sessions.dispose(); for (const release of releases.reverse()) release(); await rm(root, { recursive: true, force: true }); await rm(external, { force: true }) }
})
