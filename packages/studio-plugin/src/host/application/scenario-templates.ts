import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isProjectManifest, type FixedReference, type IntegrationView, type ProjectState, type ProjectView, type TemplateIntegrationRequest } from '@eadp/contracts'
import type { MaterialTemplateKind, ScenarioTemplatePreview } from '../../shared/scenarios.ts'
import type { ProjectTemplateCatalogs, TemplateCatalogView } from '../../shared/studio.ts'
import { containedFile, digest } from '../adapters/assets/materials.ts'
import { CollaborationError, type CollaborationClient } from '../adapters/collaboration/client.ts'
import type { StudioStore } from './state.ts'
import type { HostPorts } from './ports.ts'
import type { ProjectWorkspaces } from './projects.ts'
import type { BackgroundLane } from './background-lane.ts'

export interface TemplateOperation { preview: ScenarioTemplatePreview; projectId: string; directory?: string; request?: TemplateIntegrationRequest; integrationId?: string; phase: 'preview' | 'fixed' | 'prepared' | 'accepted' | 'unknown'; message?: string }
/** Template catalog entries as the collaboration API reports them; bodies are read locally. */
export type TemplateCatalogResponse = { acceptedHead: string; scenarios: { defaultTemplateId?: string; templates: Array<{ id: string; name: string; fixed: FixedReference }> }; requirements: { defaultTemplateId?: string; templates: Array<{ id: string; name: string; fixed: FixedReference }> } }
/** Publishes project configuration in a separate worktree, preserving all material drafts. */
export class ScenarioTemplates {
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts, private readonly projects: ProjectWorkspaces, private readonly lane: BackgroundLane) {}
  private readonly catalogs = new Map<string, ProjectTemplateCatalogs>()
  /**
   * Read the project's template catalogues from bodies already present locally.
   * @param project - selected project and its accepted head.
   * @returns the catalogues, or undefined while the background lane fetches a template commit.
   */
  async catalog(project: ProjectView): Promise<ProjectTemplateCatalogs | undefined> {
    const cacheKey = `${this.store.directory}:${project.id}:${project.recognizedHead}`
    const cached = this.catalogs.get(cacheKey)
    if (cached) return cached
    const catalog = await this.api.request<TemplateCatalogResponse>('GET', `/v1/projects/${project.id}/templates`)
    const withBodies = async (entry: TemplateCatalogResponse['scenarios']): Promise<TemplateCatalogView | undefined> => {
      const bodies = await Promise.all(entry.templates.map(template => this.projects.localFixed(project, template.fixed.commitSha, template.fixed.path, template.fixed.sha256)))
      if (bodies.some(bytes => bytes === undefined)) return undefined
      return { ...entry, templates: entry.templates.map((template, index) => ({ ...template, body: Buffer.from(bodies[index]!).toString('utf8') })) }
    }
    const scenarios = await withBodies(catalog.scenarios), requirements = await withBodies(catalog.requirements)
    if (!scenarios || !requirements) return undefined
    const result = { acceptedHead: catalog.acceptedHead, scenarios, requirements }
    if (this.catalogs.size >= 32) this.catalogs.delete(this.catalogs.keys().next().value!)
    this.catalogs.set(cacheKey, result)
    return result
  }
  async preview(remote: ProjectState, kind: MaterialTemplateKind, templates: ScenarioTemplatePreview['templates'], defaultTemplateId: string): Promise<void> {
    if (kind !== 'scenario' && kind !== 'requirement') throw new Error('模板类型无效')
    if (!templates.length || templates.length > 100 || !templates.some(t => t.id === defaultTemplateId) || new Set(templates.map(t => t.id.toLowerCase())).size !== templates.length) throw new Error('模板清单或默认模板无效')
    for (const t of templates) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(t.id) || !t.name.trim() || t.name.length > 500 || !t.body.trim() || Buffer.byteLength(t.body) > 1_000_000 || t.body.includes('\r')) throw new Error('模板须使用有效名称、标识与 UTF-8 LF Markdown')
    const catalog = await this.catalog(remote.project)
    if (!catalog) throw new Error('模板固定内容正在后台同步，请稍后重试。')
    const current = kind === 'scenario' ? catalog.scenarios : catalog.requirements
    const other = kind === 'scenario' ? catalog.requirements : catalog.scenarios
    if (other.templates.some(t => templates.some(next => next.id.toLowerCase() === t.id.toLowerCase()))) throw new Error('场景与需求模板必须使用独立标识，不能覆盖另一类模板')
    if (current.templates.some(t => !templates.some(next => next.id === t.id))) throw new Error('本阶段不支持删除历史模板')
    if (current.defaultTemplateId === defaultTemplateId && current.templates.length === templates.length && current.templates.every(value => templates.some(next => next.id === value.id && next.name === value.name && next.body === value.body))) throw new Error('当前模板没有需要发布的变更')
    const local = await this.store.read()
    local.templateOperations = local.templateOperations.filter(op => op.projectId !== remote.project.id || op.phase !== 'preview')
    local.templateOperations.push({ projectId: remote.project.id, preview: { kind, operationId: randomUUID(), expectedHead: remote.project.recognizedHead!, expectedRevision: remote.project.revision, templates, defaultTemplateId }, phase: 'preview' })
    await this.store.save()
  }
  /**
   * Queue publication of one previewed change. The worktree, commit, push and
   * backend acceptance run on the background lane, so the reply reports the
   * recorded operation instead of holding the settings surface for minutes.
   * @param operationId - previewed operation to publish.
   * @param remote - project state the preview was taken against.
   */
  async publish(operationId: string, remote: ProjectState): Promise<void> {
    const local = await this.store.read(), op = local.templateOperations.find(o => o.preview.operationId === operationId && o.projectId === remote.project.id)
    if (!op) throw new Error('请先预览模板变更')
    if (op.preview.kind !== 'scenario' && op.preview.kind !== 'requirement') throw new Error('模板类型无效，请重新生成预览')
    if (op.phase === 'accepted') return
    this.lane.schedule(`templates:${operationId}`, () => this.run(operationId, remote))
  }
  private async run(operationId: string, remote: ProjectState): Promise<void> {
    const local = await this.store.read(), op = local.templateOperations.find(o => o.preview.operationId === operationId && o.projectId === remote.project.id)
    if (!op || op.phase === 'accepted') return
    try {
      if (!op.request) {
        if (remote.project.recognizedHead !== op.preview.expectedHead || remote.project.revision !== op.preview.expectedRevision) throw new Error('项目版本已变化，请刷新并重新预览模板')
        const project = local.projects.find(p => p.id === remote.project.id)!
        const directory = path.join(await this.store.projectDirectory(remote.project.id), 'template-worktrees', operationId)
        if (!op.directory) {
          await this.ports.git.fetch(project.directory, remote.project.stableBranch)
          await this.ports.git.createWorktree(project.directory, directory, `studio/templates/${operationId}`, op.preview.expectedHead)
          op.directory = directory; await this.store.save()
        }
        const manifest = JSON.parse(Buffer.from(await this.projects.readFixed(remote.project.id, op.preview.expectedHead, 'project.assets.json')).toString('utf8')) as unknown
        if (!isProjectManifest(manifest)) throw new Error('项目契约版本过旧，不受支持')
        const property = op.preview.kind === 'scenario' ? 'scenarioTemplates' : 'requirementTemplates'
        const other = op.preview.kind === 'scenario' ? manifest.requirementTemplates : manifest.scenarioTemplates
        if (other.templates.some(t => op.preview.templates.some(next => next.id.toLowerCase() === t.id.toLowerCase()))) throw new Error('场景与需求模板必须使用独立标识，不能覆盖另一类模板')
        manifest[property] = { defaultTemplateId: op.preview.defaultTemplateId, templates: op.preview.templates.map(t => ({ id: t.id, name: t.name, path: `.template/${t.id}.md` })) }
        await mkdir(path.join(directory, '.template'), { recursive: true })
        for (const t of op.preview.templates) await writeFile(await containedFile(directory, `.template/${t.id}.md`, true), t.body, 'utf8')
        await writeFile(await containedFile(directory, 'project.assets.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        const files = ['project.assets.json', ...op.preview.templates.map(t => `.template/${t.id}.md`)]
        const account = await this.ports.account(); if (!account) throw new Error('请先登录')
        const identity = account.gitlabEmail ? { name: account.name || account.gitlabUsername, email: account.gitlabEmail } : await this.ports.git.identity(directory)
        const candidateSha = await this.ports.git.commitFiles(directory, files, op.preview.kind === 'scenario' ? '更新项目场景模板' : '更新项目需求模板', identity)
        const changed = await this.ports.git.changedFiles(directory, op.preview.expectedHead, candidateSha)
        if (!changed.length || changed.some(f => !files.includes(f))) throw new Error('模板候选含不允许的变更')
        op.request = { idempotencyKey: operationId, stage: 'template', sourceSha: candidateSha, candidateSha, expectedHead: op.preview.expectedHead, expectedProjectRevision: op.preview.expectedRevision, allowedPaths: changed, checks: { candidateSha, passed: true, checks: [{ name: `${op.preview.kind}-templates`, passed: true, evidenceHash: digest(JSON.stringify(manifest[property])) }] } }
        op.phase = 'fixed'; await this.store.save()
      }
      const request = op.request, directory = op.directory!
      if (!op.integrationId) {
        let integration: IntegrationView
        try { integration = (await this.api.request<{ result: IntegrationView }>('GET', `/v1/projects/${op.projectId}/operations/${operationId}`)).result }
        catch (error) {
          if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
          await this.ports.git.push(directory, request.candidateSha, `studio-fixed/${operationId}`)
          integration = await this.api.request('POST', `/v1/projects/${op.projectId}/integrations`, request)
        }
        op.integrationId = integration.id; op.phase = 'prepared'; await this.store.save()
      }
      let integration = await this.api.request<IntegrationView>('GET', `/v1/projects/${op.projectId}/integrations/${op.integrationId}`)
      if (integration.status === 'aborted') throw new Error('模板发布已中止，请重新预览')
      if (integration.status !== 'accepted') {
        const head = await this.ports.git.remoteHead(directory, remote.project.stableBranch)
        if (head === request.expectedHead) await this.ports.git.conditionalUpdate(directory, remote.project.stableBranch, request.expectedHead, request.candidateSha)
        else if (head !== request.candidateSha) throw new Error('远端头已变化，请保留候选并重新预览')
        integration = await this.api.request('POST', `/v1/projects/${op.projectId}/integrations/${integration.id}/complete`, { idempotencyKey: `${operationId}-complete` })
      }
      if (integration.status !== 'accepted') throw new Error('模板尚未被后台接受')
      op.phase = 'accepted'; delete op.message; await this.store.save()
    } catch (error) { op.phase = 'unknown'; op.message = error instanceof Error ? error.message : '模板发布结果待核对'; await this.store.save(); throw error }
  }
}
