import assert from 'node:assert/strict'
import { menuFixture } from './menu-fixture.mjs'
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

let opener
// JSDOM does not implement native dialog focus; model that browser lifecycle here.
dom.window.HTMLDialogElement.prototype.showModal = function () { opener = document.activeElement; this.setAttribute('open', ''); this.querySelector('button')?.focus() }
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); opener?.focus() }
const modules = new Map()
function loadClient(relative) {
  const filename = path.resolve(client, relative)
  if (modules.has(filename)) return modules.get(filename).exports
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename }).outputText
  const module = { exports: {} }
  modules.set(filename, module)
  new Function('require', 'module', 'exports', compiled)(specifier => {
    if (specifier.endsWith('.css')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Menu: menuFixture(React) }
    if (specifier.startsWith('.')) return loadClient(path.relative(client, path.resolve(path.dirname(filename), specifier)))
    return reactRequire(specifier)
  }, module, module.exports)
  return module.exports
}
const { MaterialWorkspaceHeader, MaterialWorkspaceSheet } = loadClient('components/MaterialWorkspaceChrome.tsx')
const h = React.createElement

test('prototype remains reachable from the requirement overflow menu, including read-only requirements', () => {
  let opened = 0
  const view = render(h(MaterialWorkspaceHeader, { entity: { id: 'r', code: 'REQ-1', title: '订单', kind: 'requirement' }, sessions: [], locked: false, readOnly: true, reviewCount: 0, onReview() {}, onConfirm() {}, onRefresh() {}, onNewSession() {}, onSelectSession() {}, onTemplates() {}, onOpenPrototype() { opened++ } }))
  fireEvent.click(view.getByLabelText('会话与模板操作'))
  fireEvent.click(view.getByRole('menuitem', { name: '进入项目原型' }))
  assert.equal(opened, 1)
  assert.equal(view.getByLabelText('会话与模板操作').getAttribute('aria-expanded'), 'false')
  assert.equal(view.queryByRole('button', { name: /确认需求/ }), null)
})

test('consistency dialog delegates cancel and close to its owner while preserving native focus restoration', () => {
  function Fixture() {
    const [open, setOpen] = React.useState(false)
    return h(React.Fragment, null, h('button', { onClick: () => setOpen(true) }, '一致性'), h(MaterialWorkspaceSheet, { open, drawer: true, title: '一致性对比', onClose: () => setOpen(false) }, h('p', null, '结果')))
  }
  const view = render(h(Fixture))
  const trigger = view.getByRole('button', { name: '一致性' })
  trigger.focus(); fireEvent.click(trigger)
  let dialog = view.getByRole('dialog', { name: '一致性对比' })
  assert.equal(dialog.open, true)
  fireEvent(dialog, new dom.window.Event('cancel', { bubbles: false, cancelable: true }))
  assert.equal(dialog.open, false)
  assert.equal(document.activeElement, trigger)
  fireEvent.click(trigger)
  dialog = view.getByRole('dialog', { name: '一致性对比' })
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭一致性对比' }))
  assert.equal(dialog.open, false)
  assert.equal(document.activeElement, trigger)
})
