import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '../..')
const ts = createRequire(path.join(repo, '.local/build/dsh/package.json'))('typescript')
const source = await readFile(path.join(repo, 'packages/studio-plugin/src/client/components/MaterialEditor.tsx'), 'utf8')
const compiled = ts.transpileModule(source.replace(/^import .+\n/gm, '').replace(/\bexport /g, ''), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText
const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const Component = new Function('React', 'useState', 'useEffect', 'useRef', 'useCallback', 'useDraftBuffer', 'css', `${compiled}; return MaterialEditor`)(
  { createElement }, initial => [initial, () => {}], () => {}, value => ({ current: value }), value => value,
  draft => ({ buffer: {}, snapshot: { ...draft, dirty: false, saving: false, error: '' } }),
  new Proxy({}, { get: (_, key) => key }),
)
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
