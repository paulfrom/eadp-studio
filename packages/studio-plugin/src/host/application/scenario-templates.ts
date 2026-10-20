import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isProjectManifest, type IntegrationView, type ProjectState, type TemplateIntegrationRequest } from '@eadp/contracts'
import type { ScenarioTemplatePreview } from '../../shared/scenarios.ts'
import type { ScenarioTemplateCatalog } from '../../shared/studio.ts'
import { containedFile, digest } from '../adapters/assets/materials.ts'
import { CollaborationError, type CollaborationClient } from '../adapters/collaboration/client.ts'
import type { StudioStore } from './state.ts'
import type { HostPorts } from './ports.ts'
import type { ProjectWorkspaces } from './projects.ts'

export interface TemplateOperation { preview: ScenarioTemplatePreview; projectId: string; directory?: string; request?: TemplateIntegrationRequest; integrationId?: string; phase: 'preview' | 'fixed' | 'prepared' | 'accepted' | 'unknown'; message?: string }
/** Publishes project configuration in a separate worktree, preserving all material drafts. */
export class ScenarioTemplates {
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts, private readonly projects: ProjectWorkspaces) {}
  private readonly catalogs = new Map<string, ScenarioTemplateCatalog>()
  async catalog(projectId: string, head?: string): Promise<ScenarioTemplateCatalog> {
    const cacheKey = `${this.store.directory}:${projectId}:${head}`
    if (head && this.catalogs.has(cacheKey)) return this.catalogs.get(cacheKey)!
    const catalog = await this.api.request<ScenarioTemplateCatalog>('GET', `/v1/projects/${projectId}/templates`)
    const templates = await Promise.all(catalog.templates.map(async template => {
      const bytes = await this.projects.readFixed(projectId, template.fixed.commitSha, template.fixed.path, template.fixed.sha256)
      if (digest(bytes) !== template.fixed.sha256) throw new Error('模板固定内容 hash 不符')
      return { ...template, body: Buffer.from(bytes).toString('utf8') }
    }))
    const result = { ...catalog, templates }
    if (this.catalogs.size >= 32) this.catalogs.delete(this.catalogs.keys().next().value!)
    this.catalogs.set(cacheKey, result)
    return result
  }
  async preview(remote: ProjectState, templates: ScenarioTemplatePreview['templates'], defaultTemplateId: string): Promise<void> {
    if (!templates.length || templates.length > 100 || !templates.some(t => t.id === defaultTemplateId) || new Set(templates.map(t => t.id)).size !== templates.length) throw new Error('模板清单或默认模板无效')
    for (const t of templates) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(t.id) || !t.name.trim() || t.name.length > 500 || !t.body.trim() || Buffer.byteLength(t.body) > 1_000_000 || t.body.includes('\r')) throw new Error('模板须使用有效名称、标识与 UTF-8 LF Markdown')
    const catalog = await this.catalog(remote.project.id)
    if (catalog.templates.some(t => !templates.some(next => next.id === t.id))) throw new Error('本阶段不支持删除历史模板')
    if (catalog.defaultTemplateId === defaultTemplateId && catalog.templates.length === templates.length && catalog.templates.every(value => templates.some(next => next.id === value.id && next.name === value.name && next.body === value.body))) throw new Error('当前模板没有需要发布的变更')
    const local = await this.store.read()
    local.templateOperations = local.templateOperations.filter(op => op.projectId !== remote.project.id || op.phase !== 'preview')
    local.templateOperations.push({ projectId: remote.project.id, preview: { operationId: randomUUID(), expectedHead: remote.project.recognizedHead!, expectedRevision: remote.project.revision, templates, defaultTemplateId }, phase: 'preview' })
    await this.store.save()
  }
  async publish(operationId: string, remote: ProjectState): Promise<void> {
    const local = await this.store.read(), op = local.templateOperations.find(o => o.preview.operationId === operationId && o.projectId === remote.project.id)
    if (!op) throw new Error('请先预览模板变更')
    if (op.phase === 'accepted') return
    try {
      if (!op.request) {
        if (remote.project.recognizedHead !== op.preview.expectedHead || remote.project.revision !== op.preview.expectedRevision) throw new Error('项目版本已变化，请刷新并重新预览模板')
        const project = local.projects.find(p => p.id === remote.project.id)!
        const directory = path.join(this.store.directory, 'template-worktrees', remote.project.id, operationId)
        if (!op.directory) {
          await this.ports.git.fetch(project.directory, remote.project.stableBranch)
          await this.ports.git.createWorktree(project.directory, directory, `studio/templates/${operationId}`, op.preview.expectedHead)
          op.directory = directory; await this.store.save()
        }
        const manifest = JSON.parse(Buffer.from(await this.projects.readFixed(remote.project.id, op.preview.expectedHead, 'project.assets.json')).toString('utf8')) as unknown
        if (!isProjectManifest(manifest)) throw new Error('项目清单无效')
        manifest.scenarioTemplates = { defaultTemplateId: op.preview.defaultTemplateId, templates: op.preview.templates.map(t => ({ id: t.id, name: t.name, path: `.template/${t.id}.md` })) }
        await mkdir(path.join(directory, '.template'), { recursive: true })
        for (const t of op.preview.templates) await writeFile(await containedFile(directory, `.template/${t.id}.md`, true), t.body, 'utf8')
        await writeFile(await containedFile(directory, 'project.assets.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        const files = ['project.assets.json', ...op.preview.templates.map(t => `.template/${t.id}.md`)]
        const account = await this.ports.account(); if (!account) throw new Error('请先登录')
        const identity = account.gitlabEmail ? { name: account.name || account.gitlabUsername, email: account.gitlabEmail } : await this.ports.git.identity(directory)
        const candidateSha = await this.ports.git.commitFiles(directory, files, '更新项目场景模板', identity)
        const changed = await this.ports.git.changedFiles(directory, op.preview.expectedHead, candidateSha)
        if (!changed.length || changed.some(f => f !== 'project.assets.json' && !/^\.template\/[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/.test(f))) throw new Error('模板候选含不允许的变更')
        op.request = { idempotencyKey: operationId, stage: 'template', sourceSha: candidateSha, candidateSha, expectedHead: op.preview.expectedHead, expectedProjectRevision: op.preview.expectedRevision, allowedPaths: changed, checks: { candidateSha, passed: true, checks: [{ name: 'scenario-templates', passed: true, evidenceHash: digest(JSON.stringify(manifest.scenarioTemplates)) }] } }
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
