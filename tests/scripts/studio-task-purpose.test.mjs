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
const Component = new Function('React', 'useState', 'useEffect', 'useCallback', 'css', 'MaterialEditor', 'ReviewPanel', 'ProjectDialog', 'StudioSettings', 'StudioTopbar', `${compiled}; return StudioPanel`)
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)]
const text = tree => !tree || typeof tree !== 'object' ? tree ?? '' : tree.children.map(text).join('')

function render(stage, tasks) {
  const entity = { id: 'asset', title: '固定交接材料', kind: stage === 'handoffs' ? 'handoff' : stage === 'scenarios' ? 'scenario' : 'requirement', materialVersion: 1, frozenBy: [] }
  const state = { connected: true, project: { id: 'project', categories: [] }, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], collaboration: { entities: [entity], baselines: [] }, tasks, drafts: [{ entityId: entity.id, sha256: 'hash' }], reviews: [{ id: 'material-review', entityId: entity.id, purpose: 'material' }], candidates: [], pending: [] }
  const values = [state, stage, entity.id], calls = []
  let index = 0
  const Panel = Component({ createElement }, initial => [index < values.length ? values[index++] : (index++, typeof initial === 'function' ? initial() : initial), () => {}], () => {}, value => value, new Proxy({}, { get: (_, key) => key }), 'MaterialEditor', 'ReviewPanel', 'ProjectDialog', 'StudioSettings', 'StudioTopbar')
  const tree = Panel({ call: async command => { calls.push(command); return { ok: true, state } }, theme: {} })
  return { tree, calls }
}

for (const [stage, purpose] of [['scenarios', 'material'], ['requirements', 'material'], ['prototype', 'prototype'], ['handoffs', 'handoff']]) {
  test(`${stage} displays and resumes only its exact task purpose`, async () => {
    const task = { entityId: 'asset', purpose, sessionId: purpose + '-session', error: purpose + '-error' }
    const other = { entityId: 'other', purpose, sessionId: 'wrong-entity' }
    const wrong = { entityId: 'asset', purpose: 'review', sessionId: 'wrong-purpose' }
    const { tree, calls } = render(stage, [wrong, other, task])
    const conversation = nodes(tree).find(node => node.type?.name === 'NativeConversation')
    assert.equal(conversation?.props.sessionId, task.sessionId)
    assert.ok(text(tree).includes(task.error), 'task failures must be visible for recovery')
    const resume = nodes(tree).find(node => node.type === 'button' && text(node) === '恢复对话')
    assert.ok(resume)
    await resume.props.onClick()
    assert.deepEqual(calls[0], { action: 'startSession', entityId: 'asset', purpose })
    if (stage === 'handoffs') {
      const review = nodes(tree).find(node => node.type === 'ReviewPanel')
      assert.equal(review.props.purpose, 'material', 'handoff author confirmation uses material review')
      assert.equal(review.props.review.id, 'material-review')
    }
  })
}

test('handoff does not display a stale material task as its conversation', () => {
  const { tree } = render('handoffs', [{ entityId: 'asset', purpose: 'material', sessionId: 'stale-material' }])
  assert.equal(nodes(tree).some(node => node.type?.name === 'NativeConversation'), false)
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '与 AI 整理'))
})
