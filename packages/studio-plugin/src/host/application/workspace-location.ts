import path from 'node:path'
import { homedir } from 'node:os'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AtomicState } from '../adapters/local-state/atomic-state.ts'

const contains = (parent: string, child: string): boolean => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

/** User-selected project folders are independent of application state and installed tools. */
export class WorkspaceLocation {
  private readonly settings: AtomicState<{ defaultDirectory: string }>
  constructor(readonly applicationDirectory: string, private readonly protectedDirectories: string[], private readonly initialDirectory = path.join(homedir(), 'EADP')) {
    this.settings = new AtomicState(path.join(applicationDirectory, 'workspace-location.json'))
  }
  async view(): Promise<{ defaultDirectory: string; applicationDirectory: string }> {
    const value = await this.settings.read()
    if (value && (typeof value.defaultDirectory !== 'string' || !path.isAbsolute(value.defaultDirectory))) throw new Error('默认项目位置记录无效，请检查本机设置。')
    return { defaultDirectory: value?.defaultDirectory ?? this.initialDirectory, applicationDirectory: this.applicationDirectory }
  }
  /** Resolve existing ancestors so junctions cannot place project files in program data. */
  async validate(directory: string): Promise<string> {
    if (!directory || !path.isAbsolute(directory) || directory.includes('\0')) throw new Error('请选择有效的项目文件夹绝对路径。')
    const resolved = path.resolve(directory)
    let ancestor = resolved
    const suffix: string[] = []
    for (;;) {
      try {
        const canonical = await realpath(ancestor)
        const target = path.join(canonical, ...suffix)
        for (const protectedDirectory of this.protectedDirectories) {
          const protectedRoot = await realpath(protectedDirectory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(protectedDirectory); throw error })
          if (contains(protectedRoot, target) || contains(target, protectedRoot)) throw new Error('项目文件夹须与程序、设置和工具目录分开，请选择其他位置。')
        }
        return target
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const parent = path.dirname(ancestor)
        if (parent === ancestor) throw error
        suffix.unshift(path.basename(ancestor)); ancestor = parent
      }
    }
  }
  async set(directory: string): Promise<void> {
    const target = await this.validate(directory)
    await mkdir(target, { recursive: true })
    if (!(await lstat(target)).isDirectory()) throw new Error('请选择文件夹。')
    const probe = path.join(target, `.eadp-write-${randomUUID()}`)
    const file = await open(probe, 'wx', 0o600)
    try { await file.close() } finally { await rm(probe, { force: true }) }
    await this.settings.write({ defaultDirectory: target })
  }
  async project(projectId: string, repositoryPath: string, selected?: string): Promise<string> {
    const slug = repositoryPath.split('/').at(-1)!.replace(/\.git$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'project'
    return this.validate(selected ?? path.join((await this.view()).defaultDirectory, `${slug}-${projectId.slice(0, 8)}`))
  }
}
