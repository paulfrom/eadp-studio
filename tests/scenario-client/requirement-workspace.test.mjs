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
const { render, fireEvent, cleanup, act, waitFor } = buildRequire('@testing-library/react')
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

const { RequirementGates } = loadClient('requirements/RequirementGates.tsx')
const { RequirementSourcePanel } = loadClient('requirements/RequirementSourcePanel.tsx')
const { RequirementMetadataForm } = loadClient('requirements/RequirementMetadataForm.tsx')
const { RequirementSpecPanel } = loadClient('requirements/RequirementSpecPanel.tsx')
const h = React.createElement

function metadata(overrides = {}) {
  return {
    kind: 'requirement', entityId: 'requirement-id', title: '采购审批要求', templateId: 'default',
    templateRef: { path: '.template/requirement.md', commitSha: '1234567890abcdef', sha256: 'a'.repeat(64) },
    scenarioIds: ['scene-id'], sources: [{ projectId: 'project', entityId: 'scene-id', version: 2 }],
    prerequisites: [{ requirementId: 'base-id', version: 1 }], businessEvidence: [], openQuestions: [],
    coreRulesPresent: false, acceptanceCriteriaPresent: false, referencedAssets: [], ...overrides,
  }
}
function workspace(overrides = {}) {
  return {
    readOnly: false, conflict: undefined,
    gates: [
      { id: 'business', label: '业务完整性', status: 'blocked', messages: ['缺少规则'] },
      { id: 'template', label: '模板结构', status: 'passed', messages: [] },
    ],
    structureCheck: true,
    template: { id: 'default', name: '默认需求模板', fixed: { path: '.template/requirement.md', commitSha: '1234567890abcdef', sha256: 'a'.repeat(64) }, body: '## 业务目标\n\n## 验收条件' },
    ...overrides,
  }
}
function entity(overrides = {}) {
  return { id: 'requirement-id', kind: 'requirement', code: 'RQ-0003', title: '采购审批要求', materialVersion: 0, revision: 4, authorId: 7, ...overrides }
}
function snapshot(overrides = {}) {
  return { body: '', metadata: metadata(), sha256: 'b'.repeat(64), dirty: false, saving: false, error: '', conflict: undefined, ...overrides }
}
const entities = [
  { id: 'scene-id', kind: 'scenario', code: 'SC-0001', title: '采购流程', materialVersion: 3 },
  { id: 'general-id', kind: 'scenario', code: 'SC-0000', title: '通用场景', builtinKey: 'general', materialVersion: 1 },
  { id: 'base-id', kind: 'requirement', title: '基础档案', materialVersion: 1, current: { version: 1 } },
]

test('requirement gates render one chip per check with states and confirm without any repair flow', () => {
  let confirmed = 0
  const view = render(h(RequirementGates, {
    workspace: workspace(), disabled: false, dirty: true, buffer: { edit() {} }, snapshot: snapshot(),
    onConfirm: () => { confirmed += 1 }, onStructureCheck() {},
  }))
  const chips = view.container.querySelectorAll('[data-state]')
  assert.deepEqual([...chips].map(chip => chip.getAttribute('data-state')), ['blocked', 'passed'])
  assert.match(view.container.textContent, /业务完整性 · 阻断/)
  assert.match(view.container.textContent, /模板结构 · 通过/)
  assert.match(view.container.textContent, /内容有变化，确认时将保存当前输入并重新执行检查。/)
  assert.match(view.container.textContent, /1 项门禁阻断/)
  assert.match(view.container.textContent, /缺少规则/)
  assert.equal(view.queryByRole('button', { name: /修复/ }), null)
  fireEvent.click(view.getByRole('button', { name: '确认当前需求' }))
  assert.equal(confirmed, 1)
})

test('source panel pins fixed versions, marks the builtin scenario and links back to the scenario stage', () => {
  const opened = []
  const withSources = metadata({ scenarioIds: ['scene-id', 'general-id'], sources: [{ projectId: 'project', entityId: 'scene-id', version: 2 }, { projectId: 'project', entityId: 'general-id', version: 1 }] })
  const view = render(h(RequirementSourcePanel, { entity: entity(), metadata: withSources, entities, candidates: [], busy: false, onOpenScenario: id => opened.push(id) }))
  assert.match(view.container.textContent, /SC-0001 · 采购流程 · 固定版本 v2/)
  assert.match(view.container.textContent, /通用场景 · 系统内置 · 预置版本 v1/)
  fireEvent.click(view.getByText(/SC-0001 · 采购流程/))
  assert.deepEqual(opened, ['scene-id'])
})

test('fixed source reading displays the accepted original even when the scenario has a newer current version', async () => {
  const commands = []
  const source = { entityId: 'scene-id', title: '采购流程', version: 2, confirmationId: 'confirmed-v2', fixed: { path: '场景/采购流程.md', commitSha: 'a'.repeat(40), sha256: 'b'.repeat(64) }, builtin: false, body: '## 原始流程\n审批须两级通过' }
  const view = render(h(RequirementSourcePanel, {
    entity: entity(), metadata: metadata(), entities: entities.map(item => item.id === 'scene-id' ? { ...item, materialVersion: 9 } : item), candidates: [], busy: false,
    onOpenScenario() {}, call: async command => { commands.push(command); return { ok: true, state: {}, requirementSource: source } },
  }))
  fireEvent.click(view.getByRole('button', { name: '查看固定来源 v2' }))
  await waitFor(() => assert.ok(view.getByRole('region', { name: '固定来源原文' })))
  assert.deepEqual(commands, [{ action: 'readRequirementSource', entityId: 'requirement-id', sourceEntityId: 'scene-id', expectedVersion: 2 }])
  assert.match(view.getByRole('region', { name: '固定来源原文' }).textContent, /固定版本 v2/)
  assert.match(view.getByRole('region', { name: '固定来源原文' }).textContent, /审批须两级通过/)
  fireEvent.click(view.getByRole('button', { name: '关闭固定来源' }))
  assert.equal(view.queryByRole('region', { name: '固定来源原文' }), null)
})

test('changing the requirement discards an unfinished fixed-source response', async () => {
  let release
  const call = () => new Promise(resolve => { release = resolve })
  const props = { entity: entity(), metadata: metadata(), entities, candidates: [], busy: false, onOpenScenario() {}, call }
  const view = render(h(RequirementSourcePanel, props))
  fireEvent.click(view.getByRole('button', { name: '查看固定来源 v2' }))
  view.rerender(h(RequirementSourcePanel, { ...props, entity: entity({ id: 'another-requirement' }) }))
  await act(async () => release({ ok: true, state: {}, requirementSource: { entityId: 'scene-id', title: '旧来源', version: 2, fixed: { path: '场景/旧.md', commitSha: 'a'.repeat(40) }, body: '过期请求正文' } }))
  assert.equal(view.queryByRole('region', { name: '固定来源原文' }), null)
  assert.doesNotMatch(view.container.textContent, /过期请求正文/)
})

test('source panel shows candidate excerpts, evidence ranges or the empty note', () => {
  const candidate = {
    id: 'candidate', projectId: 'project', sessionId: 'session', splitId: 'split', inputHash: 'hash',
    title: '采购审批', summary: '', goal: '', scope: '', rules: [], acceptanceCriteria: [], body: '',
    sources: [{ projectId: 'project', entityId: 'scene-id', title: '采购流程', version: 2, confirmationId: 'c', fixed: {}, excerpts: [{ startLine: 3, endLine: 5, text: '审批须两级通过' }] }],
    template: {}, quality: { coreRulesPresent: false, acceptanceCriteriaPresent: false, openQuestions: [] },
    selectedEntityId: 'requirement-id',
  }
  const excerpts = render(h(RequirementSourcePanel, { entity: entity(), metadata: metadata(), entities, candidates: [candidate], busy: false, onOpenScenario() {} }))
  assert.match(excerpts.container.textContent, /第 3-5 行/)
  assert.match(excerpts.container.textContent, /审批须两级通过/)
  excerpts.unmount()
  const ranged = render(h(RequirementSourcePanel, {
    entity: entity(), entities, candidates: [], busy: false, onOpenScenario() {},
    metadata: metadata({ businessEvidence: [{ label: '访谈', reference: '采购访谈', files: [{ path: '.eadp/evidence/a.md', sha256: 'a'.repeat(64) }], ranges: [{ path: '.eadp/evidence/a.md', startLine: 1, endLine: 8 }] }] }),
  }))
  assert.match(ranged.container.textContent, /\.eadp\/evidence\/a\.md:1-8/)
  ranged.unmount()
  const empty = render(h(RequirementSourcePanel, { entity: entity(), metadata: metadata(), entities, candidates: [], busy: false, onOpenScenario() {} }))
  assert.match(empty.container.textContent, /未记录片段定位/)
})

test('metadata form keeps invalid JSON out of the buffer and blocks validation until it parses', () => {
  const edits = []
  const snap = snapshot()
  const buffer = { edit: value => edits.push(value), getSnapshot: () => snap }
  const ref = React.createRef()
  const view = render(h(RequirementMetadataForm, { ref, buffer, snapshot: snap, entities, projectId: 'project', readOnly: false }))
  const evidence = view.getByLabelText(/正式依据/)
  fireEvent.change(evidence, { target: { value: '{无效的 JSON' } })
  assert.equal(edits.length, 0)
  assert.equal(view.getByRole('alert').textContent.length > 0, true)
  let valid
  act(() => { valid = ref.current.validate() })
  assert.equal(valid, false)
  fireEvent.change(evidence, { target: { value: '[{"label":"访谈","reference":"采购访谈","files":[{"path":".eadp/evidence/a.md","sha256":"a"}],"ranges":[{"path":".eadp/evidence/a.md","startLine":1,"endLine":2}]}]' } })
  assert.equal(edits.length, 1)
  assert.equal(edits[0].metadata.businessEvidence[0].label, '访谈')
  act(() => { valid = ref.current.validate() })
  assert.equal(valid, true)
  assert.equal(view.queryByRole('alert'), null)
})

test('metadata form edits scenario relations and prerequisites through the parent buffer', () => {
  const edits = []
  const snap = snapshot()
  const buffer = { edit: value => edits.push(value), getSnapshot: () => snap }
  const view = render(h(RequirementMetadataForm, { buffer, snapshot: snap, entities, projectId: 'project', readOnly: false }))
  const relation = view.getByRole('listbox', { name: /关联场景/ })
  assert.match(relation.innerHTML, /SC-0001 · 采购流程 · v2/)
  assert.match(relation.innerHTML, /系统内置/)
  const prerequisite = view.getByRole('checkbox', { name: /基础档案/ })
  assert.equal(prerequisite.checked, true)
  fireEvent.click(prerequisite)
  assert.deepEqual(edits.at(-1).metadata.prerequisites, [])
})

test('spec panel offers preview/source, export and hides saving for the confirmed fixed version', () => {
  const draft = { entityId: 'requirement-id', metadata: metadata(), body: '## 业务目标\n\n- 两级审批', sha256: 'b'.repeat(64), path: '需求/rq-0003.md' }
  const props = {
    entity: entity(), draft, buffer: { edit() {}, getSnapshot: () => snapshot({ body: draft.body }) },
    snapshot: snapshot({ body: draft.body }), workspace: workspace(), entities, projectId: 'project', candidates: [],
    busy: false, metadataForm: React.createRef(), onFlush: async () => true, onCollapse() {}, onResolve() {}, onOpenScenario() {},
  }
  const view = render(h(RequirementSpecPanel, props))
  assert.equal(view.getByRole('button', { name: '预览' }).getAttribute('aria-pressed'), 'true')
  assert.equal(view.getByRole('button', { name: '源码' }).getAttribute('aria-pressed'), 'false')
  assert.ok(view.getByRole('button', { name: '导出' }))
  assert.ok(view.getByRole('button', { name: '保存' }))
  assert.match(view.container.textContent, /业务目标/)
  fireEvent.click(view.getByRole('button', { name: '源码' }))
  const body = view.getByLabelText('需求 Markdown 正文')
  assert.equal(body.readOnly, false)
  view.unmount()
  const fixed = render(h(RequirementSpecPanel, {
    ...props, entity: entity({ materialVersion: 3, current: { version: 3, confirmedAt: '2026-10-22T08:30:00.000Z' } }),
    workspace: workspace({ readOnly: true }),
  }))
  assert.equal(fixed.queryByRole('button', { name: '保存' }), null)
  assert.match(fixed.container.textContent, /固定版本 v3/)
  fireEvent.click(fixed.getByRole('button', { name: '源码' }))
  assert.equal(fixed.getByLabelText('需求 Markdown 正文').readOnly, true)
})

test('requirement workspace wires the requirement commands and StudioPanel routes the stage to it', () => {
  const workspaceSource = readFileSync(path.join(client, 'requirements/RequirementWorkspace.tsx'), 'utf8')
  for (const command of ['saveRequirement', 'resolveRequirementConflict', 'resolveRequirementWriteProposal', 'undoRequirementWrite', 'confirmRequirement', 'startRequirementRevision', 'retryRequirementSave', 'newRequirementSession', 'selectRequirementSession', 'openRequirement', 'requestReview', 'setScenarioStructureCheck']) {
    assert.ok(workspaceSource.includes(`action: '${command}'`), `RequirementWorkspace missing ${command}`)
  }
  assert.ok(workspaceSource.includes('metadataForm.current.validate()') || workspaceSource.includes('metadataForm.current?.validate()'), 'flush must validate business fields first')
  const panelSource = readFileSync(path.join(client, 'studio/StudioPanel.tsx'), 'utf8')
  assert.ok(panelSource.includes("stage === 'requirements' && selected ? state.requirement?.entityId === selected.id ? <RequirementWorkspace"), 'StudioPanel must route the requirements stage to RequirementWorkspace')
  assert.ok(panelSource.includes('正在读取需求材料…'), 'StudioPanel must keep the requirement loading branch')
  assert.ok(panelSource.includes('openScenarioFromRequirement'), 'StudioPanel must provide the scenario jump callback')
  assert.ok(!panelSource.includes('requirementAction'), 'the stale requirementAction helper must be gone')
})
