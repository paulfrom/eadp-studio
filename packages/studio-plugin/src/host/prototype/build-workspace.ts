import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PrototypeTaskIdentity } from './generation.ts'
import { listPrototypeFiles, prototypeInputHash, verifyPrototypeContract } from './template.ts'
import { writePrototypeSnapshot } from './snapshot.ts'

/** Builds an exact source snapshot in an owned short directory, independently of the author's checkout. */
export async function preparePrototypeBuildWorkspace(source: PrototypeTaskIdentity): Promise<{
  input: PrototypeTaskIdentity; verify(): Promise<void>; dispose(): Promise<void>
}> {
  await verifyPrototypeContract(source.prototypeRoot, source.manifestPath)
  const expected = await prototypeInputHash(source.prototypeRoot)
  const base = path.join(await realpath(tmpdir()), 'eadp-build')
  await mkdir(base, { recursive: true, mode: 0o700 })
  if ((await lstat(base)).isSymbolicLink()) throw new Error('构建运行目录不能是符号链接')
  const root = await mkdtemp(path.join(base, 'run-'))
  let disposed = false
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= (async () => {
    if (path.dirname(root) !== base || (await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('构建运行目录已变化')
    disposed = true
    await rm(root, { recursive: true, force: true })
  })()
  const input = { ...source, prototypeRoot: root }
  const verify = async (): Promise<void> => {
    if (disposed || await prototypeInputHash(source.prototypeRoot) !== expected || await prototypeInputHash(root) !== expected) throw new Error('原型源码在构建期间发生变化，请重新运行')
    await verifyPrototypeContract(root, source.manifestPath)
  }
  try {
    const files = await Promise.all((await listPrototypeFiles(source.prototypeRoot)).map(async file => ({ path: file, bytes: await readFile(path.join(source.prototypeRoot, file)), mode: '100644' as const })))
    await writePrototypeSnapshot(root, files)
    await verify()
    return { input, verify, dispose }
  } catch (error) { await dispose(); throw error }
}
