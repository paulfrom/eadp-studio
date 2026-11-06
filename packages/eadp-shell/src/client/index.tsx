/** Local workbench Client registers only official main/sidebar seats. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@eadp/contracts/client'
import type { EadpPrototypeClient } from '@eadp/contracts/prototype'
import shellRemote from '@eadp/shell/remote'
import { ShellPanel } from './panel.tsx'
import { zh, en } from './locales.ts'
import type { ShellFace } from './types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { 'eadp.shell.session': { kind: 'single'; scope: 'session' } } }
declare module '@deepseek-ai/dsh-api-session-controller/client' { interface SessionReferenceSourceMap { eadpShell: unknown } }
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'uiWorkspace', 'remote', 'locale']
const PANEL = 'eadp-shell' as MainPanelId

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Exposes document context without sharing the Shell component or internal state. */
class ShellClientService extends Service {
  static inject = ['remote.eadpShell']
  constructor(ctx: Context) { super(ctx, 'eadpShellClient') }
  async setActiveDocument(projectId: string, relativePath: string | null): Promise<void> {
    unwrap(await this.ctx.remote.eadpShell.setActiveDocument(projectId, relativePath))
  }
}

/** Mount the generated Remote contract before injecting its namespace. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(shellRemote)
  ctx.plugin(ShellClientService)
  let prototype: EadpPrototypeClient | undefined
  const prototypeScope = ctx.inject(['eadpPrototypeClient'], (scope: Context) => {
    prototype = scope.eadpPrototypeClient
    return () => { prototype = undefined }
  })
  ctx.effect(() => ctx.locale.register('eadpShell', { zh, en }), 'eadp-shell: locale')
  const ui = ctx.inject(['remote.eadpShell', 'eadpRequirementsClient'], (scope: Context) => {
    const face: ShellFace = {
      workspaces: scope.workspaces,
      pickDirectory: () => scope.uiWorkspace.pickDirectory(),
      createDirectory: (parent, name) => scope.uiWorkspace.createDirectory(parent, name),
      checkDirectory: async path => { await scope.uiWorkspace.listDirectory(path) },
      requirements: scope.eadpRequirementsClient,
      stopProject: async projectId => {
        if (!prototype) throw new Error(scope.locale.bind('eadpShell')('unavailable'))
        await prototype.stopProject(projectId)
      },
      validateRelocation: async path => unwrap(await scope.remote.eadpShell.validateRelocation(path)),
      assertRemovable: async projectId => unwrap(await scope.remote.eadpShell.assertRemovable(projectId)),
      createSession: async (projectId, role) => unwrap(await scope.remote.eadpShell.createSession(projectId, role)),
      restoreSession: async (projectId, id) => unwrap(await scope.remote.eadpShell.restoreSession(projectId, id)),
      retainSession: id => scope.sessions.retain(id as SessionId, { source: 'eadpShell' }),
    }
    scope.slots.register({ name: 'main', key: PANEL, locale: 'eadpShell', children: {
      'eadp.requirements.view': { kind: 'single', scope: 'root' },
      'eadp.prototype.view': { kind: 'single', scope: 'root' },
      'eadp.knowledge.view': { kind: 'single', scope: 'root' },
      'eadp.shell.session': { kind: 'single', scope: 'session' },
    }, inject: () => face }, ShellPanel)
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 0, label: () => scope.locale.bind('eadpShell')('title') }, () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 4h16v16H4zM9 4v16M9 10h11" /></svg>))
    scope.layout.selectPanel(PANEL)
  })
  // Feature packages register the editor service after this module loads; keep
  // the dependency fiber pending without blocking the Client loader.
  return async () => { await ui.dispose(); await prototypeScope.dispose(); await disposeRemote() }
}
