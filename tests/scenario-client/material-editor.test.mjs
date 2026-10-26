import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '../..')
const ts = createRequire(path.join(repo, '.local/build/dsh/package.json'))('typescript')
const source = await readFile(path.join(repo, 'packages/studio-plugin/src/client/components/MaterialEditor.tsx'), 'utf8')
const compiled = ts.transpileModule(source.replace(/^import .+\r?\n/gm, '').replace(/\bexport /g, ''), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/^export \{\};?\s*$/gm, '')
const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const sourceHelpers = ts.transpileModule((await readFile(path.join(repo, 'packages/studio-plugin/src/client/requirements/scenario-sources.ts'), 'utf8')).replace(/^import .+\r?\n/gm, '').replace(/\bexport /g, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace(/^export \{\};?\s*$/gm, '')
const { ordinaryScenarioSources, removeScenarioSource, updateScenarioSources } = new Function(`${sourceHelpers}; return { ordinaryScenarioSources, removeScenarioSource, updateScenarioSources }`)()
const Component = new Function('ordinaryScenarioSources', 'removeScenarioSource', 'updateScenarioSources', 'React', 'useState', 'useEffect', 'useRef', 'useCallback', 'useDraftBuffer', 'css', `${compiled}; return MaterialEditor`)(
  ordinaryScenarioSources, removeScenarioSource, updateScenarioSources, { createElement }, initial => [initial, () => {}], () => {}, value => ({ current: value }), value => value,
  draft => ({ buffer: { edit: value => edits.push(value) }, snapshot: { ...draft, dirty: false, saving: false, error: '' } }),
  new Proxy({}, { get: (_, key) => key }),
)
const edits = []
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)]

test('requirement relation editing stays available and the body remains editable', () => {
  const metadata = { kind: 'requirement', entityId: 'requirement', title: '业务要求', templateId: 'default', templateRef: { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }, scenarioIds: ['scene'], sources: [{ projectId: 'project', entityId: 'scene', version: 2 }], prerequisites: [{ requirementId: 'prerequisite', version: 1 }], businessEvidence: [], openQuestions: [], coreRulesPresent: true, acceptanceCriteriaPresent: true }
  const tree = Component({ draft: { entityId: metadata.entityId, metadata, body: '可以继续完善的业务正文', path: '需求/requirement.md' }, entities: [
    { id: 'requirement', kind: 'requirement' },
    { id: 'scene', kind: 'scenario', materialVersion: 1, title: '固定场景' },
    { id: 'prerequisite', kind: 'requirement', materialVersion: 1, title: '前置需求', current: {} },
  ], projectId: 'project', busy: false, onSave: async () => {}, onBindTemplate: async () => {} })
  const relationSelect = nodes(tree).find(node => node.type === 'select' && node.props.multiple)
  assert.equal(relationSelect.props.disabled, undefined)
  assert.deepEqual(relationSelect.props.value, ['scene'])
  const prerequisite = nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === true)
  assert.equal(prerequisite.props.disabled, undefined)
  const body = nodes(tree).find(node => node.type === 'textarea' && node.props['aria-label'] === '材料 Markdown 正文')
  assert.equal(body.props.disabled, undefined)
  assert.equal(body.props.readOnly, undefined)
  assert.equal(typeof body.props.onChange, 'function')
})


test('existing builtin attribution is static and ordinary relation edits preserve it until explicit removal', () => {
  edits.length = 0
  const metadata = { kind: 'requirement', entityId: 'requirement', title: '业务要求', templateId: 'default', templateRef: { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }, scenarioIds: ['general', 'scene'], sources: [{ projectId: 'project', entityId: 'general', version: 1 }, { projectId: 'project', entityId: 'scene', version: 2 }], prerequisites: [], businessEvidence: [], openQuestions: [], coreRulesPresent: true, acceptanceCriteriaPresent: true }
  const tree = Component({ draft: { entityId: metadata.entityId, metadata, body: '正文', path: '需求/requirement.md' }, entities: [
    { id: 'general', kind: 'scenario', builtinKey: 'general', materialVersion: 1, title: '通用场景' },
    { id: 'scene', kind: 'scenario', materialVersion: 9, title: '普通场景' },
    { id: 'other', kind: 'scenario', materialVersion: 3, title: '另一场景' },
  ], projectId: 'project', busy: false, onSave: async () => {} })
  const relation = nodes(tree).find(node => node.type === 'select' && node.props.multiple)
  assert.deepEqual(nodes(relation).filter(node => node.type === 'option').map(node => node.props.value), ['scene', 'other'])
  assert.deepEqual(relation.props.value, ['scene'])
  relation.props.onChange({ target: { selectedOptions: [{ value: 'other' }] } })
  assert.deepEqual(edits.at(-1).metadata.scenarioIds, ['general', 'other'])
  assert.deepEqual(edits.at(-1).metadata.sources, [{ projectId: 'project', entityId: 'general', version: 1 }, { projectId: 'project', entityId: 'other', version: 3 }])
  nodes(tree).find(node => node.type === 'button' && node.children.includes('移除通用场景关联')).props.onClick()
  assert.deepEqual(edits.at(-1).metadata.scenarioIds, ['scene'])
  assert.deepEqual(edits.at(-1).metadata.sources, [{ projectId: 'project', entityId: 'scene', version: 2 }])
})
