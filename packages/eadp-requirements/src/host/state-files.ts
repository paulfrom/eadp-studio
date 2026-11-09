import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { RequirementFiles } from './files.ts'
import { RequirementKnowledgeError } from './knowledge-error.ts'

/** 项目内由需求插件维护的状态目录只有这些安全段名。 */
const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/

/**
 * 解析项目根下的状态目录，例如 `.eadp/proposals`；不跟随任何链接。
 * @param files - 已绑定项目根的本地文件边界。
 * @param projectId - 当前项目。
 * @param segments - 从项目根开始的目录段；只允许安全单段名。
 * @param create - 缺失时是否逐段创建；读取路径传 false。
 * @returns 目录绝对路径；`create` 为 false 且目录缺失时为 null。
 */
export async function stateDirectory(
  files: RequirementFiles,
  projectId: string,
  segments: readonly string[],
  create: boolean,
): Promise<string | null> {
  if (segments.length === 0) throw new Error('stateDirectory requires at least one segment')
  let current = await files.root(projectId)
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !SEGMENT.test(segment)) {
      throw new RequirementKnowledgeError('项目内的保存位置无效。', 'INVALID_PATH')
    }
    current = path.join(current, segment)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info === null) {
      if (!create) return null
      await mkdir(current)
      continue
    }
    if (info.isSymbolicLink()) throw new RequirementKnowledgeError('项目内的保存位置不允许链接。', 'INVALID_PATH')
    if (!info.isDirectory()) throw new RequirementKnowledgeError('项目内的保存位置不是目录。', 'INVALID_PATH')
  }
  return current
}

/** 原子写入 JSON：临时文件与目标同目录，改名完成可见切换。 */
export async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** 读取 JSON 文件；不存在返回 null，内容或读取失败按调用方语义抛出。 */
export async function readJsonFile(target: string): Promise<unknown | null> {
  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(raw) as unknown
}
