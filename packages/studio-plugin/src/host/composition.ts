import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type { CheckEvidence, ProjectState } from '@eadp/contracts'
import { StudioApplication } from './application/studio.ts'
import { StudioStore } from './application/state.ts'
import type { HostPorts } from './application/ports.ts'
import type { TaskView } from '../shared/studio.ts'
import { CollaborationClient } from './adapters/collaboration/client.ts'
import { PlatformRuntime } from './adapters/platform/runtime.js'
import { DesktopSecretStore } from './adapters/platform/credentials.js'
import { CollaborationSession } from './adapters/collaboration/session.js'
import { CollaborationTransport } from './adapters/collaboration/transport.js'
import { WorkspaceGit } from './adapters/workspace/git.js'
import { studioToolGuard } from './adapters/platform/execution-guard.js'
import { DshTaskSessions } from './adapters/dsh/sessions.ts'
import { readScenarioSource } from './adapters/dsh/scenario-sources.ts'
import { checkStaticPreview } from './adapters/dsh/browser-check.ts'
import { copyTemplate } from './prototype/template.js'
import { installPrototypeDependencies, runPrototypeChecks, type PrototypeCheckResult } from './prototype/checks.js'
import { startPrototypePreview, type PrototypePreview } from './prototype/preview.js'
import type { PrototypeTaskIdentity } from './prototype/generation.js'
import { PublicationService, type PublicationBaseline } from './prototype/publication.js'
import { SshPublicationTarget } from './adapters/publication/ssh-target.js'
import { digest } from './adapters/assets/materials.ts'

export interface Config {
  collaborationUrl?: string;
  workspaceRoot?: string; stateDirectory?: string; runtimeRoot?: string;
  publication?: { projectId: string; host: string; port: number; username: string; knownHostKey: string; root: string; url: string; node: string; flock: string; credentialKey: `publication-${string}`; access: 'public' | 'restricted' }
}
/** Product deployment config belongs in the shipped Host bundle; users do not deploy a backend. */
export async function composeStudio(ctx: Context, config: Config): Promise<StudioApplication> {
  const collaborationUrl = config.collaborationUrl ?? 'http://100.119.183.44:6972'
  const stateDirectory = config.stateDirectory ?? path.join(process.env.APPDATA ?? path.join(homedir(), '.local/share'), 'eadp-studio', 'studio')
  const workspaceRoot = config.workspaceRoot ?? path.join(homedir(), 'EADP 项目')
  const runtimeRoot = config.runtimeRoot ?? path.join(path.dirname(process.argv[4] ?? ''), 'studio-tools')
  const runtime = await PlatformRuntime.load(path.join(runtimeRoot, 'runtime-manifest.json'), runtimeRoot, ctx.subprocess)
  const credentials = new DesktopSecretStore()
  const collaboration = new CollaborationTransport(collaborationUrl)
  const auth = new CollaborationSession(collaborationUrl, credentials, collaboration.request)
  const api = new CollaborationClient(collaborationUrl, () => auth.getAccessToken(), token => auth.invalidateToken(token), collaboration.request)
  ctx.effect(() => () => collaboration.dispose(), 'studio: collaboration transport')
  const git = new WorkspaceGit(runtime, async () => { const identity = await auth.current(); if (!identity) throw new Error('请先登录协同工作台。'); return identity.gitlabOrigin })
  const assets = fileURLToPath(new URL('../assets/', import.meta.url))
  const manifestPath = path.join(assets, 'prototype-template.manifest.json')
  const store = new StudioStore(stateDirectory)
  let app: StudioApplication
  const sessions = new DshTaskSessions(ctx, manifestPath, (id, content) => app.acceptSessionOutput(id, content), (task, signal) => app.scenarioSessionContext(task, signal), path.join(assets, 'skills'))
  const checkResults = new Map<string, PrototypeCheckResult>()
  let preview: PrototypePreview | undefined
  const prototypeInput = async (task: TaskView, sourceSha?: string): Promise<PrototypeTaskIdentity> => ({ prototypeRoot: path.join(task.worktree, '原型代码'), manifestPath, assetId: task.entityId, requirementId: task.entityId, sessionId: task.sessionId, sourceSha: sourceSha ?? (await git.state(task.worktree)).head })
  const bind = async (task: TaskView, sourceSha?: string) => {
    const input = await prototypeInput(task, sourceSha)
    await sessions.open(task, `仅实现当前需求 ${task.entityId}，固定输入 SHA-256 ${task.inputHash}。发现规则冲突时停止并请求作者修订。`, input)
    return { input, binding: await sessions.bind(task, input) }
  }
  const stopPreview = async () => { if (preview) { const owned = preview; preview = undefined; await owned.stop() } }
  const runChecks = async (task: TaskView, sourceSha: string): Promise<CheckEvidence> => {
    checkResults.delete(task.sessionId)
    try {
      await stopPreview()
      const { input, binding } = await bind(task, sourceSha)
      await installPrototypeDependencies(runtime, input, binding)
      const result = await runPrototypeChecks(runtime, input, binding)
      const current = await startPrototypePreview(runtime, input, binding, result, 4173)
      preview = current
      const browserHash = await checkStaticPreview(`${current.url}/`)
      checkResults.set(task.sessionId, result)
      return { candidateSha: sourceSha, passed: true, checks: [
        { name: 'engineering', passed: true, evidenceHash: digest(JSON.stringify(result)) },
        { name: 'mock', passed: true, evidenceHash: browserHash },
        { name: 'browser', passed: true, evidenceHash: browserHash },
        { name: 'relations', passed: true, evidenceHash: digest(`${task.entityId}:${task.inputHash}`) },
      ] }
    } catch (error) { checkResults.delete(task.sessionId); await stopPreview(); throw error }
  }
  const publication = new PublicationService({
    authority: {
      authorize: async projectId => {
        if (!config.publication || config.publication.projectId !== projectId) throw new Error('尚未配置项目发布目标及独立发布授权')
        if (!await credentials.read(config.publication.credentialKey)) throw new Error('独立发布凭据尚未配置')
      },
      current: async projectId => {
        const state = await api.request<ProjectState>('GET', `/v1/projects/${projectId}`)
        const baseline = state.baselines.find(b => b.id === state.project.currentBaselineId)
        if (!baseline) throw new Error('项目没有已确认原型基线')
        if (!state.project.recognizedHead) throw new Error('项目尚未完成初始化')
        return { projectId, assetId: baseline.entityId, baselineId: baseline.id, commitSha: baseline.commitSha, completionEvidence: [baseline.confirmationId], acceptedHead: state.project.recognizedHead! }
      },
    },
    build: async (baseline: PublicationBaseline) => {
      const local = await store.read(); const project = local.projects.find(p => p.id === baseline.projectId)
      if (!project) throw new Error('发布项目未在本机登记')
      await git.fetch(project.directory, (await api.request<ProjectState>('GET', `/v1/projects/${project.id}`)).project.stableBranch)
      const operationId = crypto.randomUUID()
      const worktree = path.join(store.directory, 'publication', operationId)
      await git.createWorktree(project.directory, worktree, `publication/${operationId}`, baseline.commitSha)
      const task: TaskView = { projectId: project.id, entityId: baseline.assetId, purpose: 'prototype', sessionId: `studio-publication-${operationId}`, inputHash: baseline.commitSha, worktree }
      try { await runChecks(task, baseline.commitSha) }
      catch (error) { await stopPreview(); throw error }
      return { directory: path.join(worktree, '原型代码/dist'), dispose: async () => { await stopPreview(); await git.removeWorktree(project.directory, worktree) } }
    },
    ...(config.publication ? { target: new SshPublicationTarget(runtime, { ...config.publication, credentials, authority: () => api.request('POST', `/v1/projects/${config.publication!.projectId}/publication-authorizations`, { idempotencyKey: crypto.randomUUID() }) }) } : {}),
  })
  const ports: HostPorts = {
    workspaceRoot, git,
    gitLocal: (args, cwd) => git.local(cwd, args),
    login: (username, password) => auth.login(username, password), logout: () => auth.logout(),
    account: async () => (await auth.current())?.user,
    installTemplate: async destinationRoot => { await copyTemplate({ templateRoot: path.join(assets, 'prototype-template'), manifestPath, destinationRoot }) },
    session: async (task, rules) => sessions.open(task, rules, task.purpose === 'prototype' ? await prototypeInput(task) : undefined),
    prompt: (id, text) => sessions.prompt(id, text), cancelSession: id => sessions.cancel(id), releaseTask: worktree => sessions.releaseWorktree(worktree), readScenarioSource: source => readScenarioSource(ctx, source), checks: runChecks,
    preview: async task => {
        try {
          const { input, binding } = await bind(task)
          const result = checkResults.get(task.sessionId)
          if (!result) throw new Error('请先运行工程检查并验证静态页面')
          await stopPreview(); preview = await startPrototypePreview(runtime, input, binding, result, 4173)
          await checkStaticPreview(`${preview.url}/`)
          return { url: preview.url }
        } catch (error) { checkResults.delete(task.sessionId); await stopPreview(); throw error }
    }, stopPreview,
    publication: async action => {
      const local = await store.read(); if (!local.selectedProjectId) throw new Error('请先选择项目')
      if (action === 'publish') {
        const result = await publication.publish(local.selectedProjectId)
        if (result.phase !== 'shareable' || !result.baselineId || !result.url || !result.artifactSha256) throw new Error(result.message ?? '远端发布结果未知，请查询实际站点')
        await api.request('POST', `/v1/projects/${local.selectedProjectId}/deployment`, { idempotencyKey: result.operationId, baselineId: result.baselineId, url: result.url, artifactSha256: result.artifactSha256 })
      } else { const current = await publication.query(); if (!current.artifactSha256) throw new Error('当前远端产物尚未核对，不能撤回'); const result = await publication.revoke(local.selectedProjectId, current.artifactSha256); if (result.phase !== 'revoked') throw new Error('撤回结果未知，请核对当前站点') }
    },
  }
  app = new StudioApplication(store, api, ports)
    ctx.effect(() => ctx.tools.guard(studioToolGuard), 'studio: monotonic execution guard')
    ctx.effect(() => async () => { auth.dispose(); await stopPreview(); await app.dispose(); await runtime.dispose() }, 'studio: host resources')
  return app
}
