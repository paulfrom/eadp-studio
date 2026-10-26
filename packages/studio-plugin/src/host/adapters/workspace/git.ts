import { mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { PlatformRuntime, ProcessResult, RunOptions } from '../platform/runtime.js'

export interface GitIdentity { name: string; email: string }
export type GitMergeResult = { status: 'merged'; commit: string } | { status: 'conflicted'; files: string[] }
export interface GitState { root: string; head: string; branch: string; dirty: boolean; repositoryUrl: string }
export type GitProgressStage = 'enumerating' | 'counting' | 'compressing' | 'writing' | 'receiving' | 'resolving' | 'checking' | 'updating'
/** One progress print Git made during a transfer; `percent` is that stage's own count. */
export interface GitProgress { stage: GitProgressStage; percent: number }
const PROGRESS = /(?:^|[\r\n])(?:remote:\s*)?(Enumerating objects|Counting objects|Compressing objects|Writing objects|Receiving objects|Resolving deltas|Checking out files|Updating files):\s+(\d{1,3})%/g
const progressStages: Record<string, GitProgressStage> = { 'Enumerating objects': 'enumerating', 'Counting objects': 'counting', 'Compressing objects': 'compressing', 'Writing objects': 'writing', 'Receiving objects': 'receiving', 'Resolving deltas': 'resolving', 'Checking out files': 'checking', 'Updating files': 'updating' }
/** Longest tail of the progress stream kept to repair one line split across chunks. */
const PROGRESS_TAIL = 4096
/**
 * Read the progress lines Git writes to stderr. Git separates them with carriage
 * returns and may split one line across chunks, so only the part that already
 * ended is read and the rest is kept for the next chunk.
 */
export class GitProgressReader {
  /** The unfinished line so far: its percentage may still be split across chunks. */
  private pending = ''
  /**
   * Consume one stderr chunk.
   * @param text - decoded chunk.
   * @returns the newest completed stage and percentage in this chunk, or undefined while none is complete.
   */
  push(text: string): GitProgress | undefined {
    const complete = this.pending + text
    const end = Math.max(complete.lastIndexOf('\r'), complete.lastIndexOf('\n'))
    this.pending = complete.slice(end + 1).slice(-PROGRESS_TAIL)
    let found: GitProgress | undefined
    for (const match of complete.slice(0, end + 1).matchAll(PROGRESS)) found = { stage: progressStages[match[1]!]!, percent: Number(match[2]) }
    return found
  }
}
/** A clone or a push streams progress for as long as the transfer takes; a reply budget would cut it short. */
const TRANSFER_TIMEOUT_MS = 1_800_000
const SHA = /^[a-f0-9]{40}$/
const branchName = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') || value.endsWith('/') || value.endsWith('.lock') || value.includes('//')) throw new Error('Git 分支名无效。'); return value }
const fixedSha = (value: string) => { if (!SHA.test(value)) throw new Error('必须指定完整固定 Git SHA。'); return value }
const validateIdentity = (identity: GitIdentity): void => {
  if (!identity.name.trim() || !identity.email.includes('@') || /[\r\n\0]/.test(identity.name + identity.email)) throw new Error('Git 提交身份无效。')
}
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
  /**
   * Clone a project repository.
   * @param onProgress - receives Git's own transfer progress so the surfaces can show the bar.
   */
  async clone(repositoryUrl: string, destination: string, signal?: AbortSignal, onProgress?: (progress: GitProgress) => void): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    const args = ['clone', '--progress', '--no-local', '--', repositoryAddress(repositoryUrl), destination]
    if (onProgress) await this.streamed(path.dirname(destination), args, true, signal, repositoryUrl, onProgress)
    else await this.command(path.dirname(destination), args, true, signal, repositoryUrl)
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
  async checkoutBranch(root: string, branch: string, baseSha: string): Promise<void> {
    await this.command(root, ['checkout', '-b', branchName(branch), fixedSha(baseSha)])
  }
  async switchBranch(root: string, branch: string, commit: string): Promise<void> {
    await this.command(root, ['checkout', '-B', branchName(branch), fixedSha(commit)])
  }
  async removeWorktree(root: string, destination: string, force = false): Promise<void> { await this.command(root, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', destination]) }
  /** Fast-forward only: a diverged checkout or one with conflicting local bytes stays exactly as it was. */
  async fastForward(root: string, commit: string): Promise<void> { await this.command(root, ['merge', '--ff-only', '--no-edit', fixedSha(commit)]) }
  /** Three-way merge of one fetched commit; conflicted paths keep the merge state for AI resolution. */
  async merge(root: string, commit: string, identity: GitIdentity): Promise<GitMergeResult> {
    fixedSha(commit)
    validateIdentity(identity)
    await this.guardLocal(root)
    const result = await this.result(root, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'merge', '--no-ff', '--no-edit', fixedSha(commit)])
    if (result.exitCode === 0) return { status: 'merged', commit: fixedSha((await this.command(root, ['rev-parse', 'HEAD'])).stdout.trim()) }
    const files = (await this.command(root, ['diff', '--name-only', '-z', '--diff-filter=U'])).stdout.split('\0').filter(Boolean).map(gitRelativePath)
    if (!files.length) throw new Error(`git 合并失败（退出码 ${result.exitCode}），现场已保留。`)
    return { status: 'conflicted', files }
  }
  /** Finish a conflicted merge after the conflict files hold their resolved bytes. */
  async completeMerge(root: string, files: readonly string[], identity: GitIdentity): Promise<string> {
    validateIdentity(identity)
    if (!files.length) throw new Error('没有待完成的合并冲突文件。')
    await this.command(root, ['add', '--', ...files.map(gitRelativePath)])
    await this.command(root, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '--no-edit'])
    return fixedSha((await this.command(root, ['rev-parse', 'HEAD'])).stdout.trim())
  }
  /** Keep a cleaned worktree's commit reachable after its temporary branch is deleted. */
  async keepRef(root: string, ref: string, commit: string): Promise<void> {
    if (!/^refs\/eadp\/archive\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) throw new Error('归档引用无效。')
    await this.command(root, ['update-ref', ref, fixedSha(commit)])
  }
  /** Delete a temporary branch only while it still points at the commit the cleanup recorded. */
  async deleteBranch(root: string, branch: string, commit: string): Promise<void> {
    const name = branchName(branch), sha = fixedSha(commit)
    const existing = (await this.result(root, ['rev-parse', '--verify', `refs/heads/${name}`])).stdout.trim()
    if (!existing) return
    if (existing !== sha) throw new Error('临时分支已指向其他提交，保留现场')
    await this.command(root, ['branch', '-D', name])
  }
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
  /** Reads a fixed blob when the commit contains that regular file; an absent path stays distinguishable. */
  async readOptionalBlob(root: string, commit: string, relativePath: string): Promise<Buffer | undefined> {
    const file = gitRelativePath(relativePath), sha = fixedSha(commit)
    const entry = (await this.command(root, ['ls-tree', '-z', sha, '--', file])).stdout
    if (!entry) return undefined
    return this.readBlob(root, commit, relativePath)
  }
  async fetchCommit(root: string, commit: string): Promise<void> { await this.command(root, ['fetch', '--no-tags', 'origin', fixedSha(commit)], true) }
  /** Whether the commit object already exists locally, so a read can avoid the network. */
  async hasCommit(root: string, commit: string): Promise<boolean> {
    const result = await this.result(root, ['cat-file', '-e', `${fixedSha(commit)}^{commit}`])
    if (result.exitCode === 0) return true
    if (result.exitCode === 1 || result.exitCode === 128) return false
    throw new Error('无法核对本地 Git 提交。')
  }
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
  async changedPathStatuses(root: string, baseSha: string, candidateSha: string): Promise<Array<{ path: string; status: string }>> {
    const result = await this.command(root, ['diff', '--name-status', '-z', '--no-renames', fixedSha(baseSha), fixedSha(candidateSha), '--'])
    const entries = result.stdout.split('\0')
    if (entries.pop() !== '' || entries.length % 2) throw new Error('Git 已提交路径状态结果无效。')
    const paths: Array<{ path: string; status: string }> = []
    for (let index = 0; index < entries.length; index += 2) {
      const status = entries[index]!, path = gitRelativePath(entries[index + 1]!)
      paths.push({ path, status: status === 'A' || status === 'D' ? status : 'M' })
    }
    return paths
  }
  async commitFiles(root: string, files: readonly string[], message: string, identity: GitIdentity): Promise<string> {
    if (!files.length || !message.trim() || message.length > 500) throw new Error('Git 提交信息无效。')
    validateIdentity(identity)
    const paths = files.map(gitRelativePath)
    const staged = await this.command(root, ['diff', '--cached', '--name-only', '-z'])
    if (staged.stdout) throw new Error('存在其他暂存改动，请先处理后再固定材料。')
    await this.command(root, ['add', '--', ...paths])
    await this.command(root, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '--only', '-m', message, '--', ...paths])
    return fixedSha((await this.command(root, ['rev-parse', 'HEAD'])).stdout.trim())
  }
  /**
   * Push one fixed commit to the stable branch.
   * @param onProgress - receives Git's own transfer progress so the surfaces can show the bar.
   */
  async push(root: string, commit: string, branch: string, onProgress?: (progress: GitProgress) => void): Promise<void> {
    const args = ['push', '--progress', '--porcelain', 'origin', `${fixedSha(commit)}:refs/heads/${branchName(branch)}`]
    if (onProgress) await this.streamed(root, args, true, undefined, undefined, onProgress)
    else await this.command(root, args, true)
  }
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
    const argv = await this.prepared(cwd, args, network, explicitUrl)
    return this.runtime.run('git', argv, this.options(cwd, signal))
  }
  /**
   * Run one transfer while forwarding the progress Git prints. The command keeps
   * its own long budget: a slow clone reports progress instead of being cut short.
   */
  private async streamed(cwd: string, args: readonly string[], network: boolean, signal: AbortSignal | undefined, explicitUrl: string | undefined, onProgress: (progress: GitProgress) => void): Promise<ProcessResult> {
    const argv = await this.prepared(cwd, args, network, explicitUrl)
    const process = await this.runtime.start('git', argv, this.options(cwd, signal, TRANSFER_TIMEOUT_MS))
    const reader = new GitProgressReader()
    const stop = process.onOutput((channel, text) => {
      if (channel !== 'stderr') return
      const progress = reader.push(text)
      if (progress) onProgress(progress)
    })
    try {
      const result = await process.done
      if (result.exitCode !== 0) throw new Error(`git 执行失败（退出码 ${result.exitCode}）。`)
      return result
    } finally { stop() }
  }
  /**
   * Verify the repository and address a network command may touch, then return
   * the guarded argv. Both the single-shot and the streaming path run the same
   * checks, so neither can reach an unregistered remote or a rewritten address.
   */
  private async prepared(cwd: string, args: readonly string[], network: boolean, explicitUrl: string | undefined): Promise<string[]> {
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
    return this.safe(args)
  }
  private async checkAddress(value: string): Promise<void> {
    const address = new URL(repositoryAddress(value))
    if (!this.trustedOrigin || address.origin !== await this.trustedOrigin()) throw new Error('仓库地址与后台指定的 GitLab 实例不一致。')
  }
  private safe(args: readonly string[]): string[] { return ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', ...args] }
  private options(cwd: string, signal?: AbortSignal, timeoutMs = 120_000): RunOptions { return { cwd, gitUserCredentials: true, timeoutMs, ...(signal ? { signal } : {}) } }
  private async result(cwd: string, args: readonly string[]): Promise<ProcessResult> { return (await this.runtime.start('git', this.safe(args), this.options(cwd))).done }
  private async guardLocal(cwd: string): Promise<void> {
    // Reading config does not execute helpers or hooks. Never include repository-specified files.
    const repository = await this.result(cwd, ['rev-parse', '--git-dir'])
    if (repository.exitCode === 128) return
    if (repository.exitCode !== 0) throw new Error('无法核对 Git 仓库配置。')
    // --show-scope reports only effective worktree configuration. Explicit
    // --worktree fails in ordinary multi-worktree repos without worktreeConfig.
    const config = await this.result(cwd, ['config', '--show-scope', '--no-includes', '--null', '--list'])
    if (config.exitCode !== 0) throw new Error('无法核对项目 Git 配置。')
    const entries = config.stdout.split('\0')
    if (entries.pop() !== '' || entries.length % 2) throw new Error('项目 Git 配置结果无效。')
    for (let index = 0; index < entries.length; index += 2) {
      const scope = entries[index]!, item = entries[index + 1]!
      if (!['system', 'global', 'local', 'worktree', 'command'].includes(scope)) throw new Error('项目 Git 配置范围无效。')
      if (scope !== 'local' && scope !== 'worktree') continue
      const key = item.split('\n', 1)[0]!.toLowerCase()
      if (/^(?:credential\.|url\.|include\.|includeif\.|filter\.|protocol\.|http\.|https\.)/.test(key) || /^core\.(?:hookspath|askpass|sshcommand|gitproxy)$/.test(key) || /^remote\..*\.(?:uploadpack|receivepack|proxy)$/.test(key)) throw new Error('项目 Git 配置含不允许的凭据命令、钩子、过滤器或地址重写，请保留现场并处理。')
    }
  }
}
