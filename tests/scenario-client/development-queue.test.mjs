import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test, { afterEach } from 'node:test'

const repo = path.resolve(import.meta.dirname, '../..')
const client = path.join(repo, 'packages/studio-plugin/src/client')
const buildRequire = createRequire(path.join(repo, '.local/build/dsh/package.json'))
const reactRequire = createRequire(buildRequire.resolve('@testing-library/react'))
const ts = buildRequire('typescript')
const { JSDOM } = buildRequire('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
for (const name of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = reactRequire('react')
const { render, fireEvent, within, waitFor, cleanup } = buildRequire('@testing-library/react')
afterEach(cleanup)

const modules = new Map()
function loadClient(relative) {
  const filename = path.resolve(client, relative)
  if (modules.has(filename)) return modules.get(filename).exports
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText
  const module = { exports: {} }
  modules.set(filename, module)
  new Function('require', 'module', 'exports', compiled)(specifier => {
    if (specifier.endsWith('.css')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
    if (specifier.startsWith('.')) return loadClient(path.relative(client, path.resolve(path.dirname(filename), specifier)))
    return reactRequire(specifier)
  }, module, module.exports)
  return module.exports
}

const { DevelopmentQueue } = loadClient('prototype/DevelopmentQueue.tsx')
const h = React.createElement
const entities = [
  { id: 'req-1', kind: 'requirement', code: 'REQ-0001', title: '采购订单' },
  { id: 'req-2', kind: 'requirement', code: 'REQ-0002', title: '审批记录' },
  { id: 'req-3', kind: 'requirement', code: 'REQ-0003', title: '供应商目录' },
]
const item = (number, overrides = {}) => ({
  projectId: 'project-1', prototypeTaskId: `task-${number}`, title: `事项 ${number}`, requirementId: `req-${number}`,
  taskStatus: 'active', localDispatchState: 'queued', developmentRequirementIds: [`req-${number}`],
  developmentStage: 'queued', reviewStatus: 'pending', ...overrides,
})
const success = items => ({ ok: true, state: { prototypeQueue: { revision: 1, items } } })

function renderQueue(items, call = async () => success(items)) {
  const props = {
    queue: { revision: 1, items }, items, entities, selectedTaskId: items[0]?.prototypeTaskId,
    busy: false, error: '', call, onSelect() {}, onMove() {},
  }
  return { view: render(h(DevelopmentQueue, props)), props }
}

test('the queue shows requirement identities and Host development stages without blocking the next requirement', () => {
  const stages = ['queued', 'claiming', 'sending', 'developing', 'fixing', 'commit-known', 'pushing', 'pushed', 'synchronizing', 'awaiting-review', 'confirming', 'reviewed', 'blocked']
  const labels = ['等待开发', '领取开发占用', '发送开发指令', '开发中', '工程修复', '提交已固定', '推送成果', '已推送待同步', '后端同步', '待核对', '确认并同步', '已完成', '恢复／失败待处理']
  for (const [index, stage] of stages.entries()) {
    const current = renderQueue([item(1, { developmentStage: stage, reviewStatus: stage === 'awaiting-review' ? 'awaiting-review' : stage === 'reviewed' ? 'reviewed' : 'pending' })])
    assert.ok(current.view.getByText('REQ-0001 · 采购订单'))
    assert.ok(current.view.getAllByText(labels[index]).length > 0, stage)
    current.view.unmount()
  }
  const { view } = renderQueue([
    item(1, { developmentStage: 'awaiting-review', reviewStatus: 'awaiting-review', localDispatchState: 'awaiting-user' }),
    item(2, { developmentStage: 'developing', localDispatchState: 'running' }),
  ])
  assert.ok(view.getByText('REQ-0002 · 审批记录'))
  assert.ok(view.getByText('开发中'))
  assert.match(view.container.textContent, /单项进入待核对不会阻断后续需求/)
  assert.doesNotMatch(view.container.textContent, /自动(?:生成|形成|创建)[^。]*(?:基线|baseline)|自动上传[^。]*(?:接受|baseline)/i)
})

test('a supplemental task without a requirement development record stays identifiable and has no review gate', () => {
  const { view } = renderQueue([item(1, { title: '补充整理', requirementId: undefined, developmentStage: undefined, reviewStatus: undefined })])
  assert.ok(view.getByText('补充整理'))
  assert.ok(view.getByText('补充事项'))
  assert.ok(view.getByText('未进入逐需求核对'))
  assert.equal(view.queryByRole('button', { name: '确认完成' }), null)
  assert.doesNotMatch(view.container.textContent, /undefined/)
})

test('a failed correction keeps its instruction and operation id and shows the Host conflict message', async () => {
  const calls = []
  const items = [item(1, { developmentStage: 'awaiting-review', reviewStatus: 'awaiting-review' })]
  const call = async command => {
    calls.push(command)
    return calls.length === 1 ? { ok: false, code: 'OCCUPIED', message: '已在开发中' } : success(items)
  }
  const { view } = renderQueue(items, call)
  const input = view.getByRole('textbox', { name: '纠偏 REQ-0001 · 采购订单' })
  fireEvent.change(input, { target: { value: '保留订单审批历史' } })
  fireEvent.click(view.getByRole('button', { name: '发送纠偏' }))
  await waitFor(() => assert.equal(view.getByRole('alert').textContent, '已在开发中'))
  assert.equal(input.value, '保留订单审批历史')
  fireEvent.click(view.getByRole('button', { name: '发送纠偏' }))
  await waitFor(() => assert.equal(calls.length, 2))
  assert.equal(calls[0].action, 'correctPrototypeRequirement')
  assert.equal(calls[0].prototypeTaskId, 'task-1')
  assert.equal(calls[0].instruction, '保留订单审批历史')
  assert.equal(calls[1].operationId, calls[0].operationId)
  assert.equal(input.value, '保留订单审批历史')
  assert.ok(view.getByText('纠偏已提交；开发完成后仍需核对本项成果。'))
})

test('first review confirmation uses the dedicated command and displays the returned sync state', async () => {
  const calls = []
  const initial = [item(1, { developmentStage: 'awaiting-review', reviewStatus: 'awaiting-review' })]
  const reviewed = [item(1, { developmentStage: 'reviewed', reviewStatus: 'reviewed', nextAction: '后端已核验并解除占用' })]
  const call = async command => { calls.push(command); return success(reviewed) }
  const { view } = renderQueue(initial, call)
  fireEvent.click(view.getByRole('button', { name: '确认完成' }))
  await waitFor(() => assert.ok(view.getByText('Host 返回：已完成 · 已确认完成 · 后端已核验并解除占用')))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'confirmPrototypeRequirement')
  assert.equal(calls[0].prototypeTaskId, 'task-1')
  assert.ok(calls[0].operationId)
})

test('a corrected requirement returns to review and exposes final confirmation again', async () => {
  const calls = []
  const awaiting = [item(1, { developmentStage: 'awaiting-review', reviewStatus: 'awaiting-review' })]
  const correcting = [item(1, { developmentStage: 'developing', reviewStatus: 'correcting', localDispatchState: 'running' })]
  const call = async command => { calls.push(command); return success(correcting) }
  const { view, props } = renderQueue(awaiting, call)
  fireEvent.change(view.getByRole('textbox', { name: '纠偏 REQ-0001 · 采购订单' }), { target: { value: '补充退回原因' } })
  fireEvent.click(view.getByRole('button', { name: '发送纠偏' }))
  await waitFor(() => assert.equal(calls.length, 1))
  view.rerender(h(DevelopmentQueue, { ...props, queue: { revision: 2, items: correcting }, items: correcting }))
  assert.equal(view.queryByRole('button', { name: '确认完成' }), null)
  assert.ok(view.getByText('纠偏开发中'))
  view.rerender(h(DevelopmentQueue, { ...props, queue: { revision: 3, items: awaiting }, items: awaiting }))
  fireEvent.click(view.getByRole('button', { name: '确认完成' }))
  await waitFor(() => assert.equal(calls.length, 2))
  assert.equal(calls[1].action, 'confirmPrototypeRequirement')
  assert.ok(view.getByRole('textbox', { name: '纠偏 REQ-0001 · 采购订单' }).value, '补充退回原因')
})

test('the workbench removes the manual saved-instruction path while keeping session, preview and code surfaces', () => {
  const source = readFileSync(path.join(client, 'prototype/PrototypeWorkbench.tsx'), 'utf8')
  assert.doesNotMatch(source, /继续已保存的指令|resumePrototypeQueueItem|continuePrototypeCollaboration/)
  assert.match(source, /aria-label="对话记录"/)
})
