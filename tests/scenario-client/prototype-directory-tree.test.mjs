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
    if (specifier.endsWith('/PrototypeEditor.tsx')) return { PrototypeEditor: () => null, PrototypeComparison: () => null }
    if (specifier.startsWith('.')) return loadClient(path.relative(client, path.resolve(path.dirname(filename), specifier)))
    return reactRequire(specifier)
  }, module, module.exports)
  return module.exports
}

const { PrototypeDirectoryTree } = loadClient('prototype/PrototypeDirectoryTree.tsx')
const h = React.createElement

test('lazy directories isolate failures and retain nested pagination', async () => {
  const calls = []
  const listing = { kind: 'directory', observation: 'root', entries: [{ name: 'src', path: 'src', kind: 'directory' }, { name: 'bad', path: 'bad', kind: 'directory' }] }
  const opened = []
  const call = async command => {
    calls.push(command)
    if (command.directory === 'bad') return { ok: false, message: '拒绝读取' }
    return { ok: true, prototypeFiles: { kind: 'directory', observation: 'src-v1', entries: [{ name: command.cursor ? 'b.ts' : 'a.ts', path: command.cursor ? 'src/b.ts' : 'src/a.ts', kind: 'file' }], ...(command.cursor ? {} : { nextCursor: 'next' }) } }
  }
  const view = render(h(PrototypeDirectoryTree, { source: { kind: 'task', projectId: 'p', prototypeTaskId: 't' }, listing, call, onOpen: path => opened.push(path) }))
  assert.equal(calls.length, 0)
  fireEvent.click(view.getByRole('button', { name: /src/ }))
  await waitFor(() => assert.ok(view.getByText('a.ts')))
  fireEvent.click(view.getByRole('button', { name: /bad/ }))
  await waitFor(() => assert.ok(view.getByRole('alert')))
  assert.ok(view.getByText('a.ts'))
  fireEvent.click(view.getByRole('button', { name: '加载更多 src' }))
  await waitFor(() => assert.ok(view.getByText('b.ts')))
  assert.ok(view.getByText('a.ts'))
  fireEvent.click(view.getByRole('button', { name: 'b.ts' }))
  assert.deepEqual(opened, ['src/b.ts'])
  const before = calls.length
  fireEvent.click(view.getByRole('button', { name: /▾ src/ }))
  fireEvent.click(view.getByRole('button', { name: /▸ src/ }))
  assert.equal(calls.length, before)
})

const { PrototypeFiles } = loadClient('prototype/PrototypeFiles.tsx')
test('closing and reopening file tabs retains loaded buffers and offers diff from the menu signal', async () => {
  const commands = []
  const call = async command => {
    commands.push(command)
    if (command.action === 'listPrototypeDirectory') return { ok: true, prototypeFiles: { kind: 'directory', entries: [{ name: 'a.ts', path: 'a.ts', kind: 'file' }, { name: 'b.ts', path: 'b.ts', kind: 'file' }] } }
    if (command.action === 'readPrototypeFile') return { ok: true, prototypeFiles: { kind: 'file', path: command.path, content: 'const a = 1', hash: 'h', readOnly: false, size: 11 } }
    if (command.action === 'readPrototypeDiff') return { ok: true, prototypeFiles: { kind: 'diff', files: [], observation: 'd' } }
    return { ok: true }
  }
  const props = { source: { kind: 'task', projectId: 'p', prototypeTaskId: 't' }, call, registerFlush() {}, onNeedsAttention() {} }
  const view = render(h(PrototypeFiles, props))
  await waitFor(() => assert.ok(view.getByText('a.ts')))
  fireEvent.click(view.getByText('a.ts'))
  await waitFor(() => assert.ok(view.getByRole('tab', { name: 'a.ts' })))
  fireEvent.click(view.getByText('b.ts'))
  await waitFor(() => assert.ok(view.getByRole('tab', { name: 'b.ts' })))
  fireEvent.click(view.getByRole('button', { name: '关闭 a.ts' }))
  assert.equal(view.queryByRole('tab', { name: 'a.ts' }), null)
  fireEvent.click(view.getByText('a.ts'))
  await waitFor(() => assert.ok(view.getByRole('tab', { name: 'a.ts' })))
  assert.equal(commands.filter(c => c.action === 'readPrototypeFile' && c.path === 'a.ts').length, 1)
  view.rerender(h(PrototypeFiles, { ...props, requestDiff: 1 }))
  await waitFor(() => assert.ok(commands.some(c => c.action === 'readPrototypeDiff')))
})


test('real Host readonly entries keep a single text row and hidden-file toggle never grants editing', async () => {
  const commands = []
  const entries = [
    { name: 'package.json', path: 'package.json', kind: 'file', readOnly: true },
    { name: '.env.example', path: '.env.example', kind: 'file', readOnly: true },
  ]
  const call = async command => {
    commands.push(command)
    if (command.action === 'listPrototypeDirectory') return { ok: true, prototypeFiles: { kind: 'directory', entries, observation: 'root' } }
    if (command.action === 'readPrototypeFile') return { ok: true, prototypeFiles: { kind: 'file', path: command.path, content: '{}', hash: 'h', readOnly: true, size: 2 } }
    return { ok: true }
  }
  const view = render(h(PrototypeFiles, { source: { kind: 'task', projectId: 'p', prototypeTaskId: 't' }, call, registerFlush() {}, onNeedsAttention() {} }))
  const row = await waitFor(() => view.getByRole('button', { name: 'package.json' }))
  assert.equal(row.title, 'package.json · 只读')
  assert.equal(row.querySelectorAll('span').length, 1)
  assert.equal(row.querySelectorAll('small').length, 0)
  assert.ok(row.querySelector('svg[aria-hidden="true"]'))
  assert.equal(view.queryByRole('button', { name: '.env.example' }), null)
  assert.ok(view.getByText('原型代码'))
  fireEvent.click(view.getByRole('button', { name: '隐藏文件' }))
  const hiddenRow = view.getByRole('button', { name: '.env.example' })
  assert.equal(hiddenRow.title, '.env.example · 只读')
  fireEvent.click(hiddenRow)
  await waitFor(() => assert.ok(view.getByRole('tab', { name: '.env.example' })))
  assert.equal(view.queryByRole('button', { name: '编辑' }), null)
  assert.equal(view.queryByRole('button', { name: '保存' }), null)
  fireEvent.click(view.getByRole('button', { name: '隐藏文件' }))
  assert.equal(within(view.getByLabelText('工程文件')).queryByRole('button', { name: '.env.example' }), null)
  assert.equal(entries.every(entry => entry.readOnly), true)
  assert.equal(commands.some(command => command.action === 'savePrototypeFile'), false)
})
