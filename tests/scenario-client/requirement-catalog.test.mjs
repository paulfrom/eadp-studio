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

const { MaterialCatalog } = loadClient('components/MaterialCatalog.tsx')
const h = React.createElement

const templateRef = { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }
const scenario = (overrides = {}) => ({ id: 'scene-1', kind: 'scenario', code: 'SC-0001', title: '订单审批', revision: 1, materialVersion: 2, confirmationStatus: 'confirmed', taskStatus: 'idle', scenarioIds: [], prerequisites: [], authorId: 1, ...overrides })
const requirement = (overrides = {}) => ({ id: 'req-1', kind: 'requirement', code: 'REQ-0001', title: '审批规则', revision: 1, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'idle', scenarioIds: [], prerequisites: [], authorId: 1, ...overrides })
const metadata = (overrides = {}) => ({ kind: 'requirement', entityId: 'req-1', title: '审批规则', templateId: 'default', templateRef, scenarioIds: [], sources: [], prerequisites: [], businessEvidence: [], coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [], ...overrides })

function catalog(props = {}) {
  return h(MaterialCatalog, {
    entities: [], drafts: [], kind: 'requirement', busy: false,
    onSelect: () => {}, call: async () => undefined,
    consistencyLatest: [], tasks: [], candidates: [], ...props,
  })
}

const fixtures = () => {
  const entities = [
    scenario(),
    scenario({ id: 'scene-general', builtinKey: 'general', code: 'SC-0000', title: '通用场景', materialVersion: 1 }),
    requirement({ scenarioIds: ['scene-1', 'scene-general'], scenarioSources: [{ projectId: 'p', entityId: 'scene-1', version: 2 }] }),
    requirement({ id: 'req-2', code: 'REQ-0002', title: '修订中需求', materialVersion: 1, confirmationStatus: 'draft' }),
  ]
  const drafts = [{ entityId: 'req-1', body: '## 业务规则\n- 规则一\n- 规则二', metadata: metadata({ openQuestions: [{ blocking: true, limitation: '失败如何处理', excludedScope: '' }, { blocking: false, limitation: '覆盖范围', excludedScope: '' }] }), sha256: 'h', path: '需求/req-1.md' }]
  return { entities, drafts }
}

test('requirement cards resolve source chips with builtin marker and only pinned versions', () => {
  const { entities, drafts } = fixtures()
  const view = render(catalog({ entities, drafts }))
  assert.ok(view.getByText('SC-0001 · 订单审批 · v2'))
  const builtin = view.getByText(/通用场景 · 系统内置/)
  assert.doesNotMatch(builtin.textContent, /系统内置 · v/)
})

test('metric badges show draft statistics, unknown states and failure reminders without claiming consistency', () => {
  const { entities, drafts } = fixtures()
  const history = [{ entityId: 'req-1', result: 'completed', conflictCount: 3, coverage: 'partial', createdAt: '2026-10-22T00:00:00Z' }]
  const view = render(catalog({ entities, drafts, consistencyLatest: history }))
  assert.ok(view.getByText('规则 2 条 · 待澄清 2 项 · 阻断 1 · 本地草稿'))
  assert.ok(view.getByText('冲突 3 · 范围不足'))
  assert.ok(view.getByText('最近一次检查不通过'))
  assert.ok(view.getByText('范围不足'))
  assert.ok(view.getByText('未统计'))
  assert.ok(view.getByText('对比未知'))
  assert.doesNotMatch(view.container.textContent, /已一致/)
})

test('confirmation status is a segmented tab group and revision filtering covers requirements', () => {
  const { entities, drafts } = fixtures()
  const confirmed = requirement({ id: 'req-3', code: 'REQ-0003', title: '已确认需求', materialVersion: 1, confirmationStatus: 'confirmed' })
  const view = render(catalog({ entities: [...entities, confirmed], drafts }))
  const group = view.getByRole('group', { name: '材料确认状态' })
  assert.deepEqual(within(group).getAllByRole('button').map(button => [button.textContent, button.getAttribute('aria-pressed')]), [['全部', 'true'], ['已确认', 'false'], ['草稿', 'false']])
  fireEvent.click(within(group).getByRole('button', { name: '已确认' }))
  assert.ok(view.getByText('已确认需求'))
  assert.equal(view.queryByText('审批规则'), null)
  fireEvent.click(within(group).getByRole('button', { name: '全部' }))
  assert.ok(view.getAllByText('正在修订').length >= 1)
  fireEvent.change(view.getByRole('combobox', { name: '修订状态' }), { target: { value: 'revising' } })
  assert.ok(view.getByText('修订中需求'))
  assert.equal(view.queryByText('审批规则'), null)
  assert.equal(view.queryByText('已确认需求'), null)
})

test('the source filter narrows requirements to the chosen confirmed scenario', () => {
  const { entities, drafts } = fixtures()
  const view = render(catalog({ entities, drafts }))
  const filter = view.getByRole('combobox', { name: '来源场景' })
  assert.ok(within(filter).getByRole('option', { name: '全部来源场景' }))
  assert.ok(within(filter).getByRole('option', { name: 'SC-0001 · 订单审批' }))
  fireEvent.change(filter, { target: { value: 'scene-1' } })
  assert.ok(view.getByText('审批规则'))
  assert.equal(view.queryByText('修订中需求'), null)
})

test('a source remains filterable while its newer draft is being revised', () => {
  const { entities, drafts } = fixtures()
  const view = render(catalog({ entities: entities.map(entity => entity.id === 'scene-1' ? { ...entity, confirmationStatus: 'draft' } : entity), drafts }))
  const filter = view.getByRole('combobox', { name: '来源场景' })
  fireEvent.change(filter, { target: { value: 'scene-1' } })
  assert.ok(view.getByText('审批规则'))
  assert.equal(view.queryByText('修订中需求'), null)
})

test('joint split excludes the builtin general scenario and submits the checked scenarios', async () => {
  const { entities, drafts } = fixtures()
  const commands = []
  const view = render(catalog({ entities, drafts, call: async command => { commands.push(command); return { ok: false, code: 'X', message: '停止' } } }))
  fireEvent.click(view.getByRole('button', { name: '联合拆分需求' }))
  const form = view.getByRole('form', { name: '联合拆分需求' })
  assert.match(form.textContent, /选择已确认的普通场景/)
  assert.ok(within(form).getByRole('checkbox', { name: /SC-0001 · 订单审批 · v2/ }))
  assert.equal(within(form).queryByRole('checkbox', { name: /通用场景/ }), null)
  const submit = within(form).getByRole('button', { name: '生成需求候选' })
  assert.equal(submit.disabled, true)
  fireEvent.click(within(form).getByRole('checkbox', { name: /SC-0001 · 订单审批 · v2/ }))
  assert.equal(submit.disabled, false)
  fireEvent.submit(form)
  await waitFor(() => assert.deepEqual(commands, [{ action: 'splitRequirements', scenarioIds: ['scene-1'] }]))
  await waitFor(() => assert.match(within(form).getByRole('alert').textContent, /停止/))
  assert.equal(within(form).getByRole('checkbox', { name: /SC-0001/ }).checked, true, '失败时保留所选来源')
})

test('confirmed metrics identify the accepted bytes and unrecognized rules stay unknown', () => {
  const { entities, drafts } = fixtures()
  const confirmed = requirement({ confirmationStatus: 'confirmed', materialVersion: 2, current: { fixed: { sha256: drafts[0].sha256 } } })
  const view = render(catalog({ entities: [confirmed], drafts }))
  assert.ok(view.getByText(/已确认版 v2/))
  view.rerender(catalog({ entities, drafts: [{ ...drafts[0], body: '规则以自然段描述，尚无可计数列表。' }] }))
  assert.ok(view.getByText(/规则未统计 · 待澄清 2 项/))
})

test('the catalog opens project comparison records without selecting a material', async () => {
  const commands = []
  const view = render(catalog({ call: async command => { commands.push(command); return { ok: true, state: {}, comparisons: [] } } }))
  fireEvent.click(view.getByRole('button', { name: '项目对比记录' }))
  await waitFor(() => assert.deepEqual(commands, [{ action: 'listConsistencyComparisons', limit: 20, offset: 0 }]))
  assert.ok(view.getByRole('region', { name: '项目对比记录' }))
})

test('split tasks report their binding status and failure error without a retry affordance', () => {
  const { entities, drafts } = fixtures()
  const tasks = [{ projectId: 'p', entityId: '', sessionId: 'session', purpose: 'split', inputHash: 'hash', worktree: '/tmp/split',
    error: '拆分服务不可用',
    split: { id: 'split-abcdef01', sources: [{ projectId: 'p', entityId: 'scene-1', title: '订单审批', version: 2, confirmationId: 'c', fixed: templateRef }], template: { id: 'default', fixed: templateRef, body: '' }, existingRequirements: [], status: 'failed' } }]
  const view = render(catalog({ entities, drafts, tasks }))
  const section = view.getByRole('region', { name: '拆分任务' })
  assert.match(section.textContent, /拆分 split-ab/)
  assert.match(section.textContent, /拆分失败 · 来源 订单审批/)
  assert.match(section.textContent, /拆分服务不可用/)
  assert.equal(within(section).queryByRole('button', { name: /重试/ }), null)
})

test('candidate cards list pinned source excerpts and adopting wires the expected input hash', async () => {
  const { entities, drafts } = fixtures()
  const source = { projectId: 'p', entityId: 'scene-1', title: '订单审批', version: 2, confirmationId: 'c', fixed: templateRef, excerpts: [{ startLine: 1, endLine: 3, text: '规则一' }, { startLine: 5, endLine: 6, text: '规则二' }] }
  const candidate = { id: 'candidate-1', projectId: 'p', sessionId: 'session', splitId: 'split-1', inputHash: 'hash-candidate', title: '审批通过能力', summary: '审批通过后的处理能力', goal: '自动通过', scope: '订单域', rules: [], acceptanceCriteria: [], body: '', sources: [source], template: { id: 'default', fixed: templateRef, body: '' }, quality: { coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [] } }
  const adopted = { ...candidate, id: 'candidate-2', title: '已采用能力', selectedEntityId: 'req-9' }
  const commands = [], selected = []
  const call = async command => { commands.push(command); return { ok: true, state: { candidates: [{ ...candidate, selectedEntityId: 'req-new' }] } } }
  const view = render(catalog({ entities, drafts, call, onSelect: id => selected.push(id), candidates: [candidate, adopted] }))
  const section = view.getByRole('region', { name: '需求拆分候选' })
  assert.ok(within(section).getAllByText('SC-0001 · 订单审批 · v2 · 2 段原文').length >= 1)
  assert.match(section.textContent, /目标 自动通过 · 范围 订单域/)
  const done = within(section).getByRole('button', { name: '已创建草稿' })
  assert.equal(done.disabled, true)
  fireEvent.click(within(section).getByRole('button', { name: '选用并创建需求草稿' }))
  await waitFor(() => assert.deepEqual(commands, [{ action: 'selectCandidate', candidateId: 'candidate-1', expectedInputHash: 'hash-candidate' }]))
  await waitFor(() => assert.deepEqual(selected, ['req-new']))
})

test('multiple adoption reports each result, preserves failed selections and never resubmits a successful candidate', async () => {
  const { entities } = fixtures()
  const candidates = ['第一能力', '第二能力'].map((title, index) => ({ id: `candidate-${index}`, projectId: 'p', sessionId: 's', splitId: 'split', inputHash: `hash-${index}`, title, summary: title, goal: '业务目标', scope: '业务范围', rules: ['明确业务规则'], acceptanceCriteria: ['结果可以判断'], body: '# 完整正文', sources: [], template: { id: 't', fixed: templateRef, body: '' }, quality: { coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [] } }))
  const calls = [], opened = []
  let failSecond = true
  const call = async command => {
    calls.push(command)
    if (command.candidateId === 'candidate-1' && failSecond) return { ok: false, code: 'BODY_WRITE_FAILED', message: '第二条草稿写入失败，已保留原身份' }
    return { ok: true, state: { candidates: candidates.map(candidate => candidate.id === command.candidateId ? { ...candidate, selectedEntityId: `req-${candidate.id}` } : candidate) } }
  }
  const view = render(catalog({ entities, candidates, call, onSelect: id => opened.push(id) }))
  fireEvent.click(view.getByRole('button', { name: '全选未采用候选' }))
  fireEvent.click(view.getByRole('button', { name: '采用所选候选（2）' }))
  await waitFor(() => assert.ok(view.getByRole('alert')))
  assert.deepEqual(calls, [
    { action: 'selectCandidate', candidateId: 'candidate-0', expectedInputHash: 'hash-0' },
    { action: 'selectCandidate', candidateId: 'candidate-1', expectedInputHash: 'hash-1' },
  ])
  assert.deepEqual(opened, [], '多选采用留在目录查看每条结果')
  assert.equal(view.getByRole('checkbox', { name: '选择候选 · 第一能力' }).disabled, true)
  assert.equal(view.getByRole('checkbox', { name: '选择候选 · 第二能力' }).checked, true)
  assert.match(view.getByRole('alert').textContent, /第二条草稿写入失败/)
  failSecond = false
  fireEvent.click(view.getByRole('button', { name: '采用所选候选（1）' }))
  await waitFor(() => assert.equal(view.getAllByText('已创建需求草稿').length, 2))
  assert.equal(calls.filter(command => command.candidateId === 'candidate-0').length, 1)
  assert.equal(calls.filter(command => command.candidateId === 'candidate-1').length, 2)
  assert.equal(view.getByRole('button', { name: '采用所选候选（0）' }).disabled, true)
  assert.equal(view.queryByRole('alert'), null)
})

test('candidate content can be reviewed fully before adoption without creating a material', () => {
  const calls = []
  const candidate = { id: 'candidate', projectId: 'p', sessionId: 's', splitId: 'split', inputHash: 'h', title: '审批能力', summary: '审批摘要', goal: '及时审批', scope: '采购范围', rules: ['金额超过阈值时增加复核'], acceptanceCriteria: ['复核通过后才可支付'], body: '## 完整需求\n保留完整业务叙述', sources: [{ projectId: 'p', entityId: 'scene-1', title: '订单审批', version: 2, confirmationId: 'c', fixed: templateRef, excerpts: [{ startLine: 3, endLine: 6, text: '原场景要求两级复核' }] }], template: { id: 't', fixed: templateRef, body: '' }, quality: { coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [{ blocking: true, limitation: '阈值尚待业务确定', excludedScope: '境外订单' }] } }
  const view = render(catalog({ candidates: [candidate], call: async command => { calls.push(command) } }))
  fireEvent.click(view.getByText('查看完整候选'))
  assert.equal(view.getByText('查看完整候选').closest('details').open, true)
  for (const text of ['金额超过阈值时增加复核', '复核通过后才可支付', '原场景要求两级复核', '订单审批 · 固定版本 v2', '第 3-6 行']) assert.ok(view.getByText(text))
  assert.match(view.container.textContent, /阈值尚待业务确定 · 不适用范围：境外订单/)
  assert.match(view.container.textContent, /保留完整业务叙述/)
  assert.deepEqual(calls, [])
})

test('StudioPanel passes the comparison history, tasks and project candidates to the requirement catalog and reads the history once per visit', () => {
  const source = readFileSync(path.join(client, 'studio/StudioPanel.tsx'), 'utf8')
  assert.match(source, /consistencyLatest=\{comparisonError \? \[\] : state\.consistencyLatest \?\? \[\]\}/)
  assert.match(source, /tasks=\{state\.tasks\}/)
  assert.match(source, /candidates=\{stage === 'requirements' \? state\.candidates\.filter\(candidate => candidate\.projectId === state\.project!\.id\) : \[\]\}/)
  assert.match(source, /action: 'listConsistencySummaries'/)
  assert.match(source, /setInterval\(\(\) => void refreshComparisons\(\), 10_000\)/)
  assert.match(source, /sharedComparisons, refreshComparisons\]/)
})

test('the catalog keeps joint-split and candidate sections inside the requirement kind only', () => {
  const source = readFileSync(path.join(client, 'components/MaterialCatalog.tsx'), 'utf8')
  assert.match(source, /entity\.kind === 'scenario' && entity\.materialVersion > 0 && !entity\.builtinKey/)
  assert.match(source, /\{ action: 'splitRequirements', scenarioIds: splitSelection \}/)
  assert.match(source, /\{ action: 'selectCandidate', candidateId: candidate\.id, expectedInputHash: candidate\.inputHash \}/)
  assert.match(source, /expectedInputHash: candidate\.inputHash/)
  const catalogSource = readFileSync(path.join(client, 'scenarios/catalog.ts'), 'utf8')
  assert.match(catalogSource, /options\.source === 'all' \|\| entity\.scenarioIds\.includes\(options\.source\)/)
})


test('builtin scenarios never enter scene cards, counts, search results or pagination', () => {
  const { entities } = fixtures()
  const ordinary = Array.from({ length: 12 }, (_, index) => scenario({ id: `scene-${index + 10}`, code: `SC-${index + 10}`, title: `普通场景${index}` }))
  const view = render(catalog({ kind: 'scenario', entities: [...entities.filter(entity => entity.builtinKey), ...ordinary] }))
  assert.ok(view.getByText('场景目录 · 共 12 项 · 已确认 12 · 草稿 0'))
  assert.ok(view.getByText('共 12 项 · 第 1 / 1 页'))
  assert.equal(view.queryByText('通用场景'), null)
  assert.equal(view.getByRole('button', { name: '下一页' }).disabled, true)
  fireEvent.change(view.getByRole('textbox', { name: '搜索资产' }), { target: { value: '通用场景' } })
  assert.ok(view.getByText('共 0 项 · 第 1 / 1 页'))
  assert.equal(view.queryByText('通用场景'), null)
})

test('only the new requirement source picker offers builtin attribution and submits its stable ID', async () => {
  const { entities } = fixtures(), commands = []
  const view = render(catalog({ entities, call: async command => { commands.push(command); return { ok: false, code: 'STOP', message: '保留输入' } } }))
  assert.equal(within(view.getByRole('combobox', { name: '来源场景' })).queryByRole('option', { name: /通用场景/ }), null)
  fireEvent.click(view.getByRole('button', { name: '＋ 新建需求' }))
  const sources = view.getByRole('listbox', { name: '固定场景来源' })
  const builtin = within(sources).getByRole('option', { name: 'SC-0000 · 通用场景 · 系统内置' })
  builtin.selected = true
  fireEvent.change(sources)
  fireEvent.change(view.getByRole('textbox', { name: '需求标题' }), { target: { value: '通用业务需求' } })
  fireEvent.submit(sources.closest('form'))
  await waitFor(() => assert.equal(commands.length, 1))
  assert.equal(commands[0].action, 'createMaterial')
  assert.deepEqual(commands[0].scenarioIds, ['scene-general'])
})
