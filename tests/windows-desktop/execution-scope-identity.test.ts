import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { inheritStudioExecutionScope, registerStudioExecutionScope, studioToolGuard } from '../../packages/studio-plugin/src/host/adapters/platform/execution-guard.ts'

// Batch materials and their readonly split task intentionally share a worktree.
// Their real Agent object must select the policy; the directory cannot do so.
const cwd = path.resolve(import.meta.dirname, '../..')
const agent = (id: string) => ({ id, session: { header: { id, cwd } } })
const attempt = (subject: ReturnType<typeof agent>, file: string) => studioToolGuard({ name: 'edit', arguments: { file_path: file }, agent: subject })

test('two material Agents sharing one batch cwd retain separate file capabilities', () => {
  const a = agent('material-a'), b = agent('material-b')
  const releaseA = registerStudioExecutionScope(cwd, { readRoot: cwd, writablePaths: ['场景/a.md'] }, a)
  const releaseB = registerStudioExecutionScope(cwd, { readRoot: cwd, writablePaths: ['需求/b.md'] }, b)
  try {
    assert.equal(attempt(a, '场景/a.md'), undefined)
    assert.ok(attempt(a, '需求/b.md'))
    assert.equal(attempt(b, '需求/b.md'), undefined)
    assert.ok(attempt(b, '场景/a.md'))
  } finally { releaseB(); releaseA() }
})

test('a readonly split Agent never borrows a material writer in the same cwd', () => {
  const split = agent('split'), material = agent('material')
  const releaseSplit = registerStudioExecutionScope(cwd, { readRoot: cwd, writablePaths: [] }, split)
  const releaseMaterial = registerStudioExecutionScope(cwd, { readRoot: cwd, writablePaths: ['场景/a.md'] }, material)
  try {
    assert.ok(attempt(split, '场景/a.md'))
    assert.equal(studioToolGuard({ name: 'read', arguments: { file_path: '场景/a.md' }, agent: split }), undefined)
    assert.equal(attempt(material, '场景/a.md'), undefined)
  } finally { releaseMaterial(); releaseSplit() }
})

test('copying an Agent id, session header and cwd cannot acquire its policy', () => {
  const original = agent('same-session'), impostor = agent('same-session')
  const release = registerStudioExecutionScope(cwd, { readRoot: cwd, writablePaths: ['场景/a.md'] }, original)
  try { assert.ok(attempt(impostor, '场景/a.md')); assert.equal(attempt(original, '场景/a.md'), undefined) }
  finally { release() }
})

test('disposing one batch Agent does not remove another Agent policy', () => {
  const a = agent('dispose-a'), b = agent('dispose-b')
  const releaseA = registerStudioExecutionScope(cwd, { readRoot: cwd, writablePaths: ['场景/a.md'] }, a)
  const releaseB = registerStudioExecutionScope(cwd, { readRoot: cwd, writablePaths: ['需求/b.md'] }, b)
  releaseA()
  try { assert.ok(attempt(a, '需求/b.md')); assert.equal(attempt(b, '需求/b.md'), undefined) }
  finally { releaseB() }
})

test('a child Agent inherits the live parent policy and loses it with the parent', () => {
  const parent = agent('parent'), child = agent('child'), unrelated = agent('unrelated')
  const releaseParent = registerStudioExecutionScope(cwd, { readRoot: cwd, writablePaths: ['场景/a.md'] }, parent)
  const releaseChild = inheritStudioExecutionScope(parent, child)
  assert.ok(releaseChild)
  try {
    assert.equal(attempt(child, '场景/a.md'), undefined)
    assert.ok(attempt(child, '需求/b.md'))
    assert.ok(attempt(unrelated, '场景/a.md'))
  } finally { releaseChild(); releaseParent() }
  assert.ok(attempt(child, '场景/a.md'))
})

test('a child Agent cannot inherit into a different cwd', () => {
  const parent = agent('parent'), foreign = { id: 'foreign', session: { header: { id: 'foreign', cwd: path.dirname(cwd) } } }
  const release = registerStudioExecutionScope(cwd, { readRoot: cwd, writablePaths: ['场景/a.md'] }, parent)
  try { assert.throws(() => inheritStudioExecutionScope(parent, foreign), /子 Agent 只能继承当前工作台任务目录/) }
  finally { release() }
})
