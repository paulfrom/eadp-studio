import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '../..')
const ts = createRequire(path.join(repo, '.local/build/dsh/package.json'))('typescript')
const source = await readFile(path.join(repo, 'packages/studio-plugin/src/client/scenarios/document.ts'), 'utf8')
const compiled = ts.transpileModule(source.replace(/^import .+\n/gm, '').replace(/\bexport /g, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText.replace(/^export \{\};?\s*$/gm, '')
const { splitSections, listItemCount, sectionSummary } = new Function(`${compiled}; return { splitSections, listItemCount, sectionSummary }`)()

test('a scenario body splits into its business sections', () => {
  const sections = splitSections('# 场景名称\n\n## 目标与范围\n\n说明适用范围。\n\n## 流程\n\n1. 提交\n2. 复核\n')
  assert.deepEqual(sections.map(section => section.title), ['目标与范围', '流程'])
  assert.equal(sections[0].body, '说明适用范围。')
  assert.equal(sections[1].body, '1. 提交\n2. 复核')
})

test('headings inside fences and the document title never become sections', () => {
  const sections = splitSections('# 场景名称\n\n```md\n## 代码里的标题\n```\n\n## 业务规则\n\n- 必须留痕\n')
  assert.deepEqual(sections.map(section => section.title), ['', '业务规则'])
  assert.equal(sections[0].body, '```md\n## 代码里的标题\n```')
})

test('an empty body yields no sections so the panel can show the template skeleton', () => {
  assert.deepEqual(splitSections(''), [])
  assert.deepEqual(splitSections('\n\n'), [])
})

test('section entry counts skip fenced and ordinary paragraphs', () => {
  assert.equal(listItemCount('- 一\n- 二\n\n说明'), 2)
  assert.equal(listItemCount('```\n- 不计数\n```\n1. 计数'), 1)
  assert.equal(listItemCount('普通段落'), 0)
})

test('collapsed section summaries skip code and headings and remove inline Markdown', () => {
  assert.equal(sectionSummary('### 注意\n\n```md\n错误摘要\n```\n\n- [x] **复核** [付款凭证](https://example.test) 与 `金额`'), '复核 付款凭证 与 金额')
  assert.equal(sectionSummary('| --- | :---: |\n| 角色 | 权限 |'), '角色 · 权限')
  assert.equal(sectionSummary('```\n只有代码\n```'), '展开查看章节内容')
  assert.equal(sectionSummary('长'.repeat(80)), `${'长'.repeat(72)}…`)
})
