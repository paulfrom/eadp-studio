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
    if (specifier.endsWith('/ScenarioTemplateSettings.tsx') || specifier.endsWith('/MaterialTemplateSettings.tsx')) return { MaterialTemplateSettings: () => null }
    if (specifier.startsWith('.')) return loadClient(path.relative(client, path.resolve(path.dirname(filename), specifier)))
    return reactRequire(specifier)
  }, module, module.exports)
  return module.exports
}

const h = React.createElement
const { ProjectDialog } = loadClient('components/ProjectDialog.tsx')
const { settingsSections } = loadClient('settings/sections.tsx')
function dialog(pickDirectory, localProjects = []) {
  const commands = []
  const view = render(h(ProjectDialog, { busy: false, defaultDirectory: 'D:/EADP', projects: [{ id: 'p', name: '采购', namespacePath: 'team' }], namespaces: [], localProjects, pickDirectory, onClose() {}, onSubmit: async command => commands.push(command) }))
  fireEvent.change(view.getByLabelText('可用项目'), { target: { value: 'p' } })
  return { view, commands }
}
test('cancelled project chooser preserves default and does not submit', async () => {
  const { view, commands } = dialog(async () => null)
  fireEvent.click(view.getByRole('button', { name: '选择文件夹' }))
  await waitFor(() => assert.equal(view.getByRole('button', { name: '选择文件夹' }).disabled, false))
  assert.equal(view.getByLabelText('项目文件夹').value, '')
  assert.deepEqual(commands, [])
  fireEvent.submit(view.getByRole('dialog').querySelector('form'))
  assert.deepEqual(commands, [{ action: 'openProject', projectId: 'p' }])
})
test('chosen project folder is submitted only by explicit open', async () => {
  const { view, commands } = dialog(async () => 'D:/work/purchase')
  fireEvent.click(view.getByRole('button', { name: '选择文件夹' }))
  await waitFor(() => assert.equal(view.getByLabelText('项目文件夹').value, 'D:/work/purchase'))
  assert.deepEqual(commands, [])
  fireEvent.submit(view.getByRole('dialog').querySelector('form'))
  assert.deepEqual(commands, [{ action: 'openProject', projectId: 'p', workspaceDirectory: 'D:/work/purchase' }])
})
test('registered project location cannot be replaced by a chooser', () => {
  const { view } = dialog(async () => { throw new Error('must not pick') }, [{ id: 'p', workspaceDirectory: 'D:/existing' }])
  assert.equal(view.getByLabelText('项目文件夹').value, 'D:/existing')
  assert.equal(view.getByRole('button', { name: '选择文件夹' }).disabled, true)
})
function settings(pickDirectory) {
  const commands = []
  const Component = settingsSections.find(section => section.id === 'studio-workspace').component
  const snapshot = { projection: { workspace: { defaultDirectory: 'D:/EADP' } }, loading: false, error: '' }
  const view = render(h(Component, { useStore: select => select(snapshot), sync() {}, pickDirectory, run: async command => { commands.push(command); return { ok: true } } }))
  return { view, commands }
}
test('default chooser cancellation writes nothing and selection updates the preference', async () => {
  let selected = null
  const { view, commands } = settings(async () => selected)
  fireEvent.click(view.getByRole('button', { name: '选择文件夹' }))
  await waitFor(() => assert.equal(view.getByRole('button', { name: '选择文件夹' }).disabled, false))
  assert.deepEqual(commands, [])
  selected = 'E:/projects'
  fireEvent.click(view.getByRole('button', { name: '选择文件夹' }))
  await waitFor(() => assert.deepEqual(commands, [{ action: 'setWorkspaceDirectory', directory: 'E:/projects' }]))
})
