import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PlatformRuntime, ProcessResult } from '../platform/runtime.js'

export interface GitIdentity { name: string; email: string }
export interface GitState { root: string; head: string; branch: string; dirty: boolean; repositoryUrl: string }
export type GitToken = () => Promise<string>
const SHA = /^[a-f0-9]{40}$/
const branchName = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') || value.endsWith('/') || value.endsWith('.lock') || value.includes('//')) throw new Error('Git 分支名无效。'); return value }
const fixedSha = (value: string) => { if (!SHA.test(value)) throw new Error('必须指定完整固定 Git SHA。'); return value }
export function gitRelativePath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/') || value.split('/').some(part => !part || part === '..' || part === '.' || part.toLowerCase() === '.git')) throw new Error('Git 文件相对路径无效。')
  return value
}
export function repositoryAddress(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.git')) throw new Error('请提供不含凭据的单一 GitLab .git 地址。')
  return url.href
}
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

/** Fixed binary and argv only. No public arbitrary git command, shell, or credential in argv. */
export class WorkspaceGit {
  constructor(private readonly runtime: PlatformRuntime, private readonly getToken?: GitToken, private readonly gitlabOrigin?: string) {}
  async clone(repositoryUrl: string, destination: string, signal?: AbortSignal): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    await this.command(path.dirname(destination), ['clone', '--no-local', '--', repositoryAddress(repositoryUrl), destination], true, signal)
  }
  async init(root: string, repositoryUrl: string, branch = 'main'): Promise<void> {
    await mkdir(root, { recursive: true })
    await this.command(root, ['init', '--initial-branch', branchName(branch)])
    await this.command(root, ['remote', 'add', 'origin', repositoryAddress(repositoryUrl)])
  }
  async state(root: string): Promise<GitState> {
    const canonical = await realpath(root)
    const [top, head, branch, status, remote] = await Promise.all([
      this.command(root, ['rev-parse', '--show-toplevel']), this.command(root, ['rev-parse', '--verify', 'HEAD']),
      this.command(root, ['symbolic-ref', '--short', 'HEAD']), this.command(root, ['status', '--porcelain=v1']), this.command(root, ['remote', '-v']),
    ])
    if (await realpath(top.stdout.trim()) !== canonical) throw new Error('请选择项目仓库根目录。')
    const remotes = remote.stdout.trim().split('\n').filter(Boolean).map(line => /^origin\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line)?.[1])
    const urls = new Set(remotes)
    if (remotes.length !== 2 || urls.size !== 1 || urls.has(undefined)) throw new Error('一个项目只能关联一个 origin 仓库地址。')
    return { root: canonical, head: fixedSha(head.stdout.trim()), branch: branchName(branch.stdout.trim()), dirty: !!status.stdout, repositoryUrl: repositoryAddress(remotes[0]!) }
  }
  async createWorktree(root: string, destination: string, branch: string, baseSha: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    await this.command(root, ['worktree', 'add', '-b', branchName(branch), destination, fixedSha(baseSha)])
  }
  async removeWorktree(root: string, destination: string): Promise<void> { await this.command(root, ['worktree', 'remove', '--', destination]) }
  async fetch(root: string, branch: string): Promise<void> { await this.command(root, ['fetch', '--no-tags', 'origin', branchName(branch)], true) }
  async remoteHead(root: string, branch: string): Promise<string> {
    const result = await this.command(root, ['ls-remote', '--exit-code', 'origin', `refs/heads/${branchName(branch)}`], true)
    return fixedSha(result.stdout.trim().split(/\s+/)[0] ?? '')
  }
  async readBlob(root: string, commit: string, relativePath: string): Promise<Buffer> {
    const result = await this.command(root, ['show', `${fixedSha(commit)}:${gitRelativePath(relativePath)}`])
    return result.stdoutBytes
  }
  async listFiles(root: string, commit: string): Promise<string[]> { return (await this.command(root, ['ls-tree', '-r', '--name-only', '-z', fixedSha(commit)])).stdout.split('\0').filter(Boolean) }
  async commitFiles(root: string, files: readonly string[], message: string, identity: GitIdentity): Promise<string> {
    if (!files.length || !message.trim() || message.length > 500 || !identity.name.trim() || !identity.email.includes('@') || /[\r\n\0]/.test(identity.name + identity.email)) throw new Error('Git 提交信息无效。')
    const paths = files.map(gitRelativePath)
    const staged = await this.command(root, ['diff', '--cached', '--name-only', '-z'])
    if (staged.stdout) throw new Error('存在其他暂存改动，请先处理后再固定材料。')
    await this.command(root, ['add', '--', ...paths])
    await this.command(root, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '--only', '-m', message, '--', ...paths])
    return fixedSha((await this.command(root, ['rev-parse', 'HEAD'])).stdout.trim())
  }
  async push(root: string, commit: string, branch: string): Promise<void> { await this.command(root, ['push', '--porcelain', 'origin', `${fixedSha(commit)}:refs/heads/${branchName(branch)}`], true) }
  async conditionalUpdate(root: string, branch: string, expectedSha: string, candidateSha: string): Promise<void> {
    const ref = `refs/heads/${branchName(branch)}`
    fixedSha(expectedSha); fixedSha(candidateSha)
    // This lease is the cross-machine compare-and-swap; no local lock can replace it.
    await this.command(root, ['push', '--porcelain', `--force-with-lease=${ref}:${expectedSha}`, 'origin', `${candidateSha}:${ref}`], true)
  }
  async verifyFile(root: string, commit: string, relativePath: string): Promise<void> {
    const expected = await readFile(path.join(root, gitRelativePath(relativePath)))
    if (!expected.equals(await this.readBlob(root, commit, relativePath))) throw new Error('固定 Git 材料字节与当前确认快照不一致。')
  }
  private command(cwd: string, args: readonly string[], authenticated = false, signal?: AbortSignal): Promise<ProcessResult> {
    // Disable repo hooks, local executable filters, transport helpers and any saved credential helper.
    const safe = ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'credential.helper=', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', ...args]
    if (!authenticated || !this.getToken) return this.runtime.run('git', safe, { cwd, ...(signal ? { signal } : {}) })
    return this.authenticated(cwd, safe, signal)
  }
  private async authenticated(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<ProcessResult> {
    if (!this.gitlabOrigin) throw new Error('受控 Git 必须绑定已授权 GitLab 实例。')
    const cloneIndex = args.indexOf('clone')
    const url = cloneIndex >= 0
      ? args[args.indexOf('--', cloneIndex) + 1]
      : (await this.command(cwd, ['remote', 'get-url', '--all', 'origin'])).stdout.trim()
    if (!url || url.includes('\n') || new URL(repositoryAddress(url)).origin !== new URL(this.gitlabOrigin).origin) throw new Error('仓库地址不匹配已授权的 GitLab 实例。')
    // url rewriting can redirect credentials even while origin's string looks correct.
    if (cloneIndex < 0) {
      const pushUrl = (await this.command(cwd, ['remote', 'get-url', '--push', '--all', 'origin'])).stdout.trim()
      if (pushUrl !== url) throw new Error('一个项目只能使用同一仓库地址读取和推送。')
      const rewrites = await this.runtime.start('git', ['config', '--local', '--get-regexp', '^url\\.'], { cwd, ...(signal ? { signal } : {}), timeoutMs: 10_000 })
      const rewriteResult = await rewrites.done
      if (rewriteResult.stdout || ![0, 1].includes(rewriteResult.exitCode)) throw new Error('项目 Git 配置包含不允许的地址重写。')
    }
    const token = await this.getToken!()
    const nonce = randomBytes(32).toString('hex')
    const sockets = new Set<Socket>()
    const server = createServer(socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      let input = ''
      socket.setTimeout(5000, () => socket.destroy())
      socket.on('data', chunk => {
        input += String(chunk)
        if (input.length > 2048) { socket.destroy(); return }
        if (!input.includes('\n')) return
        const [secret, kind] = input.trim().split(' ')
        if (secret !== nonce || (kind !== 'username' && kind !== 'password')) { socket.destroy(); return }
        socket.end(`${kind === 'username' ? 'oauth2' : token}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Git 凭据通道无法建立。')
    const temporary = await mkdtemp(path.join(tmpdir(), 'eadp-git-auth-'))
    const helper = path.join(temporary, 'askpass.cjs')
    try {
      await writeFile(helper, "const net=require('node:net');const socket=net.connect(Number(process.env.STUDIO_GIT_AUTH_SOCKET),'127.0.0.1',()=>socket.write(process.env.STUDIO_GIT_AUTH_NONCE+' '+(/username/i.test(process.argv[2]||'')?'username':'password')+'\\n'));socket.on('data',b=>process.stdout.write(b));socket.setTimeout(5000,()=>{socket.destroy();process.exitCode=1});socket.on('error',()=>{process.exitCode=1});", { mode: 0o600 })
      return await this.runtime.run('git', args, { cwd, ...(signal ? { signal } : {}), env: { GIT_ASKPASS: `${shellQuote(this.runtime.executable('node').replace(/\\/g, '/'))} ${shellQuote(helper.replace(/\\/g, '/'))}`, STUDIO_GIT_AUTH_SOCKET: String(address.port), STUDIO_GIT_AUTH_NONCE: nonce } })
    } finally { server.close(); for (const socket of sockets) socket.destroy(); await rm(temporary, { recursive: true, force: true }) }
  }
}
