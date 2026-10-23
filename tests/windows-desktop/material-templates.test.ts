import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { IntegrationView, ProjectState } from '../../packages/contracts/src/index.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { ProjectWorkspaces } from '../../packages/studio-plugin/src/host/application/projects.ts'
import { BackgroundLane } from '../../packages/studio-plugin/src/host/application/background-lane.ts'
import { ScenarioTemplates, type TemplateCatalogResponse } from '../../packages/studio-plugin/src/host/application/scenario-templates.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { digest } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'

async function fixture(t: { after(fn: () => Promise<unknown>): unknown }) {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-material-templates-'))
  const lane = new BackgroundLane()
  t.after(async () => { await lane.settle(); await rm(root, { recursive: true, force: true }) })
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  const local = await store.read(), directory = path.join(root, 'project')
  await mkdir(directory)
  await writeFile(path.join(directory, 'author-draft.md'), '作者未保存的业务内容')
  local.projects.push({ id: 'project', name: '项目', directory, repositoryUrl: 'https://example.test/project.git' })
  const originalHead = 'a'.repeat(40), candidateSha = 'b'.repeat(40)
  const remote = { project: { id: 'project', revision: 1, recognizedHead: originalHead, stableBranch: 'main' } } as ProjectState
  const bodies = { default: '# 场景模板\n', 'requirement-default': '# 需求模板\n' }
  const manifest = { schemaVersion: 1, projectId: 'project', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', directories: ['场景', '需求', '交接', '原型代码'],
    scenarioTemplates: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认场景模板', path: '.template/default.md' }] },
    requirementTemplates: { defaultTemplateId: 'requirement-default', templates: [{ id: 'requirement-default', name: '默认需求模板', path: '.template/requirement-default.md' }] } }
  const catalog = (input: typeof manifest.scenarioTemplates) => ({ defaultTemplateId: input.defaultTemplateId, templates: input.templates.map(template => ({ id: template.id, name: template.name, fixed: { commitSha: originalHead, path: template.path, sha256: digest(bodies[template.id as keyof typeof bodies]) } })) })
  const catalogs: TemplateCatalogResponse = { acceptedHead: originalHead, scenarios: catalog(manifest.scenarioTemplates), requirements: catalog(manifest.requirementTemplates) }
  const counters = { commits: 0, pushes: 0, preparations: 0, completions: 0 }
  let integration: IntegrationView | undefined, head = originalHead, loseReply = false, extraChange = false
  const api = { async request(method: string, route: string) {
    if (method === 'GET' && route.endsWith('/templates')) return catalogs
    if (method === 'GET' && route.includes('/operations/')) {
      if (integration) return { result: integration }
      throw new CollaborationError('OPERATION_NOT_FOUND', 'missing', 404)
    }
    if (method === 'POST' && route.endsWith('/integrations')) { counters.preparations++; integration = { id: 'integration', status: 'prepared' } as IntegrationView; return integration }
    if (method === 'GET' && route.endsWith('/integrations/integration')) return integration
    if (method === 'POST' && route.endsWith('/complete')) {
      counters.completions++; integration = { ...integration!, status: 'accepted' }
      if (loseReply) { loseReply = false; throw new Error('接受响应丢失') }
      return integration
    }
    throw new Error(`Unexpected ${method} ${route}`)
  } } as unknown as CollaborationClient
  let publicationDirectory = '', staged: string[] = []
  const ports = { async account() { return { id: 1, name: '作者', gitlabEmail: 'author@example.test' } }, git: {
    async fetch() {},
    async createWorktree(_directory: string, destination: string) {
      publicationDirectory = destination
      await mkdir(path.join(destination, '.template'), { recursive: true })
      await writeFile(path.join(destination, 'project.assets.json'), JSON.stringify(manifest))
      for (const [id, body] of Object.entries(bodies)) await writeFile(path.join(destination, '.template', `${id}.md`), body)
    },
    async commitFiles(_directory: string, files: string[]) { counters.commits++; staged = files; return candidateSha },
    async changedFiles() { return [...staged, ...(extraChange ? ['.template/default.md'] : [])] },
    async push() { counters.pushes++ },
    async remoteHead() { return head },
    async conditionalUpdate(_directory: string, _branch: string, expected: string, candidate: string) { assert.equal(head, expected); head = candidate },
  } } as unknown as HostPorts
  const read = async (_id: string, _sha: string, relative: string) => Buffer.from(relative === 'project.assets.json' ? JSON.stringify(manifest) : bodies[path.basename(relative, '.md') as keyof typeof bodies])
  const projects = { localFixed: read, readFixed: read } as unknown as ProjectWorkspaces
  const service = new ScenarioTemplates(store, api, ports, projects, lane)
  return { service, store, local, remote, manifest, bodies, counters, directory, lane, loseAcceptanceReply() { loseReply = true }, includeSceneTemplateChange() { extraChange = true }, get publicationDirectory() { return publicationDirectory }, get staged() { return staged } }
}

const updated = [
  { id: 'requirement-default', name: '默认需求模板', body: '# 更新的需求模板\n' },
  { id: 'requirement-new', name: '补充模板', body: '# 补充需求模板\n' },
]

test('requirement template publication changes only its catalog and preserves scene templates and material drafts', async t => {
  const f = await fixture(t)
  await f.service.preview(f.remote, 'requirement', updated, 'requirement-new')
  const operation = f.local.templateOperations[0]!
  assert.equal(operation.preview.kind, 'requirement')
  await f.service.publish(operation.preview.operationId, f.remote); await f.lane.settle()
  assert.equal(operation.phase, 'accepted')
  const manifest = JSON.parse(await readFile(path.join(f.publicationDirectory, 'project.assets.json'), 'utf8'))
  assert.deepEqual(manifest.scenarioTemplates, f.manifest.scenarioTemplates)
  assert.equal(manifest.requirementTemplates.defaultTemplateId, 'requirement-new')
  assert.equal(await readFile(path.join(f.publicationDirectory, '.template/default.md'), 'utf8'), f.bodies.default)
  assert.equal(await readFile(path.join(f.publicationDirectory, '.template/requirement-default.md'), 'utf8'), updated[0]!.body)
  assert.deepEqual(f.staged, ['project.assets.json', '.template/requirement-default.md', '.template/requirement-new.md'])
  assert.equal(await readFile(path.join(f.directory, 'author-draft.md'), 'utf8'), '作者未保存的业务内容')
})

test('template preview rejects cross-catalog identity collisions, historical deletion and unchanged input', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.preview(f.remote, 'requirement', [...updated, { id: 'DEFAULT', name: '覆盖场景', body: '# 不允许\n' }], 'requirement-new'), /独立标识/)
  await assert.rejects(f.service.preview(f.remote, 'requirement', [updated[1]!], 'requirement-new'), /不支持删除/)
  await assert.rejects(f.service.preview(f.remote, 'requirement', [{ id: 'requirement-default', name: '默认需求模板', body: f.bodies['requirement-default'] }], 'requirement-default'), /没有需要发布/)
  assert.equal(f.local.templateOperations.length, 0)
  assert.equal(f.counters.commits, 0)
})

test('a requirement publication rejects changes to the other catalog even when they are valid template paths', async t => {
  const f = await fixture(t)
  f.includeSceneTemplateChange()
  await f.service.preview(f.remote, 'requirement', updated, 'requirement-new')
  const operation = f.local.templateOperations[0]!
  await f.service.publish(operation.preview.operationId, f.remote); await f.lane.settle()
  assert.equal(operation.phase, 'unknown')
  assert.match(operation.message ?? '', /不允许的变更/)
  assert.equal(f.counters.preparations, 0)
  assert.equal(f.counters.pushes, 0)
})

test('retry after an unknown template acceptance reuses the fixed candidate and original integration', async t => {
  const f = await fixture(t)
  f.loseAcceptanceReply()
  await f.service.preview(f.remote, 'requirement', updated, 'requirement-new')
  const operation = f.local.templateOperations[0]!
  await f.service.publish(operation.preview.operationId, f.remote); await f.lane.settle()
  assert.equal(operation.phase, 'unknown')
  f.remote.project.recognizedHead = 'b'.repeat(40)
  await f.service.publish(operation.preview.operationId, f.remote); await f.lane.settle()
  assert.equal(operation.phase, 'accepted')
  assert.deepEqual(f.counters, { commits: 1, pushes: 1, preparations: 1, completions: 1 })
})
