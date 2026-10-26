import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HostPorts } from './ports.ts'

/** One automatic reconciliation with the project's accepted remote head. */
export interface RemoteMergeReport {
  head: string; commits: Array<{ sha: string; title: string }>; files: string[]; aiFiles: string[]
}
export interface RemoteMergeRequest {
  worktree: string; target: string;
  /** The author identity already bound to this project and confirmation. */
  identity: { name: string; email: string };
}
/** The accepted commit is not local yet; the caller schedules the Git fetch on the background lane. */
export class RemoteSyncPending extends Error {
  constructor(readonly target: string) { super('项目仓库正在后台取回远端已接受版本，请稍候') }
}

const decode = (bytes: Buffer | undefined): string | undefined => bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : undefined
/** User-facing account of what a merge changed, used by every confirmation surface. */
export function describeMerge(report: RemoteMergeReport): string {
  const scope = `已自动合并远端 ${report.commits.length} 个提交（${report.files.length} 个文件）`
  return report.aiFiles.length ? `${scope}，其中 ${report.aiFiles.length} 个冲突文件由 AI 合并` : scope
}

/**
 * Reconcile a task worktree with the backend-accepted head before a candidate
 * is fixed: keep every local byte, fast-forward to the accepted history, replay
 * the local changes and let AI merge every text conflict, including material
 * and evidence. Invalid history and unreadable or non-text content still stop.
 */
export class RemoteMerges {
  constructor(private readonly ports: Pick<HostPorts, 'git' | 'mergeConflict'>) {}

  async align(request: RemoteMergeRequest): Promise<RemoteMergeReport | undefined> {
    const { worktree, target } = request
    const head = (await this.ports.git.state(worktree)).head
    if (!head) throw new Error('本机编辑现场缺少 Git 提交，请重新打开材料')
    if (head === target) return undefined
    if (!await this.ports.git.hasCommit(worktree, target)) throw new RemoteSyncPending(target)
    // The worktree may still carry a candidate commit from a rejected or
    // superseded attempt; move the branch back without touching its bytes.
    if (await this.ports.git.isAncestor(worktree, target, head)) {
      await this.ports.git.moveHead(worktree, target)
      // The old candidate tree is still in the index; the next fixed commit
      // must see exactly the material's working-tree bytes.
      await this.ports.git.unstage(worktree)
      return undefined
    }
    if (!await this.ports.git.isAncestor(worktree, head, target)) throw new Error('本地编辑已有独立提交，无法自动合并远端已接受版本，请先完成或恢复原确认')
    const report: RemoteMergeReport = {
      head: target, commits: await this.ports.git.commits(worktree, head, target),
      files: await this.ports.git.changedFiles(worktree, head, target), aiFiles: [],
    }
    const preserved = await this.ports.git.commitAll(worktree, '同步远端已接受版本前的本地材料', request.identity)
    try {
      await this.ports.git.fastForward(worktree, target)
      if (preserved !== head) {
        const conflicts = await this.ports.git.applyCommit(worktree, preserved)
        for (const file of conflicts) {
          const stages = await this.ports.git.conflictStages(worktree, file)
          const base = decode(stages.base), ours = decode(stages.ours), theirs = decode(stages.theirs)
          if (base === undefined && ours === undefined && theirs === undefined) throw new Error(`无法读取冲突文件内容：${file}`)
          if (!this.ports.mergeConflict) throw new Error(`远端合并出现冲突：${file}，AI 合并能力当前不可用`)
          const merged = await this.ports.mergeConflict({ path: file, ...(base !== undefined ? { base } : {}), ...(ours !== undefined ? { ours } : {}), ...(theirs !== undefined ? { theirs } : {}) }, AbortSignal.timeout(180_000))
          const absolute = path.join(worktree, file)
          if (merged.delete) await rm(absolute, { force: true })
          else {
            if (merged.content === undefined) throw new Error(`AI 未返回合并内容：${file}`)
            await writeFile(absolute, merged.content, 'utf8')
          }
          await this.ports.git.resolvePath(worktree, file)
          report.aiFiles.push(file)
        }
        await this.ports.git.quitApply(worktree)
        await this.ports.git.unstage(worktree)
      }
      return report
    } catch (error) {
      await this.ports.git.abortApply(worktree).catch(() => undefined)
      await this.ports.git.restore(worktree, preserved).catch(() => undefined)
      await this.ports.git.moveHead(worktree, head).catch(() => undefined)
      await this.ports.git.unstage(worktree).catch(() => undefined)
      throw error
    }
  }
}
