import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PlatformRuntime } from '../platform/runtime.js'
import type { SecretStore } from '../platform/credentials.js'
import type { PublicationArtifact, PublicationBaseline, PublicationRecord, PublicationTarget } from '../../prototype/publication.js'
import { REMOTE_PUBLICATION_RUNNER } from './remote-runner.js'

export interface SshPublicationOptions {
  host: string; port: number; username: string; knownHostKey: string; root: string; url: string
  node: string; flock: string; credentials: SecretStore; credentialKey: `publication-${string}`
  /** A backend-scoped token that can only read this project's current accepted baseline. */
  authority: () => Promise<{ url: string; token: string }>
  access: 'public' | 'restricted'
}
interface PublicationCredentials { privateKey: string; accessHeaders?: Record<string, string> }
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

/** Explicit host key pinning, independent stored authorization, bounded remote flock. */
export class SshPublicationTarget implements PublicationTarget {
  constructor(private readonly runtime: PlatformRuntime, private readonly options: SshPublicationOptions) {
    if (!/^[A-Za-z0-9.-]+$/.test(options.host) || !/^[a-z_][a-z0-9_-]*$/i.test(options.username) || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535 || !/^(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+$/.test(options.knownHostKey)) throw new Error('发布 SSH 目标或固定主机公钥无效。')
    if (![options.root, options.node, options.flock].every(value => value.startsWith('/') && /^[-a-zA-Z0-9/_. ]+$/.test(value) && !value.split('/').includes('..')) || options.root === '/') throw new Error('发布远端路径必须是明确的 POSIX 绝对路径。')
    const url = new URL(options.url)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) throw new Error('项目站点 URL 无效。')
  }
  publish(operationId: string, artifact: PublicationArtifact, expected: PublicationBaseline): Promise<PublicationRecord> {
    if (artifact.baseline.baselineId !== expected.baselineId || artifact.baseline.commitSha !== expected.commitSha) throw new Error('发布固定基线不一致。')
    return this.execute({ action: 'publish', operationId, artifact })
  }
  query(operationId?: string): Promise<PublicationRecord> { return this.execute({ action: 'query', ...(operationId ? { operationId } : {}) }) }
  revoke(operationId: string, expectedArtifactSha256: string): Promise<PublicationRecord> { return this.execute({ action: 'revoke', operationId, expectedArtifactSha256 }) }
  private async execute(request: Record<string, unknown>): Promise<PublicationRecord> {
    if (request.operationId !== undefined && !/^[a-f0-9-]{36}$/.test(String(request.operationId))) throw new Error('发布操作标识无效。')
    const credentials = await this.options.credentials.read(this.options.credentialKey) as PublicationCredentials | undefined
    if (!credentials?.privateKey || !credentials.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) throw new Error('独立发布授权尚未配置。')
    if (this.options.access === 'restricted' && !Object.keys(credentials.accessHeaders ?? {}).length) throw new Error('受限站点缺少实际访问验证授权。')
    const authority = await this.options.authority()
    const authorityUrl = new URL(authority.url)
    if (!['http:', 'https:'].includes(authorityUrl.protocol) || authorityUrl.username || authorityUrl.password || !authority.token) throw new Error('基线读取授权无效。')
    const temporary = await mkdtemp(path.join(tmpdir(), 'eadp-publication-'))
    try {
      const key = path.join(temporary, 'identity')
      const known = path.join(temporary, 'known_hosts')
      await writeFile(key, credentials.privateKey, { mode: 0o600 })
      await writeFile(known, `[${this.options.host}]:${this.options.port} ${this.options.knownHostKey}\n${this.options.host} ${this.options.knownHostKey}\n`, { mode: 0o600 })
      const command = `${quote(this.options.flock)} -x -w 15 ${quote(path.posix.join(this.options.root, '.publish.lock'))} ${quote(this.options.node)} -e ${quote(REMOTE_PUBLICATION_RUNNER)}`
      const output = await this.runtime.run('ssh', ['-F', process.platform === 'win32' ? 'NUL' : '/dev/null', '-T', '-p', String(this.options.port), '-i', key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${known}`, '-o', 'GlobalKnownHostsFile=none', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=15', `${this.options.username}@${this.options.host}`, command], {
        cwd: temporary, timeoutMs: 600_000, input: JSON.stringify({ ...request, root: this.options.root, url: this.options.url, authorityUrl: authority.url, authorityToken: authority.token, access: this.options.access, accessHeaders: credentials.accessHeaders ?? {} }), maxOutputBytes: 64 * 1024,
      }).catch(() => undefined)
      if (!output) return { operationId: String(request.operationId ?? 'unknown'), phase: 'unknown', message: '远端操作结果未知，请先查询当前站点。' }
      const record = JSON.parse(output.stdout) as PublicationRecord
      if (!['shareable', 'revoked', 'failed', 'unknown'].includes(record.phase) || typeof record.operationId !== 'string') throw new Error('远端发布结果无效。')
      return record
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
}
