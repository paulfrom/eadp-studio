import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const lockFilename = '.studio-desktop-build.lock'
const ownerFilename = 'owner.json'
const incompleteLockGraceMs = 2000
const retryDelayMs = 50
const retryLimit = 100
let currentProcessStartTime

const delay = () => new Promise(resolve => setTimeout(resolve, retryDelayMs))
const lockError = lock => new Error(`A desktop build or debug session owns ${lock}. Close it first.`)
const inspectionError = lock => new Error(`Desktop process cleanup failed and ${lock} was retained for inspection. Inspect its processes before removing it.`)

function processStartTime(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (pid === process.pid && currentProcessStartTime) return currentProcessStartTime
  const windows = process.platform === 'win32'
  const command = windows ? 'powershell.exe' : 'ps'
  const args = windows
    ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`]
    : ['-p', String(pid), '-o', 'lstart=']
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) return undefined
  const startTime = result.stdout.trim()
  if (!startTime) return undefined
  if (pid === process.pid) currentProcessStartTime = startTime
  return startTime
}

function validOwner(owner) {
  return owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.startTime === 'string' && owner.startTime && typeof owner.id === 'string' && owner.id
}

function ownerIsActive(owner) {
  try { process.kill(owner.pid, 0) } catch (error) {
    if (error.code === 'ESRCH') return false
    return true
  }
  const startTime = processStartTime(owner.pid)
  return startTime === undefined || startTime === owner.startTime
}

async function inspectLock(lock) {
  try {
    const owner = JSON.parse(await readFile(path.join(lock, ownerFilename), 'utf8'))
    if (!validOwner(owner)) return { kind: 'invalid' }
    if (owner.requiresInspection) return { kind: 'inspect', owner }
    return { kind: ownerIsActive(owner) ? 'active' : 'stale', owner }
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'empty' }
    if (error instanceof SyntaxError) return { kind: 'invalid' }
    throw error
  }
}

async function incompleteLockExpired(lock) {
  try {
    return Date.now() - (await stat(lock)).mtimeMs >= incompleteLockGraceMs
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
}

async function reclaimLock(lock, expected) {
  const current = await inspectLock(lock)
  if (!['empty', 'invalid', 'stale'].includes(current.kind)) return false
  if (expected.owner && current.owner && expected.owner.id !== current.owner.id) return false
  if (!expected.owner && current.owner) return false
  if (['empty', 'invalid'].includes(current.kind) && !await incompleteLockExpired(lock)) return false
  if (current.kind !== 'empty') {
    try { await unlink(path.join(lock, ownerFilename)) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try { await rmdir(lock) } catch (error) {
    if (error.code === 'ENOENT') return true
    if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) return false
    throw error
  }
  return true
}

export async function acquireDesktopBuildLock(buildRoot) {
  await mkdir(buildRoot, { recursive: true })
  const lock = path.join(buildRoot, lockFilename)
  const ownerPath = path.join(lock, ownerFilename)
  const startTime = processStartTime(process.pid)
  if (!startTime) throw new Error('Cannot identify the current process for the desktop build lock.')
  const owner = { pid: process.pid, startTime, id: randomUUID() }
  for (let attempt = 0; attempt < retryLimit; attempt++) {
    let created = false
    try {
      await mkdir(lock)
      created = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (created) {
      try {
        await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { flag: 'wx' })
      } catch (error) {
        if (error.code === 'ENOENT') { await delay(); continue }
        try { await rmdir(lock) } catch {}
        throw error
      }
      const release = async () => {
        const current = await inspectLock(lock)
        if (current.owner && current.owner.id !== owner.id) return
        if (current.kind !== 'empty') {
          try { await unlink(ownerPath) } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
        }
        try { await rmdir(lock) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      const preserveForInspection = async () => {
        const current = await inspectLock(lock)
        if (current.owner?.id !== owner.id) throw new Error(`Desktop build lock ownership changed for ${lock}.`)
        await writeFile(ownerPath, `${JSON.stringify({ ...owner, requiresInspection: true })}\n`)
      }
      return { release, preserveForInspection }
    }
    const state = await inspectLock(lock)
    if (state.kind === 'active') throw lockError(lock)
    if (state.kind === 'inspect') throw inspectionError(lock)
    if (state.kind === 'stale' || await incompleteLockExpired(lock)) {
      if (await reclaimLock(lock, state)) continue
    }
    await delay()
  }
  throw lockError(lock)
}
