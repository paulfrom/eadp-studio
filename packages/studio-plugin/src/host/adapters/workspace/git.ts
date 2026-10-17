import { mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { PlatformRuntime, ProcessResult, RunOptions } from '../platform/runtime.js'

export interface GitIdentity { name: string; email: string }
export interface GitState { root: string; head: string; branch: string; dirty: boolean; repositoryUrl: string }
const SHA = /^[a-f0-9]{40}$/
const branchName = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') || value.endsWith('/') || value.endsWith('.lock') || value.includes('//')) throw new Error('Git 分支名无效。'); return value }
const fixedSha = (value: string) => { if (!SHA.test(value)) throw new Error('必须指定完整固定 Git SHA。'); return value }
export function gitRelativePath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/') || value.split('/').some(part => !part || part === '..' || part === '.' || part.toLowerCase() === '.git')) throw new Error('Git 文件相对路径无效。')
  return value
}
export function repositoryAddress(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.git') || value !== url.href || url.pathname.split('/').some((part, i) => i > 0 && (!part || part === '.' || part === '..'))) throw new Error('请提供不含凭据的单一 GitLab .git 地址。')
  return url.href
}
/** Fixed binary and argv only. No public arbitrary git command, shell, or credential in argv. */
export class WorkspaceGit {
  constructor(private readonly runtime: PlatformRuntime, private readonly trustedOrigin?: () => Promise<string>) {}
  async clone(repositoryUrl: string, destination: string, signal?: AbortSignal): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    await this.command(path.dirname(destination), ['clone', '--no-local', '--', repositoryAddress(repositoryUrl), destination], true, signal, repositoryUrl)
  }
  async init(root: string, repositoryUrl: string, branch = 'main'): Promise<void> {
    await mkdir(root, { recursive: true })
    await this.checkAddress(repositoryUrl)
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
    const file = gitRelativePath(relativePath), sha = fixedSha(commit)
    const entry = (await this.command(root, ['ls-tree', '-z', sha, '--', file])).stdout
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entry)
    if (!match || match[3] !== file) throw new Error('固定材料必须是普通文件，不能是符号链接或子模块。')
    const size = Number((await this.command(root, ['cat-file', '-s', match[2]!])).stdout.trim())
    if (!Number.isSafeInteger(size) || size < 0 || size > 1_048_576) throw new Error('固定材料超过大小限制。')
    const result = await this.command(root, ['cat-file', 'blob', match[2]!])
    if (result.stdoutBytes.length !== size) throw new Error('固定材料字节数不一致。')
    return result.stdoutBytes
  }
  async fetchCommit(root: string, commit: string): Promise<void> { await this.command(root, ['fetch', '--no-tags', 'origin', fixedSha(commit)], true) }
  async probeRemoteHead(repositoryUrl: string, branch: string, cwd: string): Promise<string | undefined> {
    const result = await this.command(cwd, ['ls-remote', '--heads', '--refs', '--', repositoryAddress(repositoryUrl), `refs/heads/${branchName(branch)}`], true, undefined, repositoryUrl)
    if (!result.stdout.trim()) return undefined
    const lines = result.stdout.trim().split('\n')
    if (lines.length !== 1 || lines[0]!.split(/\s+/)[1] !== `refs/heads/${branch}`) throw new Error('远程分支结果无法核对。')
    return fixedSha(lines[0]!.split(/\s+/)[0]!)
  }
  async head(root: string): Promise<string | undefined> {
    await this.guardLocal(root)
    const result = await this.result(root, ['rev-parse', '--verify', 'HEAD'])
    if (result.exitCode === 128 || result.exitCode === 1) return undefined
    if (result.exitCode !== 0) throw new Error('无法核对本地 Git 提交。')
    return fixedSha(result.stdout.trim())
  }
  async identity(root: string): Promise<GitIdentity> {
    const [name, email] = await Promise.all([this.command(root, ['config', '--global', '--get', 'user.name']), this.command(root, ['config', '--global', '--get', 'user.email'])])
    const result = { name: name.stdout.trim(), email: email.stdout.trim() }
    if (!result.name || !result.email.includes('@') || /[\r\n\0]/.test(result.name + result.email)) throw new Error('请先配置当前机器可信的 Git user.name 和 user.email。')
    return result
  }
  async local(root: string, args: readonly string[]): Promise<string> {
    if (!['ls-files', 'status', 'symbolic-ref', 'for-each-ref', 'rev-list'].includes(args[0] ?? '') || args.some(value => value.includes('\0'))) throw new Error('本地 Git 操作不受支持。')
    return (await this.command(root, args)).stdout
  }
  async listFiles(root: string, commit: string): Promise<string[]> { return (await this.command(root, ['ls-tree', '-r', '--name-only', '-z', fixedSha(commit)])).stdout.split('\0').filter(Boolean) }
  async changedFiles(root: string, baseSha: string, candidateSha: string): Promise<string[]> {
    const result = await this.command(root, ['diff', '--name-only', '-z', '--no-renames', fixedSha(baseSha), fixedSha(candidateSha), '--'])
    return result.stdout.split('\0').filter(Boolean).map(gitRelativePath)
  }
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
  private async command(cwd: string, args: readonly string[], network = false, signal?: AbortSignal, explicitUrl?: string): Promise<ProcessResult> {
    await this.guardLocal(cwd)
    if (network) {
      const url = explicitUrl ?? (await this.result(cwd, ['config', '--local', '--get', 'remote.origin.url'])).stdout.trim()
      await this.checkAddress(url)
      if (!explicitUrl) {
        if ((await this.result(cwd, ['remote'])).stdout.trim() !== 'origin') throw new Error('一个项目只能配置单一 origin 远程。')
        for (const flags of [[], ['--push']]) {
          const effective = await this.result(cwd, ['remote', 'get-url', ...flags, '--all', 'origin'])
          if (effective.exitCode !== 0 || effective.stdout.trim() !== url) throw new Error('仓库地址重写、多地址或独立 push URL 不允许。')
        }
      } else {
        const effective = await this.result(cwd, ['ls-remote', '--get-url', '--', url])
        if (effective.exitCode !== 0 || effective.stdout.trim() !== url) throw new Error('机器 Git 地址重写不能替代后台登记的仓库地址。')
      }
    }
    return this.runtime.run('git', this.safe(args), this.options(cwd, signal))
  }
  private async checkAddress(value: string): Promise<void> {
    const address = new URL(repositoryAddress(value))
    if (!this.trustedOrigin || address.origin !== await this.trustedOrigin()) throw new Error('仓库地址与后台指定的 GitLab 实例不一致。')
  }
  private safe(args: readonly string[]): string[] { return ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', ...args] }
  private options(cwd: string, signal?: AbortSignal): RunOptions { return { cwd, gitUserCredentials: true, timeoutMs: 120_000, ...(signal ? { signal } : {}) } }
  private async result(cwd: string, args: readonly string[]): Promise<ProcessResult> { return (await this.runtime.start('git', this.safe(args), this.options(cwd))).done }
  private async guardLocal(cwd: string): Promise<void> {
    // Reading config does not execute helpers or hooks. Never include repository-specified files.
    const repository = await this.result(cwd, ['rev-parse', '--git-dir'])
    if (repository.exitCode === 128) return
    if (repository.exitCode !== 0) throw new Error('无法核对 Git 仓库配置。')
    for (const scope of ['--local', '--worktree']) {
      const config = await this.result(cwd, ['config', scope, '--no-includes', '--null', '--list'])
      if (config.exitCode !== 0) throw new Error('无法核对项目 Git 配置。')
      for (const item of config.stdout.split('\0').filter(Boolean)) {
        const key = item.split('\n', 1)[0]!.toLowerCase()
        if (/^(?:credential\.|url\.|include\.|includeif\.|filter\.|protocol\.|http\.|https\.)/.test(key) || /^core\.(?:hookspath|askpass|sshcommand|gitproxy)$/.test(key) || /^remote\..*\.(?:uploadpack|receivepack|proxy)$/.test(key)) throw new Error('项目 Git 配置含不允许的凭据命令、钩子、过滤器或地址重写，请保留现场并处理。')
      }
    }
  }
}
