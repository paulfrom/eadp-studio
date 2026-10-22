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
const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const name of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
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
    if (specifier.endsWith('.css')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) })
    if (specifier.startsWith('.')) return loadClient(path.relative(client, path.resolve(path.dirname(filename), specifier)))
    return reactRequire(specifier)
  }, module, module.exports)
  return module.exports
}

const { ScenarioGates } = loadClient('scenarios/ScenarioGates.tsx')
const { ScenarioFrontmatter } = loadClient('scenarios/ScenarioFrontmatter.tsx')
const { ScenarioWriteProposalCard } = loadClient('scenarios/ScenarioWriteProposalCard.tsx')
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
  return { kind: 'scenario', entityId: 'scene-id', title: '订单审批', templateId: 'default', templateRef: { path: '.template/default.md', commitSha: '1234567890abcdef', sha256: 'a'.repeat(64) }, coreRulesPresent: false, acceptanceCriteriaPresent: false, openQuestions: [{ blocking: true, limitation: '失败如何处理', excludedScope: '' }] }
}

test('confirmation checks are grouped and Git diagnostics stay collapsed until requested', () => {
  const edits = []
  const buffer = { edit: value => edits.push(value) }
  const snapshot = { body: '## 流程', metadata: metadata(), dirty: true }
  const view = render(h(ScenarioGates, { workspace: workspace(), disabled: false, dirty: true, buffer, snapshot, onConfirm() {}, onRepair() {}, onResume() {}, onCancel() {}, onStructureCheck() {} }))
  assert.equal(view.getByText(/确认检查/).textContent.includes('模板结构'), true)
  assert.equal(view.getByText('Git 诊断').parentElement.open, false)
  assert.match(view.container.textContent, /已确认待清理/)
  fireEvent.click(view.getByText('确认检查 · 业务完整性、待澄清项与模板结构'))
  const criteria = view.getByRole('checkbox', { name: '验收条件可以客观判断' })
  assert.equal(criteria.disabled, false)
  fireEvent.click(criteria)
  assert.equal(edits.at(-1).metadata.acceptanceCriteriaPresent, true)
  fireEvent.click(view.getByText('Git 诊断'))
  assert.match(view.container.textContent, /studio\/scenario\/1/)
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

test('write proposals show pending, retryable failure and completed states', () => {
  const onResolve = () => {}
  const proposal = { id: 'proposal', baseHash: 'a'.repeat(64), createdAt: '2026-10-22T08:30:00.000Z', conclusions: ['规则已确认'], evidenceCount: 1, status: 'pending' }
  const pending = render(h(ScenarioWriteProposalCard, { proposal, disabled: false, onResolve }))
  assert.match(pending.container.textContent, /待回答/)
  assert.ok(pending.getByRole('button', { name: '写入整篇正文' }))
  pending.rerender(h(ScenarioWriteProposalCard, { proposal: { ...proposal, error: '正文已变化' }, disabled: false, onResolve }))
  assert.match(pending.container.textContent, /失败，可重试/)
  assert.ok(pending.getByRole('button', { name: '重试写入' }))
  pending.rerender(h(ScenarioWriteProposalCard, { proposal: { ...proposal, status: 'consumed' }, disabled: false, onResolve }))
  assert.match(pending.container.textContent, /已写入/)
})
