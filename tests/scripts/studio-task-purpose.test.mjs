import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '../..')
const requireBuild = createRequire(path.join(repo, '.local/build/dsh/package.json'))
const ts = requireBuild('typescript')
const source = await readFile(path.join(repo, 'packages/studio-plugin/src/client/studio/StudioPanel.tsx'), 'utf8')
const compiled = ts.transpileModule(source.replace(/^import .+\n/gm, '').replace(/\bexport /g, ''), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText.replace(/^export \{\};?\s*$/gm, '')
const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
// The module's own dependencies, as with `css` below: the panel takes its empty
// projection from `client/state.ts`, which this harness does not transpile.
const emptyStudioState = () => ({ connected: false, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], drafts: [], tasks: [], candidates: [], pending: [], reviews: [] })
const Component = new Function('React', 'useState', 'useEffect', 'useCallback', 'useRef', 'emptyStudioState', 'css', 'MaterialEditor', 'ReviewPanel', 'ProjectDialog', 'StudioSettings', 'StudioTopbar', 'NativeConversation', 'ScenarioWorkspace', 'RequirementWorkspace', 'MaterialConversation', `${compiled}; return StudioPanel`)
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)]
const text = tree => !tree || typeof tree !== 'object' ? tree ?? '' : tree.children.map(text).join('')

function render(stage, tasks) {
  const entity = { id: 'asset', title: '固定交接材料', kind: stage === 'handoffs' ? 'handoff' : stage === 'scenarios' ? 'scenario' : 'requirement', materialVersion: 1 }
  const metadata = { entityId: entity.id, kind: entity.kind, title: entity.title, templateId: 'default', templateRef: { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }, scenarioIds: [], sources: [], prerequisites: [], businessEvidence: [], openQuestions: [], coreRulesPresent: false, acceptanceCriteriaPresent: false }
  const draft = { entityId: entity.id, sha256: 'hash', metadata, body: '当前业务正文', path: `${stage === 'handoffs' ? '交接' : stage === 'scenarios' ? '场景' : '需求'}/当前材料.md` }
  const scenario = stage === 'scenarios' ? { entityId: entity.id, sessions: tasks, draft } : undefined
  const requirementSessions = tasks.filter(task => task.entityId === entity.id && task.purpose === 'material')
  const requirement = stage === 'requirements' ? { entityId: entity.id, sessions: requirementSessions, activeSessionId: requirementSessions.at(-1)?.sessionId, draft, readOnly: false } : undefined
  const state = { scenario, requirement, connected: true, project: { id: 'project' }, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], collaboration: { entities: [entity], baselines: [] }, tasks, drafts: [draft], reviews: [{ id: 'material-review', entityId: entity.id, purpose: 'material' }], candidates: [], pending: [] }
  // The projection now arrives from the shared store, so the first hook slots are
  // the panel's own stage and selection.
  const values = [stage, entity.id], calls = [], updates = []
  let index = 0
  const Panel = Component({ createElement }, initial => { const slot = index++; return [slot < values.length ? values[slot] : typeof initial === 'function' ? initial() : initial, value => updates.push({ slot, value })] }, () => {}, value => value, initial => ({ current: initial }), emptyStudioState, new Proxy({}, { get: (_, key) => key }), 'MaterialEditor', 'ReviewPanel', 'ProjectDialog', 'StudioSettings', 'StudioTopbar', function NativeConversation() {}, 'ScenarioWorkspace', 'RequirementWorkspace', function MaterialConversation() {})
  // The panel reads one shared projection and runs commands through the session;
  // the harness supplies both faces the slot registration injects.
  const props = { useStore: selector => selector({ projection: state, loading: false, error: '' }), run: async command => { calls.push(command); return { ok: true, state } }, sync: () => {}, theme: {} }
  const tree = Panel(props)
  return { tree, calls, updates }
}

for (const [stage, purpose] of [['prototype', 'prototype'], ['handoffs', 'handoff']]) {
  test(`${stage} displays only its exact task purpose and invokes its dedicated session entry`, async () => {
    const task = { entityId: 'asset', purpose, sessionId: purpose + '-session', error: purpose + '-error' }
    const other = { entityId: 'other', purpose, sessionId: 'wrong-entity' }
    const wrong = { entityId: 'asset', purpose: 'review', sessionId: 'wrong-purpose' }
    const { tree, calls } = render(stage, [wrong, other, task])
    const conversation = nodes(tree).find(node => node.type?.name === 'NativeConversation')
    assert.equal(conversation?.props.sessionId, task.sessionId)
    assert.ok(text(tree).includes(task.error), 'task failures must be visible for recovery')
    const entry = nodes(tree).find(node => node.type === 'button' && text(node) === '恢复对话')
    assert.ok(entry)
    await entry.props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, [{ action: 'startSession', entityId: 'asset', purpose }])
    if (stage === 'handoffs') {
      const review = nodes(tree).find(node => node.type === 'ReviewPanel')
      assert.equal(review.props.purpose, 'material', 'handoff author confirmation uses material review')
      assert.equal(review.props.review.id, 'material-review')
    }
  })
}

test('requirements use the dedicated requirement workspace and preserve its session projection', () => {
  const task = { entityId: 'asset', purpose: 'material', sessionId: 'requirement-session' }
  const { tree } = render('requirements', [task])
  const workspace = nodes(tree).find(node => node.type === 'RequirementWorkspace')
  assert.equal(workspace.props.workspace.entityId, 'asset')
  assert.deepEqual(workspace.props.workspace.sessions, [task])
  assert.equal(typeof workspace.props.registerFlush, 'function')
  assert.equal(typeof workspace.props.onOpenScenario, 'function')
})

test('handoff does not display a stale material task as its conversation', () => {
  const { tree } = render('handoffs', [{ entityId: 'asset', purpose: 'material', sessionId: 'stale-material' }])
  assert.equal(nodes(tree).some(node => node.type?.name === 'NativeConversation'), false)
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '与 AI 整理'))
})

test('scenarios use the dedicated scenario workspace and preserve its scene-bound session projection', () => {
  const task = { entityId: 'asset', purpose: 'material', sessionId: 'scenario-session' }
  const { tree } = render('scenarios', [task])
  const workspace = nodes(tree).find(node => node.type === 'ScenarioWorkspace')
  assert.equal(workspace.props.workspace.entityId, 'asset')
  assert.deepEqual(workspace.props.workspace.sessions, [task])
  assert.equal(typeof workspace.props.registerFlush, 'function')
})

test('failed scenario flush blocks stage, project and return navigation without dropping the draft', async () => {
  const { tree, calls, updates } = render('scenarios', [])
  const workspace = nodes(tree).find(node => node.type === 'ScenarioWorkspace')
  workspace.props.registerFlush(async () => false)
  const topbar = nodes(tree).find(node => node.type === 'StudioTopbar')
  topbar.props.faces.selectStage('requirements')
  const back = nodes(tree).find(node => node.type === 'button' && text(node).startsWith('← 返回'))
  back.props.onClick()
  const project = nodes(tree).find(node => node.type === 'button' && node.props.title === '切换、新建或获取项目')
  project.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(updates.some(update => update.slot === 1 || update.slot === 2), false)
  assert.deepEqual(calls, [])
})

test('failed requirement flush blocks stage and return navigation without dropping the draft', async () => {
  const { tree, calls, updates } = render('requirements', [])
  const workspace = nodes(tree).find(node => node.type === 'RequirementWorkspace')
  workspace.props.registerFlush(async () => false)
  const topbar = nodes(tree).find(node => node.type === 'StudioTopbar')
  topbar.props.faces.selectStage('scenarios')
  const back = nodes(tree).find(node => node.type === 'button' && text(node).startsWith('← 返回'))
  back.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(updates.some(update => update.slot === 1 || update.slot === 2), false)
  assert.deepEqual(calls, [])
})
