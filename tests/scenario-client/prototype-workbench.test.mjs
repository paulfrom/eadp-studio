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

dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
let mounts = 0
const filesProps = []
function FilesStub(props) { React.useEffect(() => { mounts += 1 }, []); filesProps.push(props); return h('div', { 'data-testid': 'files' }, 'File view') }
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
    if (specifier.endsWith('/PrototypeFiles.tsx')) return { PrototypeFiles: FilesStub }
    if (specifier.endsWith('/PrototypePreview.tsx')) return { PrototypePreview: () => h('div', null, 'Preview') }
    if (specifier.endsWith('/PrototypeEditor.tsx')) return { PrototypeComparison: () => null }
    if (specifier.startsWith('.')) return loadClient(path.relative(client, path.resolve(path.dirname(filename), specifier)))
    return reactRequire(specifier)
  }, module, module.exports)
  return module.exports
}

const { PrototypeWorkbench } = loadClient('prototype/PrototypeWorkbench.tsx')
const h = React.createElement
const task = { projectId: 'p', prototypeTaskId: 't', title: '采购事项', taskStatus: 'active', localDispatchState: 'queued', developmentRequirementIds: ['r'], developmentStage: 'queued' }
const state = { project: { id: 'p', name: '采购项目' }, prototypeQueue: { revision: 1, selectedTaskId: 't', items: [task] } }
function setup(overrides = {}) {
  const commands = [], opened = []
  const props = { state: { ...state, ...overrides }, entities: [{ id: 'r', code: 'REQ-1', kind: 'requirement', title: '订单', confirmationStatus: 'confirmed' }], busy: false, call: async command => { commands.push(command); return { ok: true, prototypeConversation: [] } }, registerFlush() {}, flushBeforeLeave: async () => true, onOpenRequirement: id => opened.push(id), onDraftChange() {} }
  return { view: render(h(PrototypeWorkbench, props)), commands, opened, props }
}
test('design toolbar opens requirement, queue and diagnostic drawers without inline diagnostics', async () => {
  const { view, opened } = setup()
  await waitFor(() => assert.ok(view.getByText('暂无会话消息。')))
  assert.equal(view.queryByText('事项技术诊断'), null)
  fireEvent.click(view.getByRole('button', { name: /^需求集合 1$/ }))
  const collection = view.getByRole('dialog', { name: '需求集合' })
  fireEvent.click(within(collection).getByRole('button', { name: 'REQ-1 · 订单' }))
  assert.deepEqual(opened, ['r'])
  fireEvent.click(within(collection).getByRole('button', { name: '关闭面板' }))
  fireEvent.click(view.getByRole('button', { name: /我的事项与队列/ }))
  const queue = view.getByRole('dialog', { name: '我的事项与队列' })
  assert.match(queue.textContent, /采购事项/)
  fireEvent.click(within(queue).getByRole('button', { name: '关闭面板' }))
  fireEvent.click(view.getByRole('button', { name: '现场详情' }))
  assert.ok(view.getByRole('dialog', { name: '诊断信息' }))
  assert.ok(view.getByText('事项技术诊断'))
})
test('mode switches preserve file buffers and more-menu comparison reaches the file view', async () => {
  const before = mounts
  const { view } = setup()
  await waitFor(() => assert.ok(view.getByText('暂无会话消息。')))
  fireEvent.click(view.getByRole('tab', { name: /代码/ }))
  fireEvent.click(view.getByRole('tab', { name: /预览/ }))
  fireEvent.click(view.getByRole('tab', { name: /代码/ }))
  assert.equal(mounts, before + 1)
  fireEvent.click(view.getByLabelText('更多操作'))
  fireEvent.click(view.getByRole('menuitem', { name: '变更对比' }))
  assert.equal(filesProps.at(-1).requestDiff, 1)
  assert.equal(view.getByRole('tab', { name: /代码/ }).getAttribute('aria-selected'), 'true')
})
test('run, check and restart actions dispatch real Host commands for the selected task', async () => {
  const { view, commands, props } = setup()
  fireEvent.click(view.getByRole('button', { name: /^运行$/ }))
  await waitFor(() => assert.ok(commands.some(c => c.action === 'startProjectPrototypePreview' && c.prototypeTaskId === 't' && c.operationId)))
  fireEvent.click(view.getAllByRole('button', { name: /^工程检查$/ })[0])
  await waitFor(() => assert.ok(commands.some(c => c.action === 'checkProjectPrototype' && c.prototypeTaskId === 't' && c.operationId)))
  view.rerender(h(PrototypeWorkbench, { ...props, state: { ...state, prototypePreviews: [{ prototypeTaskId: 't', identity: 'preview-1', url: 'http://127.0.0.1:1234' }] } }))
  fireEvent.click(view.getByRole('button', { name: /^停止$/ }))
  await waitFor(() => assert.ok(commands.some(c => c.action === 'stopProjectPrototypePreview')))
})

test('composer sends Enter once, preserves Shift Enter and blocks blank or busy dispatch', async () => {
  const { view, commands, props } = setup()
  await waitFor(() => assert.ok(view.getByText('暂无会话消息。')))
  const textbox = view.getByRole('textbox', { name: '描述需要调整的内容' })
  fireEvent.change(textbox, { target: { value: '补充审批记录' } })
  fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })
  assert.equal(commands.filter(c => c.action === 'startPrototypeCollaboration').length, 0)
  fireEvent.keyDown(textbox, { key: 'Enter' })
  await waitFor(() => assert.equal(commands.filter(c => c.action === 'startPrototypeCollaboration').length, 1))
  await waitFor(() => assert.equal(textbox.value, ''))
  fireEvent.keyDown(textbox, { key: 'Enter' })
  assert.equal(commands.filter(c => c.action === 'startPrototypeCollaboration').length, 1)
  fireEvent.change(textbox, { target: { value: '忙碌期间保留' } })
  view.rerender(h(PrototypeWorkbench, { ...props, busy: true }))
  fireEvent.keyDown(textbox, { key: 'Enter' })
  assert.equal(commands.filter(c => c.action === 'startPrototypeCollaboration').length, 1)
  assert.equal(textbox.value, '忙碌期间保留')
})
