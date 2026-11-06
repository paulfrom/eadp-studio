import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@eadp/prototype/remote'

function unwrap<T>(reply: RemoteResult<T>): T {
  if (!reply.ok) throw reply.error
  return reply.value
}

/** Keeps the view on the generated, typed Host interface. */
export function prototypeApi(ctx: Context) {
  const remote = ctx.remote.eadpPrototype
  return {
    listRuns: async () => unwrap(await remote.listRuns()),
    listFiles: async (projectId: string, directory: string) => unwrap(await remote.listFiles(projectId, directory)),
    readFile: async (projectId: string, path: string) => unwrap(await remote.readFile(projectId, path)),
    createProject: async (projectId: string) => unwrap(await remote.createProject(projectId)),
    install: async (projectId: string) => unwrap(await remote.install(projectId)),
    start: async (projectId: string) => unwrap(await remote.start(projectId)),
    stop: async (projectId: string) => unwrap(await remote.stop(projectId)),
    status: async (projectId: string) => unwrap(await remote.status(projectId)),
    logs: async (projectId: string) => unwrap(await remote.logs(projectId)),
    openBrowser: async (projectId: string) => unwrap(await remote.openBrowser(projectId)),
  }
}
export type PrototypeApi = ReturnType<typeof prototypeApi>
