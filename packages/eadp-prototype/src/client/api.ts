import type { Context } from '@deepseek-ai/cordis'
import { unwrapRemoteResult } from '@eadp/contracts'
import type {} from '@eadp/prototype/remote'

/** Keeps the view on the generated, typed Host interface. */
export function prototypeApi(ctx: Context) {
  const remote = ctx.remote.eadpPrototype
  return {
    listRuns: async () => unwrapRemoteResult(await remote.listRuns()),
    listFiles: async (projectId: string, directory: string) => unwrapRemoteResult(await remote.listFiles(projectId, directory)),
    readFile: async (projectId: string, path: string) => unwrapRemoteResult(await remote.readFile(projectId, path)),
    createProject: async (projectId: string) => unwrapRemoteResult(await remote.createProject(projectId)),
    install: async (projectId: string) => unwrapRemoteResult(await remote.install(projectId)),
    start: async (projectId: string) => unwrapRemoteResult(await remote.start(projectId)),
    stop: async (projectId: string) => unwrapRemoteResult(await remote.stop(projectId)),
    status: async (projectId: string) => unwrapRemoteResult(await remote.status(projectId)),
    logs: async (projectId: string) => unwrapRemoteResult(await remote.logs(projectId)),
    openBrowser: async (projectId: string) => unwrapRemoteResult(await remote.openBrowser(projectId)),
  }
}
export type PrototypeApi = ReturnType<typeof prototypeApi>
