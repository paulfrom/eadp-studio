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
// Desktop viewport fixture implements the modern MediaQueryList listener contract.
dom.window.matchMedia = query => {
  const listeners = new Set()
  return { media: query, matches: false, onchange: null,
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
    dispatchEvent(event) { for (const listener of [...listeners]) listener(event); return !event.defaultPrevented },
  }
}

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
    // The primitives package imports its CSS at load time; rendering is asserted through the stub's text output.
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {
      MarkdownText: ({ text }) => React.createElement('div', {}, text),
      DiffBlock: () => null,
    }
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

function editableRequirement(onSave, registerFlush, extra = {}) {
  const metadata = { kind: 'requirement', entityId: 'requirement', title: '业务要求', templateId: 'default', templateRef: { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }, scenarioIds: [],
    sources: [], prerequisites: [], businessEvidence: [], openQuestions: [], coreRulesPresent: true, acceptanceCriteriaPresent: true }
  return h(MaterialEditor, { draft: { entityId: metadata.entityId, metadata, body: '原始业务正文', path: '需求/requirement.md', sha256: 'hash-initial' },
    entities: [], projectId: 'project', busy: false,
    onSave, onBindTemplate: async () => {}, registerFlush, ...extra,
  })
}
const savedMaterialReply = (input, sha256 = 'hash-saved') => ({ ok: true, state: { drafts: [{ entityId: 'requirement', metadata: input.metadata, body: input.body, path: '需求/requirement.md', sha256 }] } })

test('attachment actions can flush hand edits, while an unchanged material needs no save', async () => {
  let flush
  const saves = []
  const view = render(editableRequirement(async input => { saves.push(input); return savedMaterialReply(input) }, next => { flush = next }))
  assert.equal(await flush(), true)
  assert.equal(saves.length, 0)
  fireEvent.change(view.getByRole('textbox', { name: '材料 Markdown 正文' }), { target: { value: '手工补充的业务正文' } })
  let result
  await act(async () => { result = await flush() })
  assert.equal(result, true)
  assert.equal(saves.length, 1)
  assert.equal(saves[0].body, '手工补充的业务正文')
  assert.equal(saves[0].metadata.title, '业务要求')
    assert.equal(typeof saves[0].operationId, 'string')
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

test('requirement save retries keep their operation identity and acknowledged hash', async () => {
  let flush
  const saves = []
  const view = render(editableRequirement(async input => {
    saves.push(input)
    return saves.length === 1 ? { ok: false, message: '磁盘暂不可写' } : savedMaterialReply(input)
  }, next => { flush = next }))
  fireEvent.change(view.getByRole('textbox', { name: '材料 Markdown 正文' }), { target: { value: '需要可靠保存的正文' } })
  let first, second
  await act(async () => { first = await flush() })
  assert.equal(first, false)
  await act(async () => { second = await flush() })
  assert.equal(second, true)
  assert.equal(saves[0].operationId, saves[1].operationId)
})

test('polling loads the newest requirement content and keeps unsaved input recoverable', async () => {
  let flush
  const saves = []
  const props = editableRequirement(async input => { saves.push(input); return savedMaterialReply(input) }, next => { flush = next }).props
  const view = render(h(MaterialEditor, props))
  fireEvent.change(view.getByRole('textbox', { name: '材料 Markdown 正文' }), { target: { value: '用户未保存的业务正文' } })
  view.rerender(h(MaterialEditor, { ...props, draft: { ...props.draft, body: '并发外部正文', sha256: 'hash-external' } }))
  const notice = await waitFor(() => view.getByRole('region', { name: '文件外部更新' }))
  assert.equal(view.getByRole('textbox', { name: '材料 Markdown 正文' }).value, '并发外部正文')
  assert.match(notice.textContent, /你此前未保存的输入仍可恢复/)
  await act(async () => { assert.equal(await flush(), true) })
  assert.equal(saves.length, 0, 'loading the external content does not write')
  fireEvent.click(within(notice).getByRole('button', { name: '恢复未保存输入' }))
  assert.equal(view.getByRole('textbox', { name: '材料 Markdown 正文' }).value, '用户未保存的业务正文')
  await act(async () => { assert.equal(await flush(), true) })
  assert.equal(saves.length, 1)
  assert.equal(saves[0].body, '用户未保存的业务正文')
})

test('unsaved invalid evidence survives a new projection while the newest content loads', async () => {
  let flush
  const saves = []
  const props = editableRequirement(async input => { saves.push(input); return savedMaterialReply(input) }, next => { flush = next }).props
  const view = render(h(MaterialEditor, props))
  fireEvent.change(view.getByLabelText(/正式依据（JSON/), { target: { value: '{用户正在编辑' } })
  view.rerender(h(MaterialEditor, { ...props, draft: { ...props.draft, body: '外部业务正文', sha256: 'hash-external' } }))
  await waitFor(() => assert.equal(view.getByRole('textbox', { name: '材料 Markdown 正文' }).value, '外部业务正文'))
  assert.equal(view.getByLabelText(/正式依据（JSON/).value, '{用户正在编辑')
  await act(async () => { assert.equal(await flush(), false) })
  assert.equal(saves.length, 0, 'invalid evidence still blocks a save of the restored input')
})

test('a requirement editor displays its fixed template without offering a switch', () => {
  let binds = 0
  const view = render(editableRequirement(async input => savedMaterialReply(input), () => {}, {
    templates: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认需求模板' }, { id: 'custom', name: '定制需求模板' }] },
    onBindTemplate: async () => { binds++; throw new Error('editing cannot change templates') },
  }))
  assert.ok(view.getByText(/固定需求模板：默认需求模板/))
  assert.equal(view.queryByRole('combobox', { name: '需求模板' }), null)
  assert.equal(view.queryByRole('button', { name: '切换模板绑定' }), null)
  assert.equal(binds, 0)
})

// Keep these tests on the requirement command boundary; scenario and desktop-caption rendering have their own suites.
for (const [relative, name] of [['scenarios/ScenarioWorkspace.tsx', 'ScenarioWorkspace'], ['components/StudioTopbar.tsx', 'StudioTopbar']]) modules.set(path.join(client, relative), { exports: { [name]: () => null } })
const { StudioPanel } = loadClient('studio/StudioPanel.tsx')
function requirementPanel(readOnly = false, readComparisons, readSummaries, respond, restore) {
  const element = editableRequirement(async () => {}, () => {})
  const initialDraft = element.props.draft
  const entity = { id: 'requirement', kind: 'requirement', code: 'REQ-0001', sequence: 1, title: '需求能力', revision: 3, materialVersion: readOnly ? 1 : 0, confirmationStatus: readOnly ? 'confirmed' : 'draft', taskStatus: 'idle', scenarioIds: ['scene'], prerequisites: [], authorId: 1 }
  const project = { id: 'project', name: '业务项目', stableBranch: 'main', initializationStatus: 'ready', recognizedHead: 'a'.repeat(40), revision: 1 }
  let current = { connected: true, account: { id: 1, name: '作者', gitlabUsername: 'author' }, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], pending: [], reviews: [], drafts: [initialDraft], tasks: [], candidates: [], project,
    collaboration: { project, entities: [entity], baselines: [], integrations: [] },
    materialSources: [{ entityId: entity.id, readOnly, sources: [] }],
    requirement: { entityId: entity.id, draft: initialDraft, readOnly, template: { id: 'default', name: '默认需求模板', fixed: initialDraft.metadata.templateRef, body: '# 模板正文不能自动写入' }, structureCheck: false, gates: [], sources: [], sessions: [], settlement: { status: readOnly ? 'settled' : 'draft' },
      writeProposal: { id: 'proposal-original', baseHash: initialDraft.sha256, createdAt: '2026-10-23T00:00:00Z', conclusions: ['本轮明确结论'], evidenceIds: ['source-one'], status: 'pending',
        changes: [{ id: 'change-original', title: '业务正文', before: initialDraft.body, after: '本轮建议的业务正文', kind: 'changed', addedLines: 1, removedLines: 1 }],
      },
    },
  }
  if (restore) current = restore(current)
  const commands = []
  let update
  const run = async command => {
    commands.push(command)
    if (respond) {
      const reply = await respond(command, current)
      if (reply !== undefined) { if (reply.ok) { current = reply.state; update(current) }; return reply }
    }
    if (command.action === 'listConsistencyComparisons' && readComparisons) return readComparisons(command, current)
    if (command.action === 'listConsistencySummaries' && readSummaries) return readSummaries(command, current)
    if (command.action === 'saveRequirement' || command.action === 'confirmRequirement' || command.action === 'resolveRequirementConflict') {
      const draft = { ...initialDraft, body: command.body, metadata: command.metadata, sha256: 'hash-saved' }
      current = { ...current, drafts: [draft], requirement: { ...current.requirement, draft } }
    }
    if (command.action === 'resolveRequirementWriteProposal' && command.decision === 'write' && command.expectedHash !== initialDraft.sha256) return { ok: false, code: 'STALE_PROPOSAL', message: '正文已变化，旧写入提议已作废。' }
    update(current)
    return { ok: true, state: current }
  }
  const faces = { run, sync: () => {}, progress: () => {}, openSettings: () => {}, startSession: () => {}, SessionProvider: ({ children }) => h(React.Fragment, null, children), renderFactorySlot: () => null, retainSession: () => ({ ready: Promise.resolve(), release: () => {} }) }
  function Harness() {
    const [projection, setProjection] = React.useState(current); update = setProjection
    return h(StudioPanel, { ...faces, useStore: selector => selector({ projection, progress: [], loading: false, error: '' }) })
  }
  return { commands, render: () => render(h(Harness)), project: change => { current = change(current); update(current) } }
}
async function selectRequirement(view) {
  fireEvent.click(view.getByRole('button', { name: /^需求协同/ }))
  await waitFor(() => assert.ok(view.getByRole('button', { name: /需求能力/ })))
  fireEvent.click(view.getByRole('button', { name: /需求能力/ }))
  await waitFor(() => assert.ok(view.getByRole('region', { name: '需求对话' })))
}
function editRequirementBody(view, value) {
  fireEvent.click(view.getByRole('button', { name: '源码' }))
  fireEvent.change(view.getByRole('textbox', { name: '需求 Markdown 正文' }), { target: { value } })
}
function openConfirmation(view) {
  const current = view.queryByRole('dialog', { name: '确认需求' })
  if (current) return current
  fireEvent.click(view.getByRole('button', { name: /^门禁/ }))
  return view.getByRole('dialog', { name: '确认需求' })
}
function confirmRequirement(view) {
  fireEvent.click(within(openConfirmation(view)).getByRole('button', { name: '确认当前需求' }))
}
function openWriteReview(view) {
  const chat = view.getByRole('region', { name: '需求对话' })
  fireEvent.click(within(chat).getAllByRole('button', { name: '审阅 1 处变更' })[0])
  return view.getByRole('dialog', { name: '审阅写入变更' })
}

test('requirement write proposals require an explicit gesture and keep their original identity after hand edits flush', async () => {
  const fixture = requirementPanel(), view = fixture.render()
  await selectRequirement(view)
  assert.ok(fixture.commands.some(command => command.action === 'listConsistencySummaries'), '目录读取每项材料的最近一次结论')
  assert.ok(fixture.commands.some(command => command.action === 'listConsistencyComparisons' && command.entityId === 'requirement'), '详情面板查询实体级历史')
  assert.equal(fixture.commands.filter(command => command.action === 'openRequirement').length, 1)
  assert.equal(fixture.commands.some(command => command.action === 'resolveRequirementWriteProposal'), false)
  assert.match(view.getByRole('region', { name: '写入提议' }).textContent, /需求正文/)
  editRequirementBody(view, '刚刚手工修改的需求')
  const review = openWriteReview(view)
  fireEvent.click(within(review).getByRole('button', { name: '写入所选的 1 处' }))
  await waitFor(() => assert.equal(fixture.commands.filter(command => command.action === 'resolveRequirementWriteProposal').length, 1))
  const saveIndex = fixture.commands.findIndex(command => command.action === 'saveRequirement')
  const resolveIndex = fixture.commands.findIndex(command => command.action === 'resolveRequirementWriteProposal')
  assert.ok(saveIndex < resolveIndex)
  assert.deepEqual(fixture.commands[resolveIndex], { action: 'resolveRequirementWriteProposal', entityId: 'requirement', proposalId: 'proposal-original', decision: 'write', selectedChangeIds: ['change-original'], expectedHash: 'hash-saved' })
  assert.equal(view.getByRole('textbox', { name: '需求 Markdown 正文' }).value, '刚刚手工修改的需求')
  await waitFor(() => assert.match(view.getByRole('alert').textContent, /旧写入提议已作废/))
})

test('an outstanding comparison-history query does not lock requirement confirmation', async () => {
  let finish
  const fixture = requirementPanel(false, (_command, state) => new Promise(resolve => { finish = () => resolve({ ok: true, state, comparisons: [] }) }))
  const view = fixture.render()
  await selectRequirement(view)
  assert.equal(within(openConfirmation(view)).getByRole('button', { name: '确认当前需求' }).disabled, false)
  confirmRequirement(view)
  await waitFor(() => assert.ok(fixture.commands.some(command => command.action === 'confirmRequirement')))
  await act(async () => finish())
})

test('the material status bar opens checks and cancelling confirmation leaves the current input untouched', async () => {
  const fixture = requirementPanel(false, undefined, undefined, undefined, state => {
    const draft = { ...state.requirement.draft, metadata: { ...state.requirement.draft.metadata,
      openQuestions: [{ blocking: true, limitation: '退款是否需要复核？', excludedScope: '未明确前不覆盖自动退款' }],
    } }
    return { ...state, drafts: [draft], requirement: { ...state.requirement, draft, gates: [
      { id: 'business', label: '业务内容', status: 'blocked', messages: ['仍有业务问题未明确'] },
      { id: 'evidence', label: '资料与依据', status: 'blocked', messages: ['缺少归档依据'] },
    ] } }
  })
  const view = fixture.render()
  await selectRequirement(view)
  const status = view.getByLabelText('材料状态')
  assert.match(status.textContent, /门禁 2 项阻断/)
  assert.match(status.textContent, /待澄清 1 项 · 1 项阻断/)
  assert.ok(within(status).getByRole('button', { name: /^一致性/ }))
  assert.equal(view.queryByRole('dialog', { name: '确认需求' }), null)
  const gateButton = within(status).getByRole('button', { name: /^门禁/ })
  gateButton.focus()
  const dialog = openConfirmation(view)
  assert.match(dialog.textContent, /仍有业务问题未明确/)
  assert.match(dialog.textContent, /缺少归档依据/)
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭确认需求' }))
  assert.equal(view.queryByRole('dialog', { name: '确认需求' }), null)
  assert.equal(document.activeElement, gateButton)
  assert.equal(fixture.commands.some(command => ['confirmRequirement', 'saveRequirement', 'resolveRequirementWriteProposal'].includes(command.action)), false)
})

test('the primary action opens write review and cancelling never authorizes a write', async () => {
  const fixture = requirementPanel(), view = fixture.render()
  await selectRequirement(view)
  const review = openWriteReview(view)
  assert.match(review.textContent, /原始业务正文/)
  assert.match(review.textContent, /本轮建议的业务正文/)
  fireEvent.click(within(review).getByRole('button', { name: '取消' }))
  assert.equal(view.queryByRole('dialog', { name: '审阅写入变更' }), null)
  assert.equal(fixture.commands.some(command => command.action === 'resolveRequirementWriteProposal'), false)
})

test('collapsing and restoring the document preserves its source view and unsaved input', async () => {
  const fixture = requirementPanel(), view = fixture.render()
  await selectRequirement(view)
  editRequirementBody(view, '收起预览时仍保留的输入')
  const editor = view.getByRole('textbox', { name: '需求 Markdown 正文' })
  fireEvent.click(view.getByRole('button', { name: '收起文档预览' }))
  const restore = view.getByRole('button', { name: '展开需求文档' })
  assert.equal(editor.closest('.scenarioWorkspace').classList.contains('scenarioCollapsed'), true)
  fireEvent.click(restore)
  assert.equal(view.queryByRole('button', { name: '展开需求文档' }), null)
  assert.equal(editor.closest('.scenarioWorkspace').classList.contains('scenarioCollapsed'), false)
  assert.equal(view.getByRole('textbox', { name: '需求 Markdown 正文' }).value, '收起预览时仍保留的输入')
  assert.equal(view.getByRole('button', { name: '源码' }).getAttribute('aria-pressed'), 'true')
  assert.equal(fixture.commands.some(command => command.action === 'saveRequirement'), false)
})

test('comparison summary failures are local and can be retried without opening a material', async () => {
  let fail = true
  const fixture = requirementPanel(false, undefined, (_command, state) => fail ? { ok: false, code: 'UNAVAILABLE', message: '最近结论服务暂不可用' } : { ok: true, state })
  const view = fixture.render()
  fireEvent.click(view.getByRole('button', { name: /^需求协同/ }))
  await act(async () => {})
  assert.match(view.getByRole('alert').textContent, /对比未知：最近结论服务暂不可用/)
  assert.ok(view.getByText('对比未知'))
  fail = false
  fireEvent.click(view.getByRole('button', { name: '重试读取最近对比' }))
  await act(async () => {})
  assert.equal(view.queryByRole('alert'), null)
  assert.equal(fixture.commands.filter(command => command.action === 'listConsistencySummaries').length, 2)
})

test('the requirement directory periodically reads comparison summaries shared by other members', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const fixture = requirementPanel(), view = fixture.render()
  fireEvent.click(view.getByRole('button', { name: /^需求协同/ }))
  await act(async () => {})
  assert.equal(fixture.commands.filter(command => command.action === 'listConsistencySummaries').length, 1)
  await act(async () => t.mock.timers.tick(10_000))
  assert.equal(fixture.commands.filter(command => command.action === 'listConsistencySummaries').length, 2)
  view.unmount()
})

test('declining a proposal and starting a new requirement session use requirement commands', async () => {
  const fixture = requirementPanel(), view = fixture.render()
  await selectRequirement(view)
  const review = openWriteReview(view)
  await waitFor(() => assert.equal(within(review).getByRole('button', { name: '不写入' }).disabled, false))
  fireEvent.click(within(review).getByRole('button', { name: '不写入' }))
  await waitFor(() => assert.ok(fixture.commands.some(command => command.action === 'resolveRequirementWriteProposal')))
  const decline = fixture.commands.find(command => command.action === 'resolveRequirementWriteProposal')
  assert.deepEqual(decline, { action: 'resolveRequirementWriteProposal', entityId: 'requirement', proposalId: 'proposal-original', decision: 'reject', expectedHash: 'hash-initial' })
  fireEvent.click(view.getByLabelText('会话与模板操作'))
  fireEvent.click(view.getByRole('button', { name: '新会话' }))
  await waitFor(() => assert.ok(fixture.commands.some(command => command.action === 'newRequirementSession')))
  assert.equal(fixture.commands.some(command => command.action === 'startSession' || command.action === 'saveMaterial'), false)
})

test('requirement confirmation submits the current full input without a separate save command', async () => {
  const fixture = requirementPanel(), view = fixture.render()
  await selectRequirement(view)
  editRequirementBody(view, '用户最终阅读的正文')
  confirmRequirement(view)
  await waitFor(() => assert.ok(fixture.commands.some(command => command.action === 'confirmRequirement')))
  const confirmation = fixture.commands.find(command => command.action === 'confirmRequirement')
  assert.equal(confirmation.entityId, 'requirement')
  assert.equal(confirmation.expectedHash, 'hash-initial')
  assert.equal(confirmation.body, '用户最终阅读的正文')
  assert.equal(confirmation.metadata.kind, 'requirement')
  assert.equal(confirmation.method, 'direct')
  assert.match(confirmation.operationId, /^[a-f0-9-]{36}$/)
  assert.equal(fixture.commands.some(command => command.action === 'saveRequirement' || command.action === 'confirmMaterial'), false)
  assert.equal(view.queryByRole('button', { name: '切换固定模板' }), null)
})

test('confirmed requirements render their fixed text and require an explicit revision before editing', async () => {
  const fixture = requirementPanel(true), view = fixture.render()
  await selectRequirement(view)
  assert.equal(view.queryByRole('textbox', { name: '需求 Markdown 正文' }), null)
  assert.equal(view.queryByRole('button', { name: '确认材料' }), null)
  assert.match(view.getByRole('region', { name: '需求说明' }).textContent, /原始业务正文/)
  await waitFor(() => assert.equal(view.getByRole('button', { name: '开始修订需求' }).disabled, false))
  fireEvent.click(view.getByRole('button', { name: '开始修订需求' }))
  await waitFor(() => assert.ok(fixture.commands.some(command => command.action === 'startRequirementRevision')))
  assert.deepEqual(fixture.commands.find(command => command.action === 'startRequirementRevision'), { action: 'startRequirementRevision', entityId: 'requirement', expectedRevision: 3 })
})

test('the plugin contributes the attachment button to the native composer left slot', () => {
  const entry = readFileSync(path.join(client, 'index.ts'), 'utf8')
  assert.match(entry, /slots\.inject\('conversation\.input\.left',\s*\(\)\s*=>\s*ctx\.slots\.register\(\{\s*name:\s*'conversation\.input\.left',\s*id:\s*'studio-material-attachments',\s*order:\s*0,?\s*\},\s*MaterialAttachmentButton\)\)/)
})

test('scenario and requirement pages reach the shared attachment conversation without an old inline source panel', () => {
  for (const relative of ['scenarios/ScenarioWorkspace.tsx', 'requirements/RequirementWorkspace.tsx']) {
    const contents = readFileSync(path.join(client, relative), 'utf8')
    assert.match(contents, /<MaterialConversation\b/, `${relative} must use the shared material conversation`)
    assert.doesNotMatch(contents, /<ScenarioEvidence\b/)
  }
  const chatPanel = readFileSync(path.join(client, 'scenarios/ScenarioChatPanel.tsx'), 'utf8')
  assert.doesNotMatch(chatPanel, /<ScenarioEvidence\b/)
})

test('a directory-only failure keeps the acknowledged draft and retries the original confirmation', async () => {
  let original
  const fixture = requirementPanel(false, undefined, undefined, (command, state) => {
    if (command.action === 'confirmRequirement') {
      original = command.operationId
      const draft = { ...state.requirement.draft, body: command.body, metadata: command.metadata, sha256: 'hash-written' }
      return { ok: true, state: { ...state, drafts: [draft], requirement: { ...state.requirement, draft,
        requirementSave: { operationId: original, phase: 'directory', status: 'pending', reason: 'network', documentSaved: true, message: '目录更新暂未完成' },
        confirmationRecovery: { operationId: original, message: '等待目录更新后继续确认' },
      } } }
    }
    if (command.action === 'retryRequirementSave') {
      assert.equal(command.operationId, original)
      const { requirementSave, confirmationRecovery, ...requirement } = state.requirement
      return { ok: true, state: { ...state, requirement } }
    }
  })
  const view = fixture.render()
  await selectRequirement(view)
  editRequirementBody(view, '磁盘上已经保存的正文')
  confirmRequirement(view)
  const recovery = await waitFor(() => view.getByRole('region', { name: '需求保存恢复' }))
  assert.ok(within(recovery).getByText('正文已保存，剩余更新仍待完成。'))
  assert.equal(view.getByRole('textbox', { name: '需求 Markdown 正文' }).value, '磁盘上已经保存的正文')
  assert.equal(view.queryByRole('region', { name: '外部文件冲突' }), null)
  assert.match(view.getByRole('region', { name: '需求说明' }).textContent, /保存未完成/)
  await waitFor(() => assert.equal(within(recovery).getByRole('button', { name: '重试保存并继续确认' }).disabled, false))
  fireEvent.click(within(recovery).getByRole('button', { name: '重试保存并继续确认' }))
  await waitFor(() => assert.equal(!!view.queryByRole('region', { name: '需求保存恢复' }), false))
  assert.equal(fixture.commands.filter(command => command.action === 'confirmRequirement').length, 1)
  assert.equal(fixture.commands.filter(command => command.action === 'retryRequirementSave').length, 1)
})

test('a confirmation that lands on externally edited content loads it and keeps the input recoverable', async () => {
  let first = true
  const fixture = requirementPanel(false, undefined, undefined, (command, state) => {
    if (command.action === 'confirmRequirement' && first) {
      first = false
      const actual = { ...state.requirement.draft, body: '另一个编辑器写入的正文', sha256: 'hash-external' }
      return { ok: true, state: { ...state, drafts: [actual], requirement: { ...state.requirement, draft: actual,
        confirmationRecovery: { operationId: command.operationId, message: '继续原确认' } } } }
    }
    if (command.action === 'confirmRequirement') {
      const draft = { ...state.requirement.draft, body: command.body, metadata: command.metadata, sha256: 'hash-confirmed' }
      const { confirmationRecovery, ...requirement } = state.requirement
      return { ok: true, state: { ...state, drafts: [draft], requirement: { ...requirement, draft } } }
    }
  })
  const view = fixture.render()
  await selectRequirement(view)
  editRequirementBody(view, '用户尚未保存的正文')
  confirmRequirement(view)
  const body = view.getByRole('textbox', { name: '需求 Markdown 正文' })
  await waitFor(() => assert.equal(body.value, '另一个编辑器写入的正文'))
  assert.equal(view.queryByRole('region', { name: '外部文件冲突' }), null)
  confirmRequirement(view)
  await waitFor(() => assert.equal(fixture.commands.filter(command => command.action === 'confirmRequirement').length, 2))
  const confirmed = fixture.commands.filter(command => command.action === 'confirmRequirement')
  assert.equal(confirmed[1].body, '另一个编辑器写入的正文')
  assert.equal(confirmed[1].expectedHash, 'hash-external')
})

test('a failed confirmation channel preserves input and reuses the exact request until the author changes it', async () => {
  const fixture = requirementPanel(false, undefined, undefined, command => command.action === 'confirmRequirement' ? { ok: false, code: 'CHANNEL_FAILED', message: '连接未恢复，请选择重试' } : undefined)
  const view = fixture.render()
  await selectRequirement(view)
  editRequirementBody(view, '需要保留的内容')
  confirmRequirement(view)
  const recovery = await waitFor(() => view.getByRole('region', { name: '需求保存恢复' }))
  await waitFor(() => assert.equal(within(recovery).getByRole('button', { name: '重试保存并继续确认' }).disabled, false))
  fireEvent.click(within(recovery).getByRole('button', { name: '重试保存并继续确认' }))
  await waitFor(() => assert.equal(fixture.commands.filter(command => command.action === 'confirmRequirement').length, 2))
  const unchanged = fixture.commands.filter(command => command.action === 'confirmRequirement')
  assert.deepEqual(unchanged[1], unchanged[0])
  await waitFor(() => assert.equal(within(recovery).getByRole('button', { name: '修改内容或关系' }).disabled, false))
  fireEvent.click(within(recovery).getByRole('button', { name: '修改内容或关系' }))
  fireEvent.change(view.getByRole('textbox', { name: '需求 Markdown 正文' }), { target: { value: '用户新选择的内容' } })
  confirmRequirement(view)
  await waitFor(() => assert.equal(fixture.commands.filter(command => command.action === 'confirmRequirement').length, 3))
  const changed = fixture.commands.filter(command => command.action === 'confirmRequirement')[2]
  assert.equal(changed.body, '用户新选择的内容')
  assert.notEqual(changed.operationId, unchanged[0].operationId)
})

test('invalid requirement fields offer a correction path before continuing the same confirmation', async () => {
  const fixture = requirementPanel(), view = fixture.render()
  await selectRequirement(view)
  editRequirementBody(view, '正文保持可见')
  const evidence = view.getByRole('textbox', { name: /正式依据（JSON/ })
  fireEvent.change(evidence, { target: { value: '{还没输入完' } })
  confirmRequirement(view)
  await waitFor(() => assert.ok(view.getByRole('region', { name: '需求保存恢复' })))
  assert.equal(fixture.commands.some(command => command.action === 'confirmRequirement'), false)
  assert.ok(view.getByRole('button', { name: '修正业务字段' }))
  fireEvent.change(evidence, { target: { value: '[]' } })
  confirmRequirement(view)
  await waitFor(() => assert.ok(fixture.commands.some(command => command.action === 'confirmRequirement')))
  assert.equal(fixture.commands.find(command => command.action === 'confirmRequirement').body, '正文保持可见')
})

test('the shared requirement editor distinguishes written bytes from a pending directory update', async () => {
  let flush, saved, retries = 0
  const pending = { operationId: 'saved-request', phase: 'directory', status: 'pending', reason: 'network', documentSaved: true, message: '目录仍待同步' }
  const view = render(editableRequirement(async input => {
    saved = input
    const reply = savedMaterialReply(input)
    reply.state.requirement = { entityId: 'requirement', draft: reply.state.drafts[0], requirementSave: pending }
    return reply
  }, next => { flush = next }, { onRetrySave: async id => { assert.equal(id, pending.operationId); retries++; const reply = savedMaterialReply(saved); reply.state.requirement = { entityId: 'requirement', draft: reply.state.drafts[0] }; return reply } }))
  fireEvent.change(view.getByRole('textbox', { name: '材料 Markdown 正文' }), { target: { value: '已经写入文件的内容' } })
  await act(async () => { assert.equal(await flush(), true) })
  const recovery = view.getByRole('region', { name: '需求保存恢复' })
  assert.ok(within(recovery).getByText('正文已保存，剩余更新仍待完成。'))
  fireEvent.click(within(recovery).getByRole('button', { name: '核对并重试保存' }))
  await waitFor(() => assert.equal(retries, 1))
  await waitFor(() => assert.equal(!!view.queryByRole('region', { name: '需求保存恢复' }), false))
})

test('explicitly reacquiring the edit right uses a new save operation and continues confirmation', async () => {
  let attempted = false
  const fixture = requirementPanel(false, undefined, undefined, (command, state) => {
    if (command.action === 'confirmRequirement' && !attempted) {
      attempted = true
      return { ok: true, state: { ...state, requirement: { ...state.requirement,
        requirementSave: { operationId: command.operationId, phase: 'relations', status: 'recovery', reason: 'occupation', documentSaved: false, message: '编辑权已变化，请核对' },
        confirmationRecovery: { operationId: command.operationId, message: '选择恢复并继续确认' },
      } } }
    }
    if (command.action === 'confirmRequirement') {
      const draft = { ...state.requirement.draft, body: command.body, metadata: command.metadata, sha256: 'hash-reclaimed' }
      const { requirementSave, confirmationRecovery, ...requirement } = state.requirement
      return { ok: true, state: { ...state, drafts: [draft], requirement: { ...requirement, draft } } }
    }
  })
  const view = fixture.render()
  await selectRequirement(view)
  editRequirementBody(view, '重新取得编辑权后仍需保存的内容')
  confirmRequirement(view)
  const recovery = await waitFor(() => view.getByRole('region', { name: '需求保存恢复' }))
  const reclaim = within(recovery).getByRole('button', { name: '核对并重新取得编辑权' })
  await waitFor(() => assert.equal(reclaim.disabled, false))
  fireEvent.click(reclaim)
  await waitFor(() => assert.equal(fixture.commands.filter(command => command.action === 'confirmRequirement').length, 2))
  const confirmations = fixture.commands.filter(command => command.action === 'confirmRequirement')
  assert.equal(confirmations[1].body, confirmations[0].body)
  assert.notEqual(confirmations[1].operationId, confirmations[0].operationId)
  const repeatedOpen = fixture.commands.findLastIndex(command => command.action === 'openRequirement')
  assert.equal(fixture.commands[repeatedOpen - 1].action, 'state')
  await waitFor(() => assert.equal(!!view.queryByRole('region', { name: '需求保存恢复' }), false))
})

test('a late explicit confirmation reply preserves a queued edit over the separately observed external version', async () => {
  let finish, submitted
  const fixture = requirementPanel(false, undefined, undefined, (command, state) => {
    if (command.action === 'confirmRequirement') return new Promise(resolve => {
      submitted = command
      finish = () => {
        const draft = { ...state.requirement.draft, body: command.body, metadata: command.metadata, sha256: 'hash-confirmed-input' }
        resolve({ ok: true, state: { ...state, drafts: [draft], requirement: { ...state.requirement, draft } } })
      }
    })
  })
  const view = fixture.render()
  await selectRequirement(view)
  editRequirementBody(view, '本次明确提交的内容')
  confirmRequirement(view)
  await waitFor(() => assert.equal(typeof finish, 'function'))
  const body = view.getByRole('textbox', { name: '需求 Markdown 正文' })
  assert.equal(body.readOnly, true, 'the visible editor freezes while the explicit command is running')
  assert.equal(view.getByRole('textbox', { name: /正式依据（JSON/ }).readOnly, true)
  assert.equal(view.queryByLabelText('需求名称'), null)
  // An input event already queued before the editor froze must also survive the reply.
  fireEvent.change(body, { target: { value: '确认期间排队到达的新输入' } })
  await act(async () => fixture.project(state => {
    const draft = { ...state.requirement.draft, body: '外部编辑器的新版本', sha256: 'hash-separate-external' }
    return { ...state, drafts: [draft], requirement: { ...state.requirement, draft } }
  }))
  const notice = await waitFor(() => view.getByRole('region', { name: '文件外部更新' }))
  assert.match(notice.textContent, /你此前未保存的输入仍可恢复/)
  await act(async () => finish())
  await waitFor(() => assert.equal(body.value, '外部编辑器的新版本'))
  fireEvent.click(within(notice).getByRole('button', { name: '恢复未保存输入' }))
  assert.equal(body.value, '确认期间排队到达的新输入')
  assert.equal(submitted.body, '本次明确提交的内容')
})

test('reopening an unfinished confirmation shows the durable unsaved input and retries its original operation', async () => {
  let savedInput
  const fixture = requirementPanel(false, undefined, undefined, (command, state) => {
    if (command.action === 'retryRequirementSave') {
      assert.equal(command.operationId, 'before-restart')
      const draft = { ...state.requirement.draft, ...savedInput, sha256: 'hash-recovered' }
      const { requirementSave, confirmationRecovery, ...requirement } = state.requirement
      return { ok: true, state: { ...state, drafts: [draft], requirement: { ...requirement, draft } } }
    }
  }, state => {
    savedInput = { body: '重启前尚未写入文件的完整正文', metadata: { ...state.requirement.draft.metadata, title: '重启前的新标题' } }
    return { ...state, requirement: { ...state.requirement,
      requirementSave: { operationId: 'before-restart', phase: 'relations', status: 'recovery', reason: 'network', documentSaved: false, message: '重启前保存尚未完成', input: savedInput },
      confirmationRecovery: { operationId: 'before-restart', message: '继续原确认' },
    } }
  })
  const view = fixture.render()
  await selectRequirement(view)
  fireEvent.click(view.getByRole('button', { name: '源码' }))
  assert.equal(view.getByRole('textbox', { name: '需求 Markdown 正文' }).value, savedInput.body)
  assert.equal(view.getByLabelText('需求名称').value, savedInput.metadata.title)
  await new Promise(resolve => setTimeout(resolve, 900))
  assert.equal(fixture.commands.some(command => command.action === 'saveRequirement'), false, 'restoration itself does not write or invent an input hash')
  const deferred = view.getByRole('region', { name: '需求保存恢复' })
  fireEvent.click(within(deferred).getByRole('button', { name: '稍后继续' }))
  fireEvent.click(view.getByRole('button', { name: '返回需求协同列表' }))
  await waitFor(() => assert.equal(!!view.queryByRole('region', { name: '需求对话' }), false))
  fireEvent.click(view.getByRole('button', { name: /需求能力/ }))
  await waitFor(() => assert.ok(view.getByRole('region', { name: '需求对话' })))
  fireEvent.click(view.getByRole('button', { name: '源码' }))
  assert.equal(view.getByRole('textbox', { name: '需求 Markdown 正文' }).value, savedInput.body)
  const recovery = view.getByRole('region', { name: '需求保存恢复' })
  fireEvent.click(within(recovery).getByRole('button', { name: '重试保存并继续确认' }))
  await waitFor(() => assert.equal(!!view.queryByRole('region', { name: '需求保存恢复' }), false))
  assert.equal(fixture.commands.filter(command => command.action === 'retryRequirementSave').length, 1)
  assert.equal(fixture.commands.some(command => command.action === 'confirmRequirement'), false)
  assert.equal(view.getByRole('textbox', { name: '需求 Markdown 正文' }).value, savedInput.body)
})

test('a readonly revision keeps its recovery choices and labels retained input separately from the confirmed version', async () => {
  const retained = '丢失编辑权前尚未写入的修订内容'
  const fixture = requirementPanel(true, undefined, undefined, (command, state) => {
    if (command.action === 'startRequirementRevision') {
      assert.equal(command.expectedRevision, 3)
      return { ok: true, state: { ...state, requirement: { ...state.requirement, readOnly: false } } }
    }
    if (command.action === 'confirmRequirement') {
      const draft = { ...state.requirement.draft, body: command.body, metadata: command.metadata, sha256: 'hash-after-reclaim' }
      const { requirementSave, confirmationRecovery, ...requirement } = state.requirement
      return { ok: true, state: { ...state, drafts: [draft], requirement: { ...requirement, draft } } }
    }
  }, state => ({ ...state,
    collaboration: { ...state.collaboration, entities: state.collaboration.entities.map(entity => ({ ...entity, current: { version: 1, confirmationId: 'accepted-before-revision', metadata: state.requirement.draft.metadata, fixed: { commitSha: 'a'.repeat(40), path: state.requirement.draft.path, sha256: state.requirement.draft.sha256 }, confirmedBy: 1, confirmedAt: '2026-10-23T00:00:00Z' } })) },
    requirement: { ...state.requirement,
      requirementSave: { operationId: 'readonly-revision', phase: 'relations', status: 'recovery', reason: 'occupation', documentSaved: false, message: '编辑权需要重新取得', input: { body: retained, metadata: state.requirement.draft.metadata } },
      confirmationRecovery: { operationId: 'readonly-revision', message: '用户选定恢复方案后继续确认' },
    },
  }))
  const view = fixture.render()
  await selectRequirement(view)
  const recovery = view.getByRole('region', { name: '需求保存恢复' })
  const spec = view.getByRole('region', { name: '需求说明' })
  assert.match(spec.textContent, /保留的未保存输入/)
  assert.doesNotMatch(spec.textContent, /固定版本 v1/)
  fireEvent.click(within(recovery).getByRole('button', { name: '查看保留的输入' }))
  const body = view.getByRole('textbox', { name: '需求 Markdown 正文' })
  assert.equal(body.value, retained)
  assert.equal(body.readOnly, true)
  assert.equal(fixture.commands.some(command => command.action === 'confirmRequirement' || command.action === 'saveRequirement'), false)
  fireEvent.click(within(recovery).getByRole('button', { name: '核对并重新取得编辑权' }))
  await waitFor(() => assert.ok(fixture.commands.some(command => command.action === 'confirmRequirement')))
  assert.ok(fixture.commands.some(command => command.action === 'startRequirementRevision'))
  assert.equal(fixture.commands.find(command => command.action === 'confirmRequirement').body, retained)
})

test('confirmation recovery uses the current version after corrected input has already autosaved', async () => {
  const fixture = requirementPanel(false, undefined, undefined, (command, state) => {
    if (command.action === 'retryRequirementSave') assert.fail('changed saved input must not retry the old confirmation hash')
    if (command.action === 'confirmRequirement') {
      const draft = { ...state.requirement.draft, body: command.body, metadata: command.metadata, sha256: 'hash-confirmed' }
      const { confirmationRecovery, ...requirement } = state.requirement
      return { ok: true, state: { ...state, drafts: [draft], requirement: { ...requirement, draft } } }
    }
  }, state => ({ ...state, requirement: { ...state.requirement,
    confirmationRecovery: { operationId: 'earlier-confirmation', expectedHash: 'hash-initial', message: '请修正内容后继续确认' },
  } }))
  const view = fixture.render()
  await selectRequirement(view)
  editRequirementBody(view, '用户已经修正并自动保存的内容')
  await waitFor(() => assert.ok(fixture.commands.some(command => command.action === 'saveRequirement')), { timeout: 3000 })
  await act(async () => {})
  await waitFor(() => assert.equal(view.getByRole('button', { name: '保存', exact: true }).disabled, true))
  fireEvent.click(within(view.getByRole('region', { name: '需求保存恢复' })).getByRole('button', { name: '重试保存并继续确认' }))
  await waitFor(() => assert.equal(fixture.commands.filter(command => command.action === 'confirmRequirement').length, 1))
  const command = fixture.commands.find(command => command.action === 'confirmRequirement')
  assert.equal(command.body, '用户已经修正并自动保存的内容')
  assert.equal(command.expectedHash, 'hash-saved')
  assert.notEqual(command.operationId, 'earlier-confirmation')
  assert.equal(fixture.commands.some(command => command.action === 'retryRequirementSave'), false)
})
