import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type { CheckEvidence, ProjectPrototypeView, ProjectState, PrototypeEngineeringEvidence, PrototypeTaskView } from '@eadp/contracts'
import { StudioApplication } from './application/studio.ts'
import { StudioStore } from './application/state.ts'
import type { HostPorts } from './application/ports.ts'
import type { TaskView } from '../shared/studio.ts'
import { CollaborationClient } from './adapters/collaboration/client.ts'
import { PlatformRuntime } from './adapters/platform/runtime.ts'
import { DesktopSecretStore } from './adapters/platform/credentials.ts'
import { CollaborationSession } from './adapters/collaboration/session.ts'
import { CollaborationTransport } from './adapters/collaboration/transport.ts'
import { WorkspaceGit } from './adapters/workspace/git.ts'
import { coordinateStudioToolWrite, studioToolGuard } from './adapters/platform/execution-guard.ts'
import { DshTaskSessions } from './adapters/dsh/sessions.ts'
import { compareLocalMaterials } from './adapters/dsh/consistency.ts'
import { summarizeText } from './adapters/dsh/summary.ts'
import { identifyPrototypeRequirements } from './adapters/dsh/prototype-requirements.ts'
import { mergeRemoteConflict } from './adapters/dsh/merge.ts'
import { readScenarioSource } from './adapters/dsh/scenario-sources.ts'
import { checkStaticPreview } from './adapters/dsh/browser-check.ts'
import { desktopPreviewCanvas } from './adapters/dsh/prototype-canvas.ts'
import { PrototypeBrowserTools } from './adapters/dsh/prototype-browser-tools.ts'
import { PrototypeBrowserAttachmentStore } from './prototype/browser-attachments.ts'
import { copyTemplate } from './prototype/template.ts'
import { assertCurrentPrototypeChecks, buildPrototypePreview, installPrototypeDependencies, runPrototypeChecks } from './prototype/checks.ts'
import { PrototypeCheckJournal } from './prototype/check-journal.ts'
import { preparePrototypeBuildWorkspace } from './prototype/build-workspace.ts'
import { startPrototypePreview, type PrototypePreview } from './prototype/preview.ts'
import type { PrototypeTaskIdentity } from './prototype/generation.ts'
import type { PrototypePreviewIdentity } from '../shared/prototype.ts'
import { PublicationService, type PublicationBaseline } from './prototype/publication.ts'
import { SshPublicationTarget } from './adapters/publication/ssh-target.ts'
import { digest } from './adapters/assets/materials.ts'

async function installedBrowserRuntime(assets: string): Promise<{ runtime?: { root: string; manifest: string; manifestSha256: string }; unavailable?: string }> {
  try {
    const release = JSON.parse(await readFile(path.join(assets, 'browser-runtime.release.json'), 'utf8')) as { manifest?: string; manifestSha256?: string; platform?: string; arch?: string; playwright?: string; chromiumRevision?: string; chromiumVersion?: string }
    if (release.manifest !== 'browser-runtime/browser-manifest.json' || !/^[a-f0-9]{64}$/.test(release.manifestSha256 ?? '') || release.platform !== process.platform || release.arch !== process.arch || release.playwright !== '1.61.1' || release.chromiumRevision !== '1228' || release.chromiumVersion !== '149.0.7827.55') throw new Error('浏览器发行元数据与当前固定版本不匹配')
    return { runtime: { root: path.join(assets, 'browser-runtime'), manifest: path.join(assets, 'browser-runtime', 'browser-manifest.json'), manifestSha256: release.manifestSha256! } }
  } catch (error) { return { unavailable: `受信浏览器运行时不可用：${error instanceof Error ? error.message : '发行元数据不可读取'}` } }
}

export interface Config {
  collaborationUrl?: string;
  workspaceRoot?: string; stateDirectory?: string; runtimeRoot?: string;
  publication?: { projectId: string; host: string; port: number; username: string; knownHostKey: string; root: string; url: string; node: string; flock: string; credentialKey: `publication-${string}`; access: 'public' | 'restricted' }
}
/** Product deployment config belongs in the shipped Host bundle; users do not deploy a backend. */
export async function composeStudio(ctx: Context, config: Config): Promise<StudioApplication> {
  const collaborationUrl = config.collaborationUrl ?? 'http://100.119.183.44:6972'
  const stateDirectory = config.stateDirectory ?? path.join(process.env.APPDATA ?? path.join(homedir(), '.local/share'), 'eadp-studio', 'studio')
  const workspaceRoot = config.workspaceRoot ?? path.join(homedir(), 'EADP')
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
  const checkJournal = new PrototypeCheckJournal(store, digest(JSON.stringify(runtime.manifest.tools)))
  let app: StudioApplication
  const previews = new Map<string, { preview: PrototypePreview; identity: PrototypePreviewIdentity }>()
  const browserTools = new PrototypeBrowserTools({
    ...await installedBrowserRuntime(assets),
    attachments: new PrototypeBrowserAttachmentStore(async scope => path.join(await store.projectDirectory(scope.projectId), 'prototype-browser-attachments')),
    scope: async (task, validationRunId) => {
      const entry = previews.get(task.sessionId)
      if (!entry || entry.identity.source.kind !== 'task' || entry.identity.source.prototypeTaskId !== task.entityId || task.purpose !== 'prototype' || task.prototypeBaseline) return undefined
      const identity = await auth.current(), local = await store.read()
      if (!identity) return undefined
      const remote = await api.request<PrototypeTaskView>('GET', `/v1/projects/${encodeURIComponent(task.projectId)}/prototype/tasks/${encodeURIComponent(task.entityId)}`)
      if (remote.id !== task.entityId || remote.status !== 'active' || remote.ownerId !== identity.user.id || remote.clientId !== local.clientId) return undefined
      return { accountId: identity.user.id, projectId: task.projectId, sessionId: task.sessionId, validationRunId,
        target: { kind: 'task', prototypeTaskId: task.entityId, taskGeneration: remote.generation }, previewId: entry.identity.previewId,
        previewGeneration: entry.identity.generation, buildHash: entry.identity.buildHash, origin: entry.preview.url }
    },
  })
  const sessions = new DshTaskSessions(ctx, manifestPath, (id, content) => app.acceptSessionOutput(id, content), (task, signal) => app.scenarioSessionContext(task, signal), path.join(assets, 'skills'), task => app.prototypeWriteAuthorization(task), () => app.prototypeMaterials, browserTools)
  let previewGeneration = 0
  const availablePort = async (): Promise<number> => new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配预览端口')); return }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
  const prototypeInput = async (task: TaskView, sourceSha?: string): Promise<PrototypeTaskIdentity> => ({ prototypeRoot: path.join(task.worktree, '原型代码'), manifestPath, projectId: task.projectId, prototypeTaskId: task.entityId, sessionId: task.sessionId, sourceSha: sourceSha ?? (await git.state(task.worktree)).head })
  const stopPreview = async (sessionId?: string) => {
    const owned = sessionId ? [...previews.entries()].filter(([id]) => id === sessionId) : [...previews.entries()]
    const failures: unknown[] = []
    try { if (sessionId) await browserTools.close(sessionId); else await browserTools.dispose() } catch (error) { failures.push(error) }
    for (const [id, entry] of owned) {
      previews.delete(id)
      app.prototypePreviewStopped(entry.identity)
      try { await desktopPreviewCanvas.revoke(entry.identity) } catch (error) { failures.push(error) }
      try { await entry.preview.stop() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, '部分预览未能完整关闭，请核对桌面状态')
  }
  const runCandidateBuild = async (task: TaskView, sourceSha: string, operationId: string): Promise<{ evidence: PrototypeEngineeringEvidence; directory: string; dispose(): Promise<void> }> => {
    const journal = await checkJournal.begin(task, sourceSha, operationId, 'checks')
    let workspace: Awaited<ReturnType<typeof preparePrototypeBuildWorkspace>> | undefined
    try {
      workspace = await preparePrototypeBuildWorkspace(await prototypeInput(task, sourceSha))
      const input = workspace.input
      await installPrototypeDependencies(runtime, input, undefined, journal.step)
      const result = await runPrototypeChecks(runtime, input, undefined, journal.step)
      await journal.step('browser', 'running')
      const current = await startPrototypePreview(runtime, input, result, await availablePort(), undefined, journal.step)
      let browser: Awaited<ReturnType<typeof checkStaticPreview>>
      try { browser = await checkStaticPreview(`${current.url}/`) } finally { await current.stop() }
      await assertCurrentPrototypeChecks(input, result)
      await workspace.verify()
      await journal.step('browser', 'passed')
      await journal.finish('passed', result)
      const binding = { candidateSha: sourceSha, inputHash: result.inputHash, outputHash: result.outputHash, rulesHash: result.rulesSha256 }
      const evidence: PrototypeEngineeringEvidence = { candidateSha: sourceSha, sourceTreeHash: result.inputHash, rulesHash: result.rulesSha256, buildArtifactSha256: result.outputHash, checks: [
        { name: 'engineering', passed: true, evidenceHash: digest(JSON.stringify({ ...binding, result, tools: runtime.manifest.tools })) },
        { name: 'mock', passed: true, evidenceHash: digest(JSON.stringify({ ...binding, result: browser.mockHash })) },
        { name: 'browser', passed: true, evidenceHash: digest(JSON.stringify({ ...binding, result: browser.browserHash })) },
      ] }
      const completed = workspace
      return { evidence, directory: path.join(input.prototypeRoot, 'dist'), dispose: () => completed.dispose() }
    } catch (error) { try { await workspace?.dispose() } finally { await journal.finish('failed', undefined, error) }; throw error }
  }
  const runCandidateChecks = async (task: TaskView, sourceSha: string, operationId: string): Promise<PrototypeEngineeringEvidence> => {
    const build = await runCandidateBuild(task, sourceSha, operationId)
    try { return build.evidence } finally { await build.dispose() }
  }
  const runChecks = async (task: TaskView, sourceSha: string, operationId = crypto.randomUUID()): Promise<CheckEvidence> => {
    const evidence = await runCandidateChecks(task, sourceSha, operationId)
    return { candidateSha: sourceSha, passed: true, checks: evidence.checks }
  }
  const publication = new PublicationService({
    authority: {
      authorize: async projectId => {
        if (!config.publication || config.publication.projectId !== projectId) throw new Error('尚未配置项目发布目标及独立发布授权')
        if (!await credentials.read(config.publication.credentialKey)) throw new Error('独立发布凭据尚未配置')
      },
      current: async projectId => {
        const state = await api.request<ProjectState>('GET', `/v1/projects/${projectId}`)
        const prototype = await api.request<ProjectPrototypeView>('GET', `/v1/projects/${projectId}/prototype`)
        const baseline = state.baselines.find(b => b.id === prototype.currentBaselineId)
        if (!baseline) throw new Error('项目没有已确认原型基线')
        if (!state.project.recognizedHead) throw new Error('项目尚未完成初始化')
        return { projectId, prototypeId: baseline.prototypeId, baselineId: baseline.id, commitSha: baseline.commitSha, acceptanceId: baseline.acceptanceId, acceptedHead: state.project.recognizedHead! }
      },
    },
    build: async (baseline: PublicationBaseline) => {
      const local = await store.read(); const project = local.projects.find(p => p.id === baseline.projectId)
      if (!project) throw new Error('发布项目未在本机登记')
      await git.fetch(project.directory, (await api.request<ProjectState>('GET', `/v1/projects/${project.id}`)).project.stableBranch)
      const operationId = crypto.randomUUID()
      const worktree = path.join(await store.projectDirectory(project.id), 'publication', operationId)
      await git.createWorktree(project.directory, worktree, `publication/${operationId}`, baseline.commitSha)
      const task: TaskView = { projectId: project.id, entityId: baseline.prototypeId, purpose: 'prototype', sessionId: `studio-publication-${operationId}`, inputHash: baseline.commitSha, worktree }
      const build = await runCandidateBuild(task, baseline.commitSha, operationId)
      return { directory: build.directory, dispose: async () => { await build.dispose(); await stopPreview(task.sessionId); await git.removeWorktree(project.directory, worktree) } }
    },
    ...(config.publication ? { target: new SshPublicationTarget(runtime, { ...config.publication, credentials, authority: baselineId => api.request('POST', `/v1/projects/${config.publication!.projectId}/publication-authorizations`, { baselineId }) }) } : {}),
  })
  const ports: HostPorts = {
    workspaceRoot, prototypeManifestPath: manifestPath, git,
    gitLocal: (args, cwd) => git.local(cwd, args),
    login: (username, password) => auth.login(username, password), logout: () => auth.logout(),
    account: async () => (await auth.current())?.user,
    installTemplate: async destinationRoot => { await copyTemplate({ templateRoot: path.join(assets, 'prototype-template'), manifestPath, destinationRoot }) },
    session: async (task, rules, requireExisting) => sessions.open(task, rules, task.purpose === 'prototype' ? await prototypeInput(task) : undefined, requireExisting),
    prompt: (id, text, operationId, attachments) => sessions.prompt(id, text, operationId, attachments), inspectPrompt: (id, operationId) => sessions.inspectPrompt(id, operationId), readPrototypeConversation: id => sessions.readPrototypeConversation(id), lastPrototypeTurn: id => sessions.lastPrototypeTurn(id), identifyPrototypeRequirements: (input, signal) => identifyPrototypeRequirements(ctx, input, signal), compareConsistency: (input, signal) => compareLocalMaterials(ctx, input, signal), summarize: (input, signal) => summarizeText(ctx, input, signal), mergeConflict: (input, signal) => mergeRemoteConflict(ctx, input, signal), cancelSession: id => sessions.cancel(id), settlePrototypeSession: (id, cancel) => sessions.settlePrototype(id, cancel), releaseTask: worktree => sessions.releaseWorktree(worktree), readScenarioSource: source => readScenarioSource(ctx, source), checks: runChecks, candidateChecks: runCandidateChecks, prototypeCheckReports: tasks => checkJournal.latest(tasks),
    preview: async (task, operationId) => {
        const source = await prototypeInput(task, task.prototypeBaseline?.commitSha)
        const journal = await checkJournal.begin(task, source.sourceSha, operationId, 'preview')
        let next: PrototypePreview | undefined
        let workspace: Awaited<ReturnType<typeof preparePrototypeBuildWorkspace>> | undefined
        try {
          workspace = await preparePrototypeBuildWorkspace(source)
          const input = workspace.input
          await installPrototypeDependencies(runtime, input, undefined, journal.step)
          const result = await buildPrototypePreview(runtime, input, undefined, journal.step)
          await journal.step('browser', 'running')
          next = await startPrototypePreview(runtime, input, result, await availablePort(), undefined, journal.step)
          await checkStaticPreview(`${next.url}/`)
          await workspace.verify()
          const running = next, prepared = workspace
          next = { ...running, stop: async () => { try { await running.stop() } finally { await prepared.dispose() } } }
          await journal.step('browser', 'passed')
          const identity: PrototypePreviewIdentity = { projectId: task.projectId, source: task.prototypeBaseline ? { kind: 'baseline', baselineId: task.prototypeBaseline.id, commitSha: task.prototypeBaseline.commitSha } : { kind: 'task', prototypeTaskId: task.entityId }, previewId: next.previewId, generation: ++previewGeneration, buildHash: next.buildHash }
          await desktopPreviewCanvas.register({ ...identity, url: next.url })
          try { await stopPreview(task.sessionId); await journal.finish('passed', result) }
          catch (error) { await desktopPreviewCanvas.revoke(identity).catch(() => {}); throw error }
          const entry = { preview: next, identity }; previews.set(task.sessionId, entry)
          void next.process.done.finally(() => { if (previews.get(task.sessionId) === entry) { previews.delete(task.sessionId); app.prototypePreviewStopped(identity); void browserTools.close(task.sessionId).catch(() => {}); void desktopPreviewCanvas.revoke(identity).catch(() => {}) }; void prepared.dispose().catch(() => {}) }).catch(() => {})
          return { url: next.url, identity }
        } catch (error) { if (next) await next.stop().catch(() => {}); try { await workspace?.dispose() } finally { await journal.finish('failed', undefined, error) }; throw error }
    }, selectPreview: identity => identity ? desktopPreviewCanvas.select(identity) : desktopPreviewCanvas.deselect(), stopPreview,
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
    ctx.effect(() => ctx.on('tools/execute', (execution, next) => coordinateStudioToolWrite(execution, next)), 'studio: prototype write coordination')
    ctx.effect(() => async () => { auth.dispose(); await stopPreview(); await app.dispose(); await runtime.dispose() }, 'studio: host resources')
  return app
}
