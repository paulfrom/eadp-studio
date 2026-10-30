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
const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const name of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = reactRequire('react')
const { render, fireEvent, cleanup } = buildRequire('@testing-library/react')
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
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Menu: menuFixture(React) }
    if (specifier.endsWith('.css')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
    if (specifier.startsWith('.')) return loadClient(path.relative(client, path.resolve(path.dirname(filename), specifier)))
    return reactRequire(specifier)
  }, module, module.exports)
  return module.exports
}

const { ScenarioGates } = loadClient('scenarios/ScenarioGates.tsx')
const { ScenarioFrontmatter } = loadClient('scenarios/ScenarioFrontmatter.tsx')
const { ScenarioWriteProposalCard } = loadClient('scenarios/ScenarioWriteProposalCard.tsx')
const { MaterialDecisionQuestions, MaterialDecisionQuestionDock } = loadClient('components/MaterialDecisionQuestions.tsx')
const h = React.createElement

function workspace(overrides = {}) {
  return {
    readOnly: false,
    conflict: undefined,
    repair: undefined,
    gates: [{ id: 'business', label: '业务完整性', status: 'blocked', messages: ['缺少规则'] }],
    structureCheck: true,
    settlement: { status: 'cleanup-pending', cleanup: { status: 'blocked', steps: { resources: true, archive: false, worktree: false, branch: false, history: false }, message: '归档等待重试' } },
    git: { dirty: true, branch: 'studio/scenario/1', head: 'abcdef0123456789' },
    ...overrides,
  }
}

function metadata() {
  return { kind: 'scenario', entityId: 'scene-id', title: '订单审批', templateId: 'default', templateRef: { path: '.template/default.md', commitSha: '1234567890abcdef', sha256: 'a'.repeat(64) }, flowComplete: false, openQuestions: [{ blocking: true, limitation: '失败如何处理', excludedScope: '' }] }
}

test('confirmation checks show gate reasons and declarations while details stay collapsed', () => {
  const edits = []
  const buffer = { edit: value => edits.push(value) }
  const snapshot = { body: '## 流程', metadata: metadata(), dirty: true }
  const view = render(h(ScenarioGates, { workspace: workspace(), disabled: false, dirty: true, buffer, snapshot, onConfirm() {}, onRepair() {}, onResume() {}, onCancel() {}, onStructureCheck() {} }))
  assert.ok(view.getByRole('region', { name: '业务完整性 · 阻断' }))
  assert.match(view.container.textContent, /1 项门禁阻断/)
  assert.match(view.container.textContent, /缺少规则/)
  assert.equal(view.getByText(/^待澄清项/, { selector: 'summary' }).parentElement.open, false)
  assert.equal(view.getByText('Git 诊断').parentElement.open, false)
  assert.match(view.container.textContent, /已确认待清理/)
  const criteria = view.getByRole('checkbox', { name: '业务流程完整' })
  assert.equal(criteria.disabled, false)
  fireEvent.click(criteria)
  assert.equal(edits.at(-1).metadata.flowComplete, true)
  fireEvent.click(view.getByText('Git 诊断'))
  assert.match(view.container.textContent, /studio\/scenario\/1/)
})

test('scenario evidence warnings allow confirmation and details default to nonblocking', () => {
  const edits = [], confirmed = []
  const material = { ...metadata(), flowComplete: true, openQuestions: [], businessEvidence: [] }
  const view = render(h(ScenarioGates, {
    workspace: workspace({ settlement: { status: 'draft' }, gates: [
      { id: 'business', label: '业务流程', status: 'passed', messages: [] },
      { id: 'evidence', label: '资料与引用', status: 'warning', messages: ['尚未选定资料，不影响场景确认'] },
    ] }), disabled: false, dirty: false, buffer: { edit: value => edits.push(value) },
    snapshot: { body: '按金额进入审批，阈值在需求阶段确认', metadata: material },
    onConfirm: () => confirmed.push(true), onRepair() {}, onResume() {}, onCancel() {}, onStructureCheck() {},
  }))
  assert.ok(view.getByRole('region', { name: '资料与引用 · 提醒，不阻断' }))
  assert.equal(view.queryByRole('checkbox', { name: '验收条件可以客观判断' }), null)
  const confirm = view.getByRole('button', { name: '确认当前场景' })
  assert.equal(confirm.disabled, false)
  fireEvent.click(confirm)
  assert.deepEqual(confirmed, [true])
  fireEvent.click(view.getByRole('button', { name: '添加待澄清项' }))
  assert.equal(edits.at(-1).metadata.openQuestions[0].blocking, false)
})

test('invalid scenario citations can be explicitly removed while local source state remains intact', () => {
  const edits = []
  const invalid = { label: '损坏资料' }, valid = { label: '有效资料' }
  const material = { ...metadata(), businessEvidence: [invalid, valid] }
  const sources = [{ id: 'source', formal: true }]
  const view = render(h(ScenarioGates, {
    workspace: workspace({ sources, gates: [{ id: 'evidence', label: '资料与引用', status: 'warning', messages: ['引用无法验证'], invalidEvidenceIndexes: [0] }] }),
    disabled: false, dirty: false, buffer: { edit: value => edits.push(value) },
    snapshot: { body: '原始业务正文', metadata: material }, onConfirm() {}, onRepair() {}, onResume() {}, onCancel() {}, onStructureCheck() {},
  }))
  fireEvent.click(view.getByRole('button', { name: '移除无效正式引用，保留本地资料' }))
  assert.deepEqual(edits.at(-1).metadata.businessEvidence, [valid])
  assert.equal(edits.at(-1).body, '原始业务正文')
  assert.deepEqual(sources, [{ id: 'source', formal: true }])
})

test('business gate reveals editable questions and preserves the rest of the material', () => {
  const edits = []
  const material = metadata()
  const view = render(h(ScenarioGates, {
    workspace: workspace(), disabled: false, dirty: false, buffer: { edit: value => edits.push(value) },
    snapshot: { body: '## 当前流程', metadata: material }, onConfirm() {}, onRepair() {}, onResume() {}, onCancel() {}, onStructureCheck() {},
  }))
  fireEvent.click(view.getByRole('button', { name: '查看待澄清' }))
  assert.equal(view.getByText(/^待澄清项/, { selector: 'summary' }).parentElement.open, true)
  fireEvent.change(view.getByRole('textbox', { name: '待澄清项 1 问题或限制' }), { target: { value: '失败后人工处理' } })
  assert.equal(edits.at(-1).body, '## 当前流程')
  assert.equal(edits.at(-1).metadata.title, material.title)
  assert.deepEqual(edits.at(-1).metadata.openQuestions, [{ blocking: true, limitation: '失败后人工处理', excludedScope: '' }])
  fireEvent.click(view.getByRole('checkbox', { name: '流程无法确定，阻断确认' }))
  assert.equal(edits.at(-1).metadata.openQuestions[0].blocking, false)
  fireEvent.click(view.getByRole('button', { name: '删除此项' }))
  assert.deepEqual(edits.at(-1).metadata.openQuestions, [])
})

test('paused repairs lock declarations and retain explicit answer and cancel actions', () => {
  const resumed = []
  let cancelled = 0
  const view = render(h(ScenarioGates, {
    workspace: workspace({ repair: { status: 'paused', roundsUsed: 2, question: '由谁处理失败单？' } }),
    disabled: false, dirty: false, buffer: { edit() {} }, snapshot: { body: '', metadata: metadata() },
    onConfirm() {}, onRepair() {}, onResume: value => resumed.push(value), onCancel: () => { cancelled += 1 }, onStructureCheck() {},
  }))
  assert.equal(view.getByRole('checkbox', { name: '业务流程完整' }).disabled, true)
  assert.equal(view.getByRole('button', { name: '确认当前场景' }).disabled, true)
  fireEvent.change(view.getByRole('textbox', { name: '补充业务答案' }), { target: { value: '  客服主管处理  ' } })
  fireEvent.click(view.getByRole('button', { name: '补充并继续修复确认' }))
  assert.deepEqual(resumed, ['客服主管处理'])
  fireEvent.click(view.getByRole('button', { name: '取消本次修复任务' }))
  assert.equal(cancelled, 1)
})

test('template checks wait for saved input and confirmed materials keep their checks read-only', () => {
  const changes = []
  const props = {
    workspace: workspace({ gates: [{ id: 'template', label: '模板结构', status: 'passed', messages: [] }] }),
    disabled: false, dirty: false, buffer: { edit() {} }, snapshot: { body: '', metadata: metadata() },
    onConfirm() {}, onRepair() {}, onResume() {}, onCancel() {}, onStructureCheck: value => changes.push(value),
  }
  const view = render(h(ScenarioGates, props))
  fireEvent.click(view.getByRole('checkbox', { name: '结构检查' }))
  assert.deepEqual(changes, [false])
  view.rerender(h(ScenarioGates, { ...props, dirty: true }))
  assert.equal(view.getByRole('checkbox', { name: '结构检查' }).disabled, true)
  view.rerender(h(ScenarioGates, { ...props, workspace: { ...props.workspace, readOnly: true } }))
  assert.equal(view.getByRole('checkbox', { name: '业务流程完整' }).disabled, true)
  assert.equal(view.getByRole('checkbox', { name: '结构检查' }).disabled, true)
  assert.equal(view.queryByRole('button', { name: '确认当前场景' }), null)
  assert.equal(view.queryByRole('button', { name: 'AI 修复并确认' }), null)
})

test('scenario identity retains code, title, template reference, local state and audit time', () => {
  const view = render(h(ScenarioFrontmatter, {
    entity: { id: 'scene-id', code: 'SC-0007', title: '订单审批', materialVersion: 0, lastEditor: { at: '2026-10-22T08:30:00.000Z' } },
    buffer: { edit() {} }, snapshot: { body: '', metadata: metadata() }, readOnly: false, editingDisabled: false, busy: false, onBindTemplate() {},
  }))
  assert.match(view.container.textContent, /SC-0007 · 订单审批/)
  assert.match(view.container.textContent, /本地草稿/)
  assert.match(view.container.textContent, /固定版本 \.template\/default\.md · 1234567890ab/)
  assert.match(view.container.textContent, /2026-10-22 08:30:00/)
})

test('write proposals require review and allow a selected chapter write or a cancellation', () => {
  const resolved = []
  const onResolve = (...input) => resolved.push(input)
  const changes = [
    { id: 'rules', title: '业务规则', before: '旧规则', after: '新规则', kind: 'changed', addedLines: 1, removedLines: 1 },
    { id: 'acceptance', title: '验收条件', before: '旧条件', after: '新条件', kind: 'changed', addedLines: 1, removedLines: 1 },
  ]
  const proposal = { id: 'proposal', baseHash: 'a'.repeat(64), createdAt: '2026-10-22T08:30:00.000Z', conclusions: ['规则已确认'], evidenceIds: ['source-one'], status: 'pending', changes }
  const pending = render(h(ScenarioWriteProposalCard, { proposal, disabled: false, onResolve }))
  assert.match(pending.container.textContent, /待审阅/)
  fireEvent.click(pending.getByRole('button', { name: '审阅 2 处变更' }))
  assert.equal(resolved.length, 0)
  const dialog = pending.getByRole('dialog', { name: '审阅写入变更' })
  assert.match(dialog.textContent, /旧规则/)
  assert.match(dialog.textContent, /新规则/)
  fireEvent.click(pending.getByRole('checkbox', { name: /验收条件/ }))
  fireEvent.click(pending.getByRole('button', { name: '写入所选的 1 处' }))
  assert.deepEqual(resolved, [['write', ['rules']]])
  fireEvent.click(pending.getByRole('button', { name: '审阅 2 处变更' }))
  fireEvent.click(pending.getByRole('button', { name: '取消' }))
  assert.equal(resolved.length, 1)
  pending.rerender(h(ScenarioWriteProposalCard, { proposal: { ...proposal, error: '正文已变化' }, disabled: false, onResolve }))
  assert.match(pending.container.textContent, /失败，可重试/)
  assert.ok(pending.getByRole('button', { name: '重新审阅' }))
  pending.rerender(h(ScenarioWriteProposalCard, { proposal: { ...proposal, status: 'consumed' }, disabled: false, onResolve }))
  assert.match(pending.container.textContent, /已写入/)
})

test('review selection is explicit, supports select all and disables an empty write', () => {
  const changes = [{ id: 'one', title: '范围', before: '', after: '新内容', kind: 'added', addedLines: 1, removedLines: 0 }]
  const proposal = { id: 'proposal', conclusions: [], evidenceIds: [], status: 'pending', target: 'context', changes }
  const resolved = []
  const props = { proposal, disabled: false, onResolve: (...input) => resolved.push(input) }
  const view = render(h(ScenarioWriteProposalCard, { ...props, reviewRequested: 0 }))
  view.rerender(h(ScenarioWriteProposalCard, { ...props, reviewRequested: 1 }))
  assert.ok(view.getByRole('dialog', { name: '审阅写入变更' }))
  fireEvent.click(view.getByRole('checkbox', { name: '全选' }))
  assert.equal(view.getByRole('button', { name: '写入所选的 0 处' }).disabled, true)
  fireEvent.click(view.getByRole('checkbox', { name: '全选' }))
  assert.equal(view.getByRole('button', { name: '写入所选的 1 处' }).disabled, false)
  fireEvent.click(view.getByRole('button', { name: '不写入' }))
  assert.deepEqual(resolved, [['reject']])
})


test('a remounted proposal ignores an old review request and opens only after another toolbar request', () => {
  const changes = [{ id: 'rules', title: '业务规则', before: '旧规则', after: '新规则', kind: 'changed', addedLines: 1, removedLines: 1 }]
  const props = { disabled: false, hideReviewAction: true, onResolve() {} }
  const proposal = { id: 'first', conclusions: [], evidenceIds: [], status: 'pending', changes }
  const first = render(h(ScenarioWriteProposalCard, { ...props, proposal, reviewRequested: 0 }))
  first.rerender(h(ScenarioWriteProposalCard, { ...props, proposal, reviewRequested: 1 }))
  assert.ok(first.getByRole('dialog', { name: '审阅写入变更' }))
  first.unmount()

  const nextProposal = { ...proposal, id: 'next' }
  const remounted = render(h(ScenarioWriteProposalCard, { ...props, proposal: nextProposal, reviewRequested: 1 }))
  assert.equal(remounted.queryByRole('dialog', { name: '审阅写入变更' }), null)
  remounted.rerender(h(ScenarioWriteProposalCard, { ...props, proposal: nextProposal, reviewRequested: 2 }))
  assert.ok(remounted.getByRole('dialog', { name: '审阅写入变更' }))
  remounted.rerender(h(ScenarioWriteProposalCard, { ...props, proposal: { ...proposal, id: 'replacement' }, reviewRequested: 2 }))
  assert.equal(remounted.queryByRole('dialog', { name: '审阅写入变更' }), null)
})

test('question choices use the native revision-guarded insertion action and never replace selected text', () => {
  const turn = { id: 'turn-1', sessionId: 'session-1', createdAt: '2026-10-25T00:00:00Z', stale: false, questions: [{
    id: 'turn-1:Q1', title: '退款由谁审批？', reason: '资料未明确审批人。', evidenceIds: [], options: [
      { id: 'turn-1:Q1:A', label: '客服主管', description: '由客服主管审批。' },
      { id: 'turn-1:Q1:B', label: '财务主管', description: '由财务主管审批。' },
    ],
  }] }
  const inserted = [], actions = {
    captureInsertion: () => ({ start: 4, end: 4, draftRev: 8 }),
    insertText: (text, span) => { inserted.push({ text, span }); return true },
    setDraft: () => assert.fail('the entire draft must not be replaced'),
  }
  const props = { useInput: select => select({ draft: '现有输入' }), inputActions: actions }
  const view = render(h(MaterialDecisionQuestions, { turn, sources: [], disabled: false }, h(MaterialDecisionQuestionDock, props)))
  fireEvent.click(view.getByRole('radio', { name: /客服主管/ }))
  fireEvent.click(view.getByRole('button', { name: '插入所选回答' }))
  assert.equal(inserted.length, 1)
  assert.match(inserted[0].text, /我的选择：客服主管/)
  assert.equal(inserted[0].span.draftRev, 8)
  assert.match(view.container.textContent, /发送后 AI 才会收到回答/)

  view.rerender(h(MaterialDecisionQuestions, { turn, sources: [], disabled: false }, h(MaterialDecisionQuestionDock, { ...props, inputActions: {
    ...actions,
    captureInsertion: () => ({ start: 4, end: 8, draftRev: 9 }),
    insertText: () => assert.fail('selected text must remain untouched'),
  } })))
  fireEvent.click(view.getByRole('radio', { name: /财务主管/ }))
  fireEvent.click(view.getByRole('button', { name: '插入所选回答' }))
  assert.match(view.getByRole('status').textContent, /取消选择/)
})
