/** One-time, offline JSON import. Source files remain untouched; normal runtime never reads them. */
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { localDatabasePath, readLocalRecord, writeLocalRecords } from '../packages/studio-plugin/src/host/adapters/local-state/sqlite-state.ts'

const receiptKey = 'json-import-receipt'
const collections = ['projects', 'tasks', 'candidates', 'operations', 'reviews', 'adoptions', 'projectInitializations', 'materialReservations', 'templateOperations', 'scenarios', 'scenarioRepairs', 'consistencyComparisons']
const projectCollections = collections.filter(key => !['projects', 'projectInitializations'].includes(key))
const workflowKeys = ['prototype-queue', 'prototype-integrations', 'prototype-candidates', 'prototype-material-reads']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const help = `Usage: node scripts/import-local-state.mjs --state-directory ABSOLUTE_PATH

Close every EADP desktop/Host using this state directory before importing.
Imports only known local JSON records into studio.sqlite databases.
Source JSON files are read-only and remain in place. Existing database records
are never overwritten. A completed import is skipped on subsequent runs.
Node 22.22 or later with node:sqlite and TypeScript stripping is required.
`

async function source(file, required = false) {
  let bytes
  try { bytes = await readFile(file) } catch (error) { if (error.code === 'ENOENT' && !required) return undefined; throw error }
  try { return { file, sha256: hash(bytes), value: JSON.parse(bytes.toString('utf8')) } }
  catch { throw new Error(`Invalid JSON source: ${file}`) }
}

function validateRecord(key, value, projectId, accountId) {
  if (key === 'studio-state') {
    if (!object(value) || value.formatVersion !== 3 || typeof value.clientId !== 'string' || !value.clientId || typeof value.scenarioStructureCheck !== 'boolean' || collections.some(name => !Array.isArray(value[name]))) throw new Error('Invalid current studio-state record')
    if (projectCollections.some(name => value[name].length)) throw new Error('Application index contains project payload; preserve and inspect it before import')
  } else if (key === 'local-state') {
    if (!object(value) || value.projectId !== projectId || value.accountId !== accountId || projectCollections.some(name => !Array.isArray(value[name]) || value[name].some(item => !object(item) || item.projectId !== projectId))) throw new Error('Invalid project local-state record')
  } else if (key === 'workspace-location') {
    if (!object(value) || typeof value.defaultDirectory !== 'string' || !path.isAbsolute(value.defaultDirectory)) throw new Error('Invalid workspace-location record')
  } else if (key === 'prototype-queue') {
    if (!object(value) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.tasks) || !Array.isArray(value.operations)) throw new Error('Invalid prototype queue record')
  } else if (key === 'prototype-integrations') {
    if (!object(value) || !Array.isArray(value.operations) || !Array.isArray(value.taskEnds)) throw new Error('Invalid prototype integration record')
  } else if (key === 'prototype-candidates') {
    if (!object(value) || !Array.isArray(value.operations)) throw new Error('Invalid prototype candidate record')
  } else if (key === 'prototype-material-reads' || key.startsWith('prototype-checks/')) {
    if (!Array.isArray(value)) throw new Error('Invalid prototype history record')
  }
}

async function validateImport(database, sources, writes) {
  const receipt = await readLocalRecord(database, receiptKey)
  if (receipt) {
    const expected = sources.map(({ file, sha256 }) => ({ file, sha256 }))
    if (JSON.stringify(receipt.sources) !== JSON.stringify(expected)) throw new Error("Previously imported project source changed; preserve the databases and inspect the source files")
    return false
  }
  const identities = new Set()
  for (const write of writes) {
    const identity = JSON.stringify([path.resolve(write.database).toLowerCase(), write.key])
    if (identities.has(identity)) throw new Error(`Duplicate import destination: ${write.key}`)
    identities.add(identity)
    if (await readLocalRecord(write.database, write.key) !== undefined) throw new Error(`Destination already has a record: ${write.key}`)
  }
  return true
}

async function verifySources(sources) {
  for (const record of sources) if (hash(await readFile(record.file)) !== record.sha256) throw new Error(`Source changed during import: ${record.file}`)
}

async function commitImport(database, sources, writes) {
  if (!await validateImport(database, sources, writes)) return false
  await verifySources(sources)
  await writeLocalRecords([...writes, { database, key: receiptKey, value: { importedAt: new Date().toISOString(), sources: sources.map(({ file, sha256 }) => ({ file, sha256 })) } }])
  return true
}

/** Preserve account/task/session identities while importing only the explicitly registered projects. */
export async function importLocalState(directory) {
  if (!path.isAbsolute(directory)) throw new Error('--state-directory must be absolute')
  const results = []
  const rootDatabase = localDatabasePath(directory)
  if (!await readLocalRecord(rootDatabase, receiptKey)) {
    const setting = await source(path.join(directory, 'workspace-location.json'))
    if (setting) {
      validateRecord('workspace-location', setting.value)
      results.push({ scope: 'application', imported: await commitImport(rootDatabase, [setting], [{ database: rootDatabase, key: 'workspace-location', value: setting.value }]) })
    }
  }
  let users
  try { users = await readdir(path.join(directory, 'users'), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return results; throw error }
  for (const user of users.filter(entry => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))) {
    const accountId = Number(user.name)
    if (!Number.isSafeInteger(accountId)) throw new Error('Invalid account directory')
    const accountDirectory = path.join(directory, 'users', user.name), database = localDatabasePath(accountDirectory)
    if (await readLocalRecord(database, receiptKey)) { results.push({ scope: user.name, imported: false }); continue }
    const index = await source(path.join(accountDirectory, 'studio-state.json'), true)
    validateRecord('studio-state', index.value)
    const account = { database, sources: [index], writes: [{ database, key: 'studio-state', value: index.value }] }
    const projects = []
    const add = async (scope, file, key, required, projectId) => {
      const record = await source(file, required)
      if (!record) return
      validateRecord(key, record.value, projectId, accountId)
      scope.sources.push(record)
      const value = structuredClone(record.value)
      if (projectId && key === 'prototype-queue') value.revision = 0
      scope.writes.push({ database: scope.database, key, value })
    }
    await add(account, path.join(accountDirectory, 'prototype-queue.json'), 'prototype-queue', false)
    for (const project of index.value.projects) {
      if (!object(project) || typeof project.id !== 'string' || !project.id || typeof project.workspaceDirectory !== 'string' || !path.isAbsolute(project.workspaceDirectory)) throw new Error('Invalid registered project')
      const projectDirectory = path.join(project.workspaceDirectory, '.eadp', 'users', user.name)
      const scope = { database: localDatabasePath(projectDirectory), sources: [], writes: [] }
      await add(scope, path.join(projectDirectory, 'local-state.json'), 'local-state', true, project.id)
      for (const key of workflowKeys) await add(scope, path.join(projectDirectory, `${key}.json`), key, false, project.id)
      let checks
      try { checks = await readdir(path.join(projectDirectory, 'prototype-checks'), { withFileTypes: true }) } catch (error) { if (error.code !== 'ENOENT') throw error; checks = [] }
      for (const check of checks.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).sort((a,b) => a.name.localeCompare(b.name))) await add(scope, path.join(projectDirectory, 'prototype-checks', check.name), `prototype-checks/${check.name.slice(0, -5)}`, true, project.id)
      projects.push(scope)
    }
    const allSources = [...account.sources, ...projects.flatMap(scope => scope.sources)]
    const revision = Math.max(0, ...allSources.filter(record => record.file.endsWith('prototype-queue.json')).map(record => record.value.revision))
    let metadata = account.writes.find(write => write.key === 'prototype-queue')
    if (!metadata) { metadata = { database, key: 'prototype-queue', value: { tasks: [], operations: [] } }; account.writes.push(metadata) }
    metadata.value.revision = revision
    // Check every source and destination before publishing any project or account index.
    for (const scope of projects) await validateImport(scope.database, scope.sources, scope.writes)
    await validateImport(database, allSources, account.writes)
    await verifySources(allSources)
    for (const scope of projects) await commitImport(scope.database, scope.sources, scope.writes)
    // The account index is the publication point. Partial runs can resume using project receipts.
    await verifySources(allSources)
    results.push({ scope: user.name, imported: await commitImport(database, allSources, account.writes) })
  }
  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') console.log(help)
  else if (args.length !== 2 || args[0] !== '--state-directory' || !path.isAbsolute(args[1])) { console.error(help); process.exitCode = 1 }
  else {
    console.log('Offline import: every EADP desktop/Host using this directory must be closed. Original files will be retained.')
    importLocalState(args[1]).then(results => console.log(JSON.stringify(results)), error => { console.error(`Import stopped: ${error.message}`); process.exitCode = 1 })
  }
}
