import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface PublicationBaseline { projectId: string; prototypeId: string; baselineId: string; commitSha: string; acceptanceId: string; acceptedHead: string }
export interface PublicationArtifact { baseline: PublicationBaseline; buildId: string; sha256: string; files: { path: string; sha256: string; bytes: string }[] }
export interface PublicationRecord { operationId: string; phase: 'shareable' | 'revoked' | 'failed' | 'unknown'; baselineId?: string; commitSha?: string; artifactSha256?: string; url?: string; message?: string }
export interface PublicationTarget {
  publish(operationId: string, artifact: PublicationArtifact, expected: PublicationBaseline): Promise<PublicationRecord>
  query(operationId?: string): Promise<PublicationRecord>
  revoke(operationId: string, expectedArtifactSha256: string): Promise<PublicationRecord>
}
export interface PublicationOptions {
  authority: { current(projectId: string): Promise<PublicationBaseline>; authorize(projectId: string, operation: 'publish' | 'revoke'): Promise<void> }
  /** Must materialize the exact SHA, frozen-install/check/build and static-browser smoke before returning. */
  build: (baseline: PublicationBaseline) => Promise<{ directory: string; dispose(): Promise<void> }>
  target?: PublicationTarget
}
const sameBaseline = (a: PublicationBaseline, b: PublicationBaseline) => JSON.stringify(a) === JSON.stringify(b)

/** Deploys only the current accepted prototype baseline. A task directory is never an input. */
export class PublicationService {
  constructor(private readonly options: PublicationOptions) {}
  async publish(projectId: string): Promise<PublicationRecord> {
    const target = this.target()
    await this.options.authority.authorize(projectId, 'publish')
    const baseline = await this.options.authority.current(projectId)
    if (!baseline.baselineId || !/^[a-f0-9]{40}$/.test(baseline.commitSha) || !baseline.acceptanceId || !/^[a-f0-9]{40}$/.test(baseline.acceptedHead)) throw new Error('当前项目尚无可发布的已确认原型基线。')
    const build = await this.options.build(baseline)
    try {
      const files: PublicationArtifact['files'] = []
      let total = 0
      const visit = async (relative: string): Promise<void> => {
        for (const entry of await readdir(path.join(build.directory, relative), { withFileTypes: true })) {
          const file = path.posix.join(relative, entry.name)
          if (entry.name.startsWith('.') || /\.(?:md|pem|key|pfx|map)$/i.test(entry.name) || ['node_modules', '.git'].includes(entry.name)) throw new Error('静态产物包含不允许上传的文件。')
          const info = await lstat(path.join(build.directory, file))
          if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('静态产物包含链接或特殊文件。')
          if (info.isDirectory()) await visit(file)
          else {
            const bytes = await readFile(path.join(build.directory, file))
            total += bytes.byteLength
            if (total > 64 * 1024 * 1024 || files.length >= 10_000) throw new Error('静态产物超过发布限制。')
            files.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.toString('base64') })
          }
        }
      }
      await visit('')
      files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
      if (!files.some(file => file.path === 'index.html')) throw new Error('静态产物缺少入口页面。')
      const sha256 = createHash('sha256').update(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })))).digest('hex')
      if (!sameBaseline(baseline, await this.options.authority.current(projectId))) throw new Error('项目当前基线已变化，请基于新基线重新发布。')
      return await target.publish(randomUUID(), { baseline, buildId: randomUUID(), sha256, files }, baseline)
    } finally { await build.dispose() }
  }
  query(operationId?: string): Promise<PublicationRecord> { return this.target().query(operationId) }
  async revoke(projectId: string, expectedArtifactSha256: string): Promise<PublicationRecord> {
    const target = this.target()
    await this.options.authority.authorize(projectId, 'revoke')
    if (!/^[a-f0-9]{64}$/.test(expectedArtifactSha256)) throw new Error('撤回必须指定已核对的当前产物。')
    return target.revoke(randomUUID(), expectedArtifactSha256)
  }
  private target(): PublicationTarget { if (!this.options.target) throw new Error('尚未配置项目发布目标及独立发布授权。'); return this.options.target }
}
