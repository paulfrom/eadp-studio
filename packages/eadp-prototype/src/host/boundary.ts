import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { checkPathNames } from '@eadp/contracts'

const HIDDEN = /^(?:node_modules|\.git|\.umi.*|dist|build|coverage|logs|cache|\.logs|\.eslintcache|\.stylelintcache|\.parcel-cache|\.DS_Store|\.cache|\.next|\.turbo|\.pnpm-store|\.env.*|\.npmrc|\.yarnrc.*)$|\.(?:pem|key|pfx|p12|log|tsbuildinfo)$/iu

/** Shared validation for the read-only browser and trusted local execution directory. */
export function prototypeParts(value: string, allowEmpty = false, trustedTemplate = false): string[] {
  const checked = checkPathNames(value, { maxPathLength: 2048, maxNameLength: 255, allowEmpty })
  if (!checked.ok) {
    const shape = checked.reason === 'invalid-path' || checked.reason === 'backslash'
    throw new FsError(shape ? '原型路径无效。' : '原型路径包含敏感或非法名称。', 'FS_SANDBOX_DENIED')
  }
  if (checked.names.some(name => HIDDEN.test(name) && !(trustedTemplate && (name === '.env.example' || name === '.npmrc')))) {
    throw new FsError('原型路径包含敏感或非法名称。', 'FS_SANDBOX_DENIED')
  }
  return checked.names
}

/** Every operation re-resolves the registered native Workspace and rejects all linked components. */
export class PrototypeBoundary {
  constructor(private readonly ctx: Context) {}
  async root(workspaceId: string): Promise<string> {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (!workspace) throw Object.assign(new Error('项目登记不存在。'), { code: 'PROJECT_NOT_FOUND' })
    const root = await realpath(workspace.path)
    if (root !== workspace.path || !(await lstat(root)).isDirectory()) throw new FsError('项目目录已变化，请重新打开。', 'FS_SANDBOX_DENIED')
    return root
  }
  async target(workspaceId: string, relativePath: string, trustedTemplate = false): Promise<FsTarget> {
    const root = await this.root(workspaceId)
    const names = ['原型', ...prototypeParts(relativePath, true, trustedTemplate)]
    let current = root
    for (const name of names) {
      current = path.join(current, name)
      const info = await lstat(current).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
      if (info?.isSymbolicLink()) throw new FsError('原型路径不允许符号链接。', 'FS_SANDBOX_DENIED')
    }
    const workspace = await this.ctx.fs.resolve(root)
    const prototype = await this.ctx.fs.resolve('原型', { cwd: root })
    const target = await this.ctx.fs.resolve(names.join('/'), { cwd: root })
    if (this.ctx.fs.processPath(prototype) !== path.join(root, '原型') || this.ctx.fs.processPath(target) !== path.join(root, ...names) || !this.ctx.fs.contains(workspace, prototype) || !this.ctx.fs.contains(prototype, target)) throw new FsError('原型路径超出项目。', 'FS_SANDBOX_DENIED')
    return target
  }
  async directory(workspaceId: string): Promise<string> {
    const target = await this.target(workspaceId, '')
    if ((await this.ctx.fs.stat(target))?.type !== 'directory') throw new FsError('请先创建原型工程。', 'FS_NOT_DIRECTORY')
    return this.ctx.fs.processPath(target)
  }
}
