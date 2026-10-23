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
for (const name of ['window', 'document', 'HTMLElement', 'HTMLDialogElement', 'File', 'FileReader', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom does not implement modal focus or native Escape cancellation. Keep the
// browser's show/close boundary while testing the component's real event handlers.
const previousFocus = new WeakMap()
HTMLDialogElement.prototype.showModal = function () {
  if (this.open) throw new Error('The dialog is already open')
  previousFocus.set(this, document.activeElement)
  this.open = true
  this.querySelector('[autofocus], button, input')?.focus()
}
HTMLDialogElement.prototype.close = function () {
  if (!this.open) return
  this.open = false
  previousFocus.get(this)?.focus()
  this.dispatchEvent(new Event('close'))
}

const React = reactRequire('react')
const { render, fireEvent, within, waitFor, cleanup, act } = buildRequire('@testing-library/react')
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

const { MaterialAttachments, MaterialAttachmentButton } = loadClient('components/MaterialAttachments.tsx')
const { MaterialConversation } = loadClient('components/MaterialConversation.tsx')
const { MaterialEditor } = loadClient('components/MaterialEditor.tsx')
const h = React.createElement
const source = (overrides = {}) => ({
  id: 'read', name: '业务说明.md', format: 'md', sha256: 'a'.repeat(64), status: 'read',
  ranges: ['第 1–3 段'], text: '已读取的业务说明', selected: false, formal: false, ...overrides,
})
function attachments(props = {}, children) {
  return h(MaterialAttachments, {
    sessionId: 'material-session', sources: [], disabled: false, readOnly: false,
    onImport: async () => {}, onRetry: () => {}, onSelect: () => {}, ...props,
  }, children ?? h(MaterialAttachmentButton, { sessionId: props.sessionId ?? 'material-session' }))
}
function openPanel(view) {
  const button = view.getByRole('button', { name: '附件与正式依据' })
  button.focus()
  fireEvent.click(button)
  return { button, dialog: view.getByRole('dialog', { name: '附件与正式依据' }) }
}

test('the attachment entry is scoped to its conversation and opens a modal with close and Escape focus restoration', () => {
  const view = render(h(React.Fragment, null,
    h(MaterialAttachmentButton, { sessionId: 'unrelated-session' }),
    attachments({}, h(React.Fragment, null,
      h(MaterialAttachmentButton, { sessionId: 'material-session' }),
      h(MaterialAttachmentButton, { sessionId: 'unrelated-session' }),
      h(MaterialAttachmentButton),
    )),
  ))
  assert.equal(view.getAllByRole('button', { name: '附件与正式依据' }).length, 1)
  const { button, dialog } = openPanel(view)
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog')
  assert.equal(button.getAttribute('aria-controls'), dialog.id)
  assert.equal(button.getAttribute('aria-expanded'), 'true')
  const close = within(dialog).getByRole('button', { name: '关闭附件面板' })
  assert.equal(document.activeElement, close)
  fireEvent.click(close)
  assert.equal(dialog.open, false)
  assert.equal(button.getAttribute('aria-expanded'), 'false')
  assert.equal(document.activeElement, button)
  fireEvent.click(button)
  // Browsers dispatch cancel for Escape; the DOM shim cannot synthesize that default action.
  fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
  assert.equal(dialog.open, false)
  assert.equal(document.activeElement, button)
})

test('materials without a session can inspect attachments while foreign sessions receive no entry', () => {
  const view = render(attachments({ sessionId: undefined }, h(React.Fragment, null,
    h(MaterialAttachmentButton), h(MaterialAttachmentButton, { sessionId: 'foreign-session' }),
  )))
  assert.equal(view.getAllByRole('button', { name: '附件与正式依据' }).length, 1)
  const { dialog } = openPanel(view)
  assert.match(dialog.textContent, /还没有资料.*实际读取结果和范围/)
})

test('the shared material conversation keeps exactly one attachment entry through restore, error, retry, and ready states', async () => {
  let restore
  let released = 0
  const faces = {
    run: () => new Promise(resolve => { restore = resolve }),
    retainSession: () => ({ ready: Promise.resolve(), release: () => { released += 1 } }),
    SessionProvider: ({ children }) => h(React.Fragment, null, children),
    renderFactorySlot: () => h(MaterialAttachmentButton, { sessionId: 'material-session' }),
  }
  const view = render(h(MaterialConversation, { sessionId: 'material-session', faces,
    attachments: { sources: [], disabled: false, readOnly: false, onImport: async () => {}, onRetry: () => {}, onSelect: () => {} },
  }, '开始整理材料'))
  assert.match(view.container.textContent, /正在恢复原生会话/)
  assert.equal(view.getAllByRole('button', { name: '附件与正式依据' }).length, 1)
  fireEvent.click(openPanel(view).dialog.querySelector('button'))
  restore({ ok: false, message: '恢复服务不可用' })
  await waitFor(() => assert.match(view.getByRole('alert').textContent, /恢复服务不可用/))
  assert.equal(view.getAllByRole('button', { name: '附件与正式依据' }).length, 1)
  fireEvent.click(view.getByRole('button', { name: '重试恢复对话' }))
  assert.match(view.container.textContent, /正在恢复原生会话/)
  restore({ ok: true, sessionId: 'material-session' })
  await waitFor(() => assert.doesNotMatch(view.container.textContent, /正在恢复原生会话/))
  assert.equal(view.getAllByRole('button', { name: '附件与正式依据' }).length, 1)
  assert.equal(openPanel(view).dialog.open, true)
  view.unmount()
  assert.equal(released, 1)
})

test('actual source status and ranges remain visible, with retry and formal selection behavior', () => {
  const sources = [source(), source({ id: 'partial', name: '部分资料.pdf', format: 'pdf', status: 'partial', ranges: ['第 1–2 页'], error: '第 3 页无法读取' }),
    source({ id: 'failed', name: '失败资料.pdf', format: 'pdf', status: 'failed', ranges: [], text: '', error: '文件损坏' }),
    source({ id: 'reading', name: '读取中.pdf', format: 'pdf', status: 'reading', ranges: [], text: '' })]
  const selections = [], retries = []
  const view = render(attachments({ sources, onSelect: (...args) => selections.push(args), onRetry: id => retries.push(id) }))
  const { dialog } = openPanel(view)
  const articles = Array.from(dialog.querySelectorAll('article'))
  for (const [index, status] of ['已读取', '部分读取', '读取失败', '正在读取'].entries()) assert.match(articles[index].textContent, new RegExp(status))
  assert.match(articles[0].textContent, /实际读取范围：第 1–3 段/)
  assert.match(articles[1].textContent, /实际读取范围：第 1–2 页/)
  assert.match(articles[2].textContent, /实际读取范围：无/)
  assert.match(articles[3].textContent, /实际读取范围：无/)
  for (const index of [2, 3]) assert.equal(within(articles[index]).getByRole('checkbox', { name: /选为正式依据/ }).disabled, true)
  fireEvent.click(within(articles[0]).getByRole('checkbox', { name: /提供给当前材料 AI/ }))
  assert.deepEqual(selections.pop(), [sources[0], true, false])
  fireEvent.click(within(articles[0]).getByRole('checkbox', { name: /选为正式依据/ }))
  assert.deepEqual(selections.pop(), [sources[0], true, true])
  fireEvent.click(within(articles[1]).getByRole('button', { name: '重试实际读取' }))
  fireEvent.click(within(articles[2]).getByRole('button', { name: '重试实际读取' }))
  assert.deepEqual(retries, ['partial', 'failed'])
  assert.equal(within(articles[3]).queryByRole('button', { name: '重试实际读取' }), null)
})

test('import preserves file content, surfaces failures, and leaves read status to the Host', async () => {
  const imports = []
  let fail = true
  const view = render(attachments({ onImport: async (...args) => { imports.push(args); if (fail) throw new Error('导入服务不可用') } }))
  const { dialog } = openPanel(view)
  const input = within(dialog).getByLabelText('添加资料')
  fireEvent.change(input, { target: { files: [new File(['业务资料'], '资料.md', { type: 'text/markdown' })] } })
  await waitFor(() => assert.match(within(dialog).getByRole('alert').textContent, /导入服务不可用/))
  assert.deepEqual(imports, [['资料.md', Buffer.from('业务资料').toString('base64')]])
  assert.equal(input.disabled, false)
  assert.equal(dialog.querySelectorAll('article').length, 0)
  assert.match(dialog.textContent, /实际读取结果和范围/)
  fail = false
  fireEvent.change(input, { target: { files: [new File(['第二份资料'], '补充.md')] } })
  await waitFor(() => assert.equal(input.disabled, false))
  assert.equal(within(dialog).queryByRole('alert'), null)
  assert.deepEqual(imports[1], ['补充.md', Buffer.from('第二份资料').toString('base64')])
  assert.equal(dialog.querySelectorAll('article').length, 0)
})

test('a pending upload reports importing without claiming that any source was read', async () => {
  let finishImport
  const view = render(attachments({ onImport: () => new Promise(resolve => { finishImport = resolve }) }))
  const { dialog } = openPanel(view)
  const input = within(dialog).getByLabelText('添加资料')
  fireEvent.change(input, { target: { files: [new File(['内容'], '资料.md')] } })
  await waitFor(() => assert.equal(typeof finishImport, 'function'))
  assert.match(within(dialog).getByRole('status').textContent, /正在导入资料/)
  assert.equal(input.disabled, true)
  assert.equal(dialog.querySelectorAll('article').length, 0)
  assert.doesNotMatch(dialog.textContent, /已读取|正在读取资料/)
  finishImport()
  await waitFor(() => assert.equal(input.disabled, false))
})

test('read-only materials retain source records while import, retry, and selection are unavailable', () => {
  const calls = []
  const view = render(attachments({ readOnly: true, sources: [source({ status: 'partial' })],
    onImport: async () => calls.push('import'), onRetry: () => calls.push('retry'), onSelect: () => calls.push('select'),
  }))
  const { dialog } = openPanel(view)
  assert.match(dialog.textContent, /业务说明.md.*部分读取/)
  assert.equal(within(dialog).queryByLabelText('添加资料'), null)
  assert.equal(within(dialog).queryByRole('button', { name: '重试实际读取' }), null)
  for (const checkbox of within(dialog).getAllByRole('checkbox')) {
    assert.equal(checkbox.disabled, true)
    checkbox.click()
  }
  assert.deepEqual(calls, [])
})

function editableRequirement(onSave, registerFlush) {
  const metadata = { kind: 'requirement', entityId: 'requirement', title: '业务要求', templateId: 'default', templateRef: { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }, scenarioIds: [],
    sources: [], prerequisites: [], businessEvidence: [], openQuestions: [], coreRulesPresent: true, acceptanceCriteriaPresent: true }
  return h(MaterialEditor, { draft: { entityId: metadata.entityId, metadata, body: '原始业务正文', path: '需求/requirement.md' },
    entities: [], projectId: 'project', busy: false,
    onSave, onBindTemplate: async () => {}, registerFlush,
  })
}

test('attachment actions can flush hand edits, while an unchanged material needs no save', async () => {
  let flush
  const saves = []
  const view = render(editableRequirement(async (...args) => { saves.push(args); return { ok: true } }, next => { flush = next }))
  assert.equal(await flush(), true)
  assert.equal(saves.length, 0)
  fireEvent.change(view.getByRole('textbox', { name: '材料 Markdown 正文' }), { target: { value: '手工补充的业务正文' } })
  let result
  await act(async () => { result = await flush() })
  assert.equal(result, true)
  assert.equal(saves.length, 1)
  assert.equal(saves[0][0], '手工补充的业务正文')
  assert.equal(saves[0][1].title, '业务要求')
  view.unmount()
  assert.equal(flush, undefined)
})

for (const failure of ['validation', 'host']) test(`a ${failure} failure blocks attachment flushing and preserves hand edits`, async () => {
  let flush
  const saves = []
  const view = render(editableRequirement(async (...args) => { saves.push(args); return { ok: false, message: '本地保存失败' } }, next => { flush = next }))
  const body = view.getByRole('textbox', { name: '材料 Markdown 正文' })
  fireEvent.change(body, { target: { value: '尚未保存的手工正文' } })
  if (failure === 'validation') fireEvent.change(view.getByLabelText(/正式依据（JSON/), { target: { value: '{invalid' } })
  let result
  await act(async () => { result = await flush() })
  assert.equal(result, false)
  assert.equal(body.value, '尚未保存的手工正文')
  assert.equal(saves.length, failure === 'validation' ? 0 : 1)
  assert.ok(view.getByRole('alert').textContent)
  if (failure === 'host') assert.match(view.getByRole('alert').textContent, /本地保存失败/)
})

test('the plugin contributes the attachment button to the native composer left slot', () => {
  const entry = readFileSync(path.join(client, 'index.ts'), 'utf8')
  assert.match(entry, /slots\.inject\('conversation\.input\.left',\s*\(\)\s*=>\s*ctx\.slots\.register\(\{\s*name:\s*'conversation\.input\.left',\s*id:\s*'studio-material-attachments',\s*order:\s*0,?\s*\},\s*MaterialAttachmentButton\)\)/)
})

test('scenario and requirement pages reach the shared attachment conversation without an old inline source panel', () => {
  for (const relative of ['scenarios/ScenarioWorkspace.tsx', 'studio/StudioPanel.tsx']) {
    const contents = readFileSync(path.join(client, relative), 'utf8')
    assert.match(contents, /<MaterialConversation\b/, `${relative} must use the shared material conversation`)
    assert.doesNotMatch(contents, /<ScenarioEvidence\b/)
  }
  const chatPanel = readFileSync(path.join(client, 'scenarios/ScenarioChatPanel.tsx'), 'utf8')
  assert.doesNotMatch(chatPanel, /<ScenarioEvidence\b/)
})
