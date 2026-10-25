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
    if (specifier.startsWith('.')) return loadClient(path.relative(client, path.resolve(path.dirname(filename), specifier)))
    return reactRequire(specifier)
  }, module, module.exports)
  return module.exports
}

const { ConsistencyPanel } = loadClient('components/ConsistencyPanel.tsx')
const { ScenarioChatPanel } = loadClient('scenarios/ScenarioChatPanel.tsx')
const h = React.createElement

const entities = [
  { id: 'scene-1', kind: 'scenario', code: 'SC-0001', title: '订单审批', materialVersion: 2 },
  { id: 'req-1', kind: 'requirement', code: 'REQ-0001', title: '审批规则', materialVersion: 1, confirmationStatus: 'confirmed', scenarioIds: ['scene-1'] },
  { id: 'req-2', kind: 'requirement', code: 'REQ-0002', title: '潜在需求', materialVersion: 0, confirmationStatus: 'draft', scenarioIds: ['scene-1'] },
]
const comparison = (overrides = {}) => ({
  id: 'cmp-1', entityId: 'req-1', trigger: 'manual', result: 'completed', coverage: 'complete',
  summary: '本次已读范围未发现冲突', conflictCount: 0, conflicts: [],
  creator: { id: 1, name: '作者' }, createdAt: '2026-10-22T08:30:00.000Z', ...overrides,
})

function panel({ history = [], tasks = [], calls = [], onReply } = {}) {
  const call = async command => {
    calls.push(command)
    return onReply ? onReply(command) : { ok: true, state: { consistencyLatest: [] }, comparisons: history }
  }
  return render(h(ConsistencyPanel, { entityId: 'req-1', entities, tasks, busy: false, call }))
}

test('the latest conclusion reports completed, failed and cancelled faithfully without claiming consistency', async () => {
  const done = panel({ history: [comparison()] })
  await waitFor(() => assert.ok(done.getByText('本次已读范围未发现冲突')))
  assert.ok(done.getByText('对比完成'))
  assert.ok(done.getByText('范围完整'))
  assert.doesNotMatch(done.container.textContent, /已一致|已处理|已忽略/)
  done.unmount()

  const failed = panel({ history: [comparison({ result: 'failed', coverage: 'partial', failureCode: 'model-failed', summary: '本次对比未完成，请重新发起' })] })
  await waitFor(() => assert.ok(failed.getByText('对比失败')))
  assert.ok(failed.getByText('范围不足'))
  assert.match(failed.container.textContent, /本次对比未完成，请重新发起/)
  assert.doesNotMatch(failed.container.textContent, /未发现冲突|已一致/)
  failed.unmount()

  const cancelled = panel({ history: [comparison({ result: 'cancelled', coverage: 'partial', failureCode: 'cancelled', summary: '本次对比已取消' })] })
  await waitFor(() => assert.ok(cancelled.getByText('已取消')))
  assert.match(cancelled.container.textContent, /本次对比已取消/)
  assert.doesNotMatch(cancelled.container.textContent, /未发现冲突|已一致/)
})

test('partial coverage and conflicts are marked, potential relations listed apart from formal ones, with no processing state', async () => {
  const view = panel({
    history: [comparison({
      coverage: 'partial', summary: '发现两处需要作者判断的分歧', conflictCount: 2,
      conflicts: [
        { id: 'c1', ordinal: 1, summary: '场景与需求的退回条件不同', relation: 'formal', entities: ['scene-1', 'req-1'] },
        { id: 'c2', ordinal: 2, summary: '潜在需求的重试边界不同', relation: 'potential', entities: ['req-9'] },
      ],
    })],
  })
  await waitFor(() => assert.ok(view.getByText('冲突摘要 · 2 项')))
  assert.ok(view.getByText('范围不足'))
  assert.equal(view.getByText('正式关系').className, 'sourceChip')
  assert.equal(view.getByText('潜在关联').className, 'potentialTag')
  assert.ok(view.getByText(/SC-0001 · 订单审批/))
  assert.ok(view.getByText(/REQ-0001 · 审批规则/))
  assert.ok(view.getByText(/req-9/), '解析不到的材料显示原始 id')
  assert.ok(view.getByText('#1'))
  assert.ok(view.getByText('#2'))
  assert.doesNotMatch(view.container.textContent, /已处理|已忽略|处理状态/)
})

test('compare, cancel, retry and freshness-check commands wire to the entity and comparison', async () => {
  const calls = []
  const tasks = [
    { id: 'cmp-run', projectId: 'p', entityId: 'req-1', trigger: 'manual', phase: 'running', createdAt: '', freshness: 'unknown' },
    { id: 'cmp-sync', projectId: 'p', entityId: 'req-1', trigger: 'manual', phase: 'pending-sync', createdAt: '', freshness: 'unknown', message: '对比结果尚未共享，重试将先核对原结果' },
    { id: 'cmp-stale', projectId: 'p', entityId: 'req-1', trigger: 'manual', phase: 'shared', createdAt: '', freshness: 'stale' },
    { id: 'cmp-other', projectId: 'p', entityId: 'other', trigger: 'manual', phase: 'running', createdAt: '', freshness: 'unknown' },
  ]
  const view = panel({ calls, tasks })
  await waitFor(() => assert.ok(view.getByRole('button', { name: '发起对比' })))
  assert.deepEqual(calls, [{ action: 'listConsistencyComparisons', entityId: 'req-1', limit: 20, offset: 0 }])
  assert.ok(view.getByText('对比进行中'))
  assert.ok(view.getByText('结果待同步'))
  assert.ok(view.getByText('对比结果尚未共享，重试将先核对原结果'))
  assert.ok(view.getByText('相对本机内容已过期'))
  assert.equal(view.getByRole('button', { name: '发起对比' }).disabled, true, '进行中的对比不重复发起')
  fireEvent.click(view.getByRole('button', { name: '取消本次对比' }))
  fireEvent.click(view.getByRole('button', { name: '重试共享' }))
  fireEvent.click(view.getByRole('button', { name: '核对本机内容' }))
  await waitFor(() => assert.deepEqual(calls.slice(1), [
    { action: 'cancelConsistencyComparison', comparisonId: 'cmp-run' },
    { action: 'retryConsistencySubmission', comparisonId: 'cmp-sync' },
    { action: 'checkConsistencyFreshness', comparisonId: 'cmp-stale' },
  ]))
  view.unmount()
  const idle = panel({ calls: [] })
  await waitFor(() => assert.ok(idle.getByRole('button', { name: '发起对比' })))
  fireEvent.click(idle.getByRole('button', { name: '发起对比' }))
  await waitFor(() => assert.ok(idle.container.textContent.includes('尚无对比记录')))
  assert.equal(idle.queryByText('对比进行中'), null)
})

test('history keeps every archived comparison and pages earlier records until the backend is exhausted', async () => {
  const page1 = Array.from({ length: 20 }, (_, index) => comparison({ id: `cmp-${index + 1}`, createdAt: `2026-10-${String(22 - index).padStart(2, '0')}T08:30:00.000Z`, conflictCount: index % 3 }))
  const page2 = Array.from({ length: 5 }, (_, index) => comparison({ id: `cmp-${index + 21}`, createdAt: `2026-09-0${index + 1}T08:30:00.000Z`, result: 'failed', coverage: 'partial', failureCode: 'timeout', summary: '本次对比超时' }))
  const calls = []
  const view = panel({
    calls,
    onReply: command => ({ ok: true, state: { consistencyLatest: [] }, comparisons: command.offset === 0 ? page1 : page2 }),
  })
  await waitFor(() => assert.equal(view.getByRole('region', { name: '历史对比' }).querySelectorAll('[class*="candidateRow"]').length, 20))
  assert.ok(view.getByRole('button', { name: '更早记录' }))
  assert.match(view.getByRole('region', { name: '一致性对比' }).textContent, /已读取 20 次/)
  fireEvent.click(view.getByRole('button', { name: '更早记录' }))
  await waitFor(() => assert.equal(view.getByRole('region', { name: '历史对比' }).querySelectorAll('[class*="candidateRow"]').length, 25))
  assert.deepEqual(calls, [
    { action: 'listConsistencyComparisons', entityId: 'req-1', limit: 20, offset: 0 },
    { action: 'listConsistencyComparisons', entityId: 'req-1', limit: 20, offset: 20 },
  ])
  assert.equal(view.queryByRole('button', { name: '更早记录' }), null, '不足一页即到底')
  const rows = within(view.getByRole('region', { name: '历史对比' })).getAllByText(/冲突 \d+ 项/)
  assert.equal(rows.length, 25)
  assert.match(view.getByRole('region', { name: '历史对比' }).textContent, /对比失败 · 范围不足 · 冲突 0 项/)
})

test('newly shared results refresh the conclusion without reopening the panel', async () => {
  let results = []
  const calls = []
  const call = async command => { calls.push(command); return { ok: true, state: {}, comparisons: results } }
  const props = { entityId: 'req-1', entities, tasks: [], busy: false, call }
  const view = render(h(ConsistencyPanel, props))
  await waitFor(() => assert.match(view.container.textContent, /尚无对比记录/))
  results = [comparison({ summary: '新对比发现分歧', conflictCount: 1 })]
  view.rerender(h(ConsistencyPanel, { ...props, tasks: [{ id: 'cmp-1', entityId: 'req-1', phase: 'shared' }] }))
  await waitFor(() => assert.ok(view.getByText('新对比发现分歧')))
  assert.equal(calls.length, 2)
})

test('project history exposes archived conflict digests and navigation to affected materials', async () => {
  const opened = []
  const previous = comparison({ id: 'old', createdAt: '2026-10-21T00:00:00Z', conflictCount: 1, summary: '旧分歧', conflicts: [{ id: 'c-old', ordinal: 1, summary: '旧记录中的退回条件冲突', relation: 'formal', entities: ['scene-1', 'req-1'] }] })
  const call = async command => { assert.equal(command.entityId, undefined); return { ok: true, state: {}, comparisons: [comparison(), previous] } }
  const view = render(h(ConsistencyPanel, { entities, tasks: [], busy: false, call, onOpenMaterial: entity => opened.push(entity.id) }))
  await waitFor(() => assert.equal(view.getAllByRole('button', { name: '查看本次结论' }).length, 2))
  fireEvent.click(view.getAllByRole('button', { name: '查看本次结论' })[1])
  assert.ok(view.getByText('旧记录中的退回条件冲突'))
  fireEvent.click(view.getByRole('button', { name: '查看场景 · 订单审批' }))
  assert.deepEqual(opened, ['scene-1'])
  assert.equal(view.queryByRole('button', { name: '发起对比' }), null)
})

test('a failed history read remains unknown and offers a local retry', async () => {
  let fail = true
  const view = panel({ onReply: () => fail ? { ok: false, message: '没有权限读取记录', code: 'DENIED' } : { ok: true, state: {}, comparisons: [comparison()] } })
  await waitFor(() => assert.match(view.getByRole('alert').textContent, /没有权限读取记录/))
  assert.doesNotMatch(view.container.textContent, /尚无对比记录/)
  fail = false
  fireEvent.click(view.getByRole('button', { name: '重试读取对比记录' }))
  await waitFor(() => assert.ok(view.getByText('本次已读范围未发现冲突')))
})

test('switching materials discards an older request and never merges another material history', async () => {
  let releaseOld
  const call = async command => command.entityId === 'req-1'
    ? new Promise(resolve => { releaseOld = resolve })
    : { ok: true, state: {}, comparisons: [comparison({ id: 'new-cmp', entityId: 'req-2', summary: '第二材料的结论', conflictCount: 1 })] }
  const props = { entityId: 'req-1', entities, tasks: [], busy: false, call }
  const view = render(h(ConsistencyPanel, props))
  view.rerender(h(ConsistencyPanel, { ...props, entityId: 'req-2' }))
  await waitFor(() => assert.ok(view.getByText('第二材料的结论')))
  await React.act(async () => { releaseOld({ ok: true, state: {}, comparisons: [comparison({ summary: '旧请求不能显示', conflictCount: 1 })] }) })
  assert.ok(view.getByText('第二材料的结论'))
  assert.equal(view.queryByText('旧请求不能显示'), null)
})

test('refreshing a newly shared result retains already paged history and the selected old conclusion', async () => {
  const page = Array.from({ length: 20 }, (_, index) => comparison({ id: `c-${index}`, summary: `结论${index}`, conflictCount: 1, createdAt: `2026-10-22T08:${String(59 - index).padStart(2, '0')}:00Z` }))
  const older = comparison({ id: 'older', createdAt: '2026-09-01T00:00:00Z', summary: '早期冲突摘要', conflictCount: 1 })
  let fresh = false
  const call = async command => ({ ok: true, state: {}, comparisons: command.offset > 0 ? [older] : fresh ? [comparison({ id: 'latest', createdAt: '2026-10-23T00:00:00Z' }), ...page.slice(0, 19)] : page })
  const props = { entityId: 'req-1', entities, tasks: [], busy: false, call }
  const view = render(h(ConsistencyPanel, props))
  await waitFor(() => assert.ok(view.getByRole('button', { name: '更早记录' })))
  fireEvent.click(view.getByRole('button', { name: '更早记录' }))
  await waitFor(() => assert.equal(view.getAllByRole('button', { name: '查看本次结论' }).length, 21))
  fireEvent.click(view.getAllByRole('button', { name: '查看本次结论' }).at(-1))
  assert.ok(view.getByText('早期冲突摘要'))
  fresh = true
  view.rerender(h(ConsistencyPanel, { ...props, tasks: [{ id: 'latest', entityId: 'req-1', phase: 'shared' }] }))
  await waitFor(() => assert.equal(view.getAllByRole('button', { name: '查看本次结论' }).length, 22))
  assert.ok(view.getByText('早期冲突摘要'))
})

function chatPanel(props = {}) {
  return render(h(ScenarioChatPanel, {
    entity: { id: 'scene-1', kind: 'scenario', code: 'SC-0001', title: '订单审批', authorId: 1 },
    workspace: { readOnly: false }, busy: false, locked: false,
    material: { hash: 'h', dirty: false }, sessions: [], activeSessionId: undefined,
    actions: { refresh() {}, newSession() {}, selectSession() {}, openTemplates() {}, resolveWriteProposal() {}, undoWrite() {} },
    revision: { shown: false, inspect() {}, start() {}, dismiss() {} },
    split: { offered: false, deferred: false, split() {}, defer() {} },
    candidates: { items: [], create() {} },
    relatedRequirements: [], onOpenRequirement() {}, expandSpec: undefined, children: null,
    ...props,
  }))
}

test('the scenario explains a missing write button and shows actionable buttons after a corrected proposal', () => {
  const decisions = []
  const actions = { refresh() {}, newSession() {}, selectSession() {}, openTemplates() {}, resolveWriteProposal: decision => decisions.push(decision), undoWrite() {} }
  const view = chatPanel({ workspace: { readOnly: false, writeProposalError: '写入提议 ID 无效' }, actions })
  assert.match(view.getByRole('alert', { name: '写入提议未生成' }).textContent, /写入提议 ID 无效/)
  assert.match(view.getByRole('alert').textContent, /请让 AI 用 eadp-write-proposal 代码块基于当前材料重新提出写入提议/)
  assert.equal(view.queryByRole('button', { name: '写入整篇正文' }), null)
  view.unmount()

  const corrected = chatPanel({ workspace: { readOnly: false, writeProposal: { id: 'proposal', status: 'pending', conclusions: ['仅允许审批人退回'], evidenceCount: 1 } }, actions })
  assert.equal(corrected.queryByRole('alert'), null)
  fireEvent.click(corrected.getByRole('button', { name: '写入整篇正文' }))
  fireEvent.click(corrected.getByRole('button', { name: '不写入' }))
  assert.deepEqual(decisions, ['write', 'reject'])
})

test('the scenario dock lists related requirements with confirmation status and opens them through the callback', () => {
  const opened = []
  const view = chatPanel({ relatedRequirements: [entities[1], entities[2]], onOpenRequirement: id => opened.push(id) })
  const dock = view.getByRole('region', { name: '关联需求' })
  assert.match(dock.textContent, /关联需求.*2 项/)
  assert.ok(within(dock).getByText('REQ-0001 · 审批规则'))
  assert.ok(within(dock).getByText('REQ-0002 · 潜在需求'))
  assert.ok(within(dock).getByText('已确认'))
  assert.ok(within(dock).getByText('草稿'))
  fireEvent.click(within(dock).getByText('REQ-0001 · 审批规则'))
  assert.deepEqual(opened, ['req-1'])
  view.unmount()
  const empty = chatPanel()
  assert.match(empty.getByRole('region', { name: '关联需求' }).textContent, /尚无正式关联的需求/)
})

test('both workspaces mount the consistency panel and StudioPanel routes the requirement jump', () => {
  const requirementSource = readFileSync(path.join(client, 'requirements/RequirementWorkspace.tsx'), 'utf8')
  assert.match(requirementSource, /<ConsistencyPanel entityId=\{entity\.id\} entities=\{entities\} tasks=\{state\.consistencyTasks \?\? \[\]\} busy=\{busy\} call=\{call\} onOpenMaterial=\{onOpenMaterial\} \/>/)
  assert.ok(requirementSource.indexOf('<ConsistencyPanel') < requirementSource.indexOf('<RequirementGates'), '对比面板在门禁区之前，门禁不含对比内容')
  const scenarioSource = readFileSync(path.join(client, 'scenarios/ScenarioWorkspace.tsx'), 'utf8')
  assert.match(scenarioSource, /<ConsistencyPanel entityId=\{entity\.id\} entities=\{entities\} tasks=\{state\.consistencyTasks \?\? \[\]\} busy=\{busy\} call=\{call\} onOpenMaterial=\{onOpenMaterial\} \/>/)
  assert.ok(scenarioSource.indexOf('<ConsistencyPanel') < scenarioSource.indexOf('<ScenarioGates'), '对比面板在门禁区之前')
  assert.match(scenarioSource, /entities\.filter\(value => value\.kind === 'requirement' && value\.scenarioIds\.includes\(entity\.id\)\)/)
  assert.match(scenarioSource, /relatedRequirements=\{relatedRequirements\} onOpenRequirement=\{onOpenRequirement\}/)
  const panelSource = readFileSync(path.join(client, 'studio/StudioPanel.tsx'), 'utf8')
  assert.match(panelSource, /openRequirementFromScenario/)
  assert.match(panelSource, /setStage\('requirements'\); setSelectedId\(entityId\); setActiveTab\('material'\)\s+await call\(\{ action: 'openRequirement', entityId \}\)/)
  assert.match(panelSource, /<ScenarioWorkspace[^/]*onOpenRequirement=\{id => void openRequirementFromScenario\(id\)\}/)
})
