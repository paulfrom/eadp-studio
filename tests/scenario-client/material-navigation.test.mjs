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
const { render, fireEvent, within, waitFor, cleanup, act } = buildRequire('@testing-library/react')
afterEach(cleanup)

dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }

let narrow = false
const mediaListeners = new Set()
const media = { get matches() { return narrow }, addEventListener(_name, callback) { mediaListeners.add(callback) }, removeEventListener(_name, callback) { mediaListeners.delete(callback) } }
dom.window.matchMedia = () => media
const commands = []
let allowFlush = true
function Workspace(props) {
  React.useEffect(() => { props.registerFlush(async () => { commands.push({ action: 'flush' }); return allowFlush }); return () => props.registerFlush(undefined) }, [props.registerFlush])
  return h('div', null, `编辑 ${props.entity.title}`)
}
const stubs = {
  NativeConversation: () => null, ScenarioWorkspace: Workspace, RequirementWorkspace: Workspace,
  PrototypeWorkbench: () => null, MaterialEditor: () => null, ReviewPanel: () => null,
  ProjectDialog: () => null, ProjectProgressNotice: () => null,
  MaterialCatalog: props => h('div', null, ...props.entities.filter(e => e.kind === props.kind && !e.builtinKey).map(e => h('button', { key: e.id, onClick: () => props.onSelect(e.id) }, `打开 ${e.title}`))),
  StudioTopbar: props => h('button', { onClick: props.onToggleSidebar, 'aria-expanded': !props.sidebarCollapsed }, props.sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'),
}
const modules = new Map()
function loadClient(relative) {
  const filename = path.resolve(client, relative)
  if (modules.has(filename)) return modules.get(filename).exports
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename,
  }).outputText
  const module = { exports: {} }; modules.set(filename, module)
  new Function('require', 'module', 'exports', compiled)(specifier => {
    if (specifier.endsWith('.css')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
    const name = path.basename(specifier, '.tsx')
    if (stubs[name]) return { [name]: stubs[name] }
    if (specifier.startsWith('.')) return loadClient(path.relative(client, path.resolve(path.dirname(filename), specifier)))
    return reactRequire(specifier)
  }, module, module.exports)
  return module.exports
}
const { StudioPanel } = loadClient('studio/StudioPanel.tsx')
const { emptyStudioState } = loadClient('state.ts')
const h = React.createElement
function setup(isNarrow = false) {
  narrow = isNarrow; commands.length = 0; allowFlush = true
  const entities = [
    { id: 's1', kind: 'scenario', code: 'SC-0001', title: '采购下单', materialVersion: 1 },
    { id: 's2', kind: 'scenario', code: 'SC-0002', title: '采购审批与跨部门长名称完整显示验证', materialVersion: 1 },
    { id: 'builtin', kind: 'scenario', builtinKey: 'general', title: '内置通用场景' },
    { id: 'r1', kind: 'requirement', code: 'REQ-0001', title: '采购订单', materialVersion: 1 },
    { id: 'r2', kind: 'requirement', code: 'REQ-0002', title: '审批规则', materialVersion: 1 },
  ]
  const state = { ...emptyStudioState(), connected: true, project: { id: 'p', name: '采购协同', stableBranch: 'main' }, collaboration: { entities } }
  const props = { useStore: selector => selector({ projection: state, progress: [], loading: false }), sync() {}, progress() {}, openSettings() {}, startSession() {}, run: async command => {
    commands.push(command)
    if (command.action === 'openScenario') state.scenario = { entityId: command.entityId }
    if (command.action === 'openRequirement') state.requirement = { entityId: command.entityId }
    return { ok: true, state }
  } }
  return render(h(StudioPanel, props))
}
test('material subnavigation shows names, highlights the selection and preserves the flush boundary', async () => {
  const view = setup()
  fireEvent.click(view.getByRole('button', { name: '打开 采购下单' }))
  await waitFor(() => assert.ok(view.getByText('编辑 采购下单')))
  const navigation = view.getByLabelText('场景目录')
  assert.equal(within(navigation).getByRole('button', { name: 'SC-0001 · 采购下单' }).getAttribute('aria-current'), 'page')
  assert.equal(view.queryByText('内置通用场景'), null)
  const other = within(navigation).getByRole('button', { name: /SC-0002/ })
  assert.match(other.title, /采购审批与跨部门长名称完整显示验证/)
  allowFlush = false
  fireEvent.click(other)
  await act(async () => {})
  assert.equal(commands.filter(c => c.action === 'openScenario' && c.entityId === 's2').length, 0)
  allowFlush = true
  fireEvent.click(other)
  await waitFor(() => assert.ok(view.getByText('编辑 采购审批与跨部门长名称完整显示验证')))
  assert.equal(other.getAttribute('aria-current'), 'page')
  commands.length = 0
  fireEvent.click(view.getByRole('button', { name: '重新读取草稿' }))
  await waitFor(() => assert.ok(commands.some(c => c.action === 'openScenario')))
  assert.deepEqual(commands.map(c => c.action), ['flush', 'openScenario'])
  assert.ok(within(view.getByLabelText('材料工作区工具栏')).getByText('采购协同'))
})
test('requirement siblings use the requirement open command and return to their catalog', async () => {
  const view = setup()
  fireEvent.click(view.getByRole('button', { name: /需求协同/ }))
  await waitFor(() => assert.ok(view.getByRole('button', { name: '打开 采购订单' })))
  fireEvent.click(view.getByRole('button', { name: '打开 采购订单' }))
  await waitFor(() => assert.ok(view.getByText('编辑 采购订单')))
  fireEvent.click(within(view.getByLabelText('需求目录')).getByRole('button', { name: /REQ-0002/ }))
  await waitFor(() => assert.ok(view.getByText('编辑 审批规则')))
  assert.ok(commands.some(c => c.action === 'openRequirement' && c.entityId === 'r2'))
  fireEvent.click(view.getByRole('button', { name: '返回需求协同列表' }))
  await waitFor(() => assert.ok(view.getByRole('button', { name: '打开 采购订单' })))
})
test('narrow navigation starts closed, opens from the toolbar and closes on Escape or selection', async () => {
  const view = setup(true)
  assert.equal(view.queryByRole('button', { name: /^项目场景/ }), null)
  fireEvent.click(view.getByRole('button', { name: '展开侧边栏' }))
  const dialog = await view.findByRole('dialog', { name: '工作台导航' })
  fireEvent(dialog, new dom.window.Event('cancel', { bubbles: true, cancelable: true }))
  await act(async () => {})
  assert.equal(view.container.querySelector('dialog')?.open ?? false, false)
  fireEvent.click(view.getByRole('button', { name: '展开侧边栏' }))
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: /需求协同/ }))
  await act(async () => {})
  assert.equal(view.container.querySelector('dialog')?.open ?? false, false)
  act(() => { narrow = false; for (const listener of [...mediaListeners]) listener() })
  assert.ok(view.getByRole('button', { name: /^项目场景/ }))
})
