import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { SubprocessProvider } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'

export const gitHttpToken = 'synthetic-loopback-management-token'
export const gitHttpUser = { id: 701, username: 'workflow-author', email: 'songlin.liu@changhong.com', name: 'Workflow Author', state: 'active' }
interface Project {
  id: number; name: string; path: string; path_with_namespace: string; description: string
  namespace: { id: number; full_path: string }; http_url_to_repo: string; visibility: string
  default_branch: string | null; memberLevel: number; directMember: boolean; directory: string
}
const exec = promisify(execFile)

/** GitLab-shaped API backed by actual Git objects and the standard smart HTTP CGI. */
export async function gitHttpFixture(gitExecutable: string, serverGitExecutable: string) {
  assert.ok(path.isAbsolute(gitExecutable) && path.isAbsolute(serverGitExecutable), 'The test must explicitly select its pinned client Git and full server Git executables')
  const root = await mkdtemp(path.join(tmpdir(), 'studio-git-http-')), home = path.join(root, 'home'), repositories = path.join(root, 'repositories')
  await mkdir(home); await mkdir(repositories)
  const globalConfig = path.join(home, '.gitconfig')
  await writeFile(globalConfig, '[user]\n\tname = Workflow Author\n\temail = workflow-author@example.test\n[core]\n\tautocrlf = false\n')
  const isolatedEnvironment: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PATH: [path.dirname(gitExecutable), path.resolve(path.dirname(gitExecutable), '../bin'), path.resolve(path.dirname(gitExecutable), '../usr/bin')].join(path.delimiter),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', NO_PROXY: '127.0.0.1,localhost',
  }
  const git = async (directory: string, args: readonly string[]) => {
    const { stdout } = await exec(gitExecutable, ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], { cwd: directory, env: isolatedEnvironment, encoding: 'buffer', timeout: 30_000, maxBuffer: 20 * 1024 * 1024 })
    return stdout
  }
  const projects = new Map<number, Project>(), objects: Array<{ projectId: number; operation: string; ref: string }> = []
  let origin = '', nextId = 1000, gitRequests = 0
  const json = (response: ServerResponse, status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json', 'x-next-page': '' }).end(JSON.stringify(body))
  const raw = (response: ServerResponse, bytes: Buffer) => response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes)
  const payload = async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }
  const currentHead = async (project: Project) => { try { return (await git(project.directory, ['rev-parse', '--verify', 'refs/heads/main'])).toString('utf8').trim() } catch { return null } }
  const publicProject = async (project: Project) => ({ id: project.id, name: project.name, path: project.path, path_with_namespace: project.path_with_namespace, description: project.description, namespace: project.namespace, http_url_to_repo: project.http_url_to_repo, visibility: project.visibility, default_branch: await currentHead(project) ? 'main' : null })
  const member = (project?: Project) => ({ id: gitHttpUser.id, state: 'active', access_level: project?.memberLevel ?? 40, expires_at: null })
  const group = { id: 42, name: 'Delivery', path: 'delivery', full_path: 'delivery', project_creation_level: 'developer' }
  async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (request.headers['private-token'] !== gitHttpToken) return json(response, 401, { message: 'Synthetic management authorization required' })
    const route = decodeURIComponent(url.pathname.slice('/api/v4'.length))
    if (route === '/user') return json(response, 200, { id: 900, username: 'synthetic-manager', state: 'active' })
    if (route === '/users') return json(response, 200, [gitHttpUser])
    if (route === `/users/${gitHttpUser.id}`) return json(response, 200, gitHttpUser)
    if (route === '/groups') return json(response, 200, [group])
    if (route === '/groups/42') return json(response, 200, group)
    if (route === `/groups/42/members/all/${gitHttpUser.id}`) return json(response, 200, member())
    if (route === '/projects' && request.method === 'POST') {
      const body = await payload(request); assert.equal(body.namespace_id, 42); assert.equal(body.visibility, 'private'); assert.equal(body.initialize_with_readme, false)
      assert.match(String(body.path), /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      if ([...projects.values()].some(project => project.path === body.path)) return json(response, 409, { message: 'Path exists' })
      const directory = path.join(repositories, 'delivery', `${body.path}.git`)
      await mkdir(path.dirname(directory), { recursive: true }); await git(repositories, ['init', '--bare', '--initial-branch=main', directory]); await git(directory, ['config', 'http.receivepack', 'true'])
      const project: Project = { id: ++nextId, name: String(body.name), path: String(body.path), path_with_namespace: `delivery/${body.path}`, description: String(body.description), namespace: { id: 42, full_path: 'delivery' }, http_url_to_repo: `${origin}/delivery/${body.path}.git`, visibility: 'private', default_branch: null, memberLevel: 30, directMember: false, directory }
      projects.set(project.id, project); return json(response, 201, await publicProject(project))
    }
    const matched = /^\/projects\/(.+?)(?:\/(members.*|repository.*))?$/.exec(route)
    if (!matched) return json(response, 404, { message: 'Unknown synthetic API route' })
    const selector = matched[1]!, project = /^\d+$/.test(selector) ? projects.get(Number(selector)) : [...projects.values()].find(value => value.path_with_namespace === selector)
    if (!project) return json(response, 404, { message: 'Project not found' })
    const action = matched[2]
    if (!action) return json(response, 200, await publicProject(project))
    if (/^members(?:\/all)?\/701$/.test(action) && request.method === 'GET') return action === 'members/701' && !project.directMember ? json(response, 404, {}) : json(response, 200, member(project))
    if (/^members(?:\/701)?$/.test(action) && ['POST', 'PUT'].includes(request.method ?? '')) { await payload(request); project.memberLevel = 40; project.directMember = true; return json(response, 200, member(project)) }
    if (action === 'repository/branches/main') { const head = await currentHead(project); return head ? json(response, 200, { name: 'main', commit: { id: head } }) : json(response, 404, {}) }
    if (action === 'repository/branches') { const head = await currentHead(project); return json(response, 200, head ? [{ name: 'main', commit: { id: head } }] : []) }
    if (action.startsWith('repository/commits/')) {
      const ref = action.slice('repository/commits/'.length); assert.match(ref, /^[a-f0-9]{40}$/)
      const parts = (await git(project.directory, ['rev-list', '--parents', '-n', '1', ref])).toString('utf8').trim().split(' ')
      objects.push({ projectId: project.id, operation: 'commit', ref }); return json(response, 200, { id: parts[0], parent_ids: parts.slice(1) })
    }
    if (action === 'repository/tree') {
      const ref = url.searchParams.get('ref')!; assert.match(ref, /^[a-f0-9]{40}$/)
      const tree = (await git(project.directory, ['ls-tree', '-z', ref])).toString('utf8').split('\0').filter(Boolean).map(entry => {
        const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(entry)!; return { mode: match[1], type: match[2], id: match[3], name: match[4], path: match[4] }
      }); objects.push({ projectId: project.id, operation: 'tree', ref }); return json(response, 200, tree)
    }
    if (action.startsWith('repository/files/') && action.endsWith('/raw')) {
      const file = action.slice('repository/files/'.length, -'/raw'.length), ref = url.searchParams.get('ref')!; assert.match(ref, /^[a-f0-9]{40}$/)
      assert.ok(!file.startsWith('/') && !file.split('/').includes('..')); objects.push({ projectId: project.id, operation: `file:${file}`, ref }); return raw(response, await git(project.directory, ['show', `${ref}:${file}`]))
    }
    if (/^repository\/blobs\/[a-f0-9]{40}\/raw$/.test(action)) {
      const ref = action.split('/')[2]!; objects.push({ projectId: project.id, operation: 'blob', ref }); return raw(response, await git(project.directory, ['cat-file', 'blob', ref]))
    }
    if (action === 'repository/compare') {
      const from = url.searchParams.get('from')!, to = url.searchParams.get('to')!; assert.match(from, /^[a-f0-9]{40}$/); assert.match(to, /^[a-f0-9]{40}$/)
      const names = (await git(project.directory, ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', from, to])).toString('utf8').split('\0').filter(Boolean), diffs = []
      for (let index = 0; index < names.length; index += 2) {
        const status = names[index]!, file = names[index + 1]!, patch = (await git(project.directory, ['diff', '--no-ext-diff', '--no-color', '--no-renames', from, to, '--', file])).toString('utf8')
        diffs.push({ old_path: file, new_path: file, deleted_file: status === 'D', renamed_file: false, diff: patch })
      }
      objects.push({ projectId: project.id, operation: `compare:${from}`, ref: to }); return json(response, 200, { compare_timeout: false, compare_same_ref: from === to, diffs })
    }
    if (action === 'repository/merge_base') { const refs = url.searchParams.getAll('refs[]'); refs.forEach(ref => assert.match(ref, /^[a-f0-9]{40}$/)); return json(response, 200, { id: (await git(project.directory, ['merge-base', ...refs])).toString('utf8').trim() }) }
    return json(response, 404, { message: 'Unsupported synthetic repository API' })
  }
  async function smartHttp(request: IncomingMessage, response: ServerResponse, url: URL) {
    const match = /^\/delivery\/([a-z0-9-]+)\.git(?:\/|$)/.exec(url.pathname)
    if (!match || ![...projects.values()].some(project => project.path === match[1])) return json(response, 404, {})
    gitRequests++
    const child = spawn(serverGitExecutable, ['http-backend'], { cwd: repositories, env: { ...isolatedEnvironment, GIT_PROJECT_ROOT: repositories, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers['content-type'] ?? '', ...(request.headers['content-length'] ? { CONTENT_LENGTH: request.headers['content-length'] } : {}), REMOTE_USER: 'synthetic-author', REMOTE_ADDR: '127.0.0.1', HTTP_GIT_PROTOCOL: request.headers['git-protocol'] as string ?? '' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const output: Buffer[] = [], errors: Buffer[] = []
    child.stdout.on('data', chunk => output.push(Buffer.from(chunk))); child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
    request.pipe(child.stdin); child.stdin.on('error', () => {})
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Git CGI exited ${code}: ${Buffer.concat(errors).toString('utf8')}`))) })
    const bytes = Buffer.concat(output), crlf = bytes.indexOf('\r\n\r\n'), lf = bytes.indexOf('\n\n'), boundary = crlf >= 0 ? crlf : lf
    assert.ok(boundary >= 0, 'Git CGI must emit valid response headers')
    const headers = bytes.subarray(0, boundary).toString('utf8').split(/\r?\n/), resultHeaders: Record<string, string> = {}; let status = 200
    for (const header of headers) { const colon = header.indexOf(':'); assert.ok(colon > 0); const name = header.slice(0, colon).toLowerCase(), value = header.slice(colon + 1).trim(); if (name === 'status') status = Number(value.split(' ')[0]); else resultHeaders[name] = value }
    response.writeHead(status, resultHeaders).end(bytes.subarray(boundary + (crlf >= 0 ? 4 : 2)))
  }
  const failures: string[] = []
  const server = createServer((request, response) => { const url = new URL(request.url ?? '/', origin); void (url.pathname.startsWith('/api/v4/') ? api(request, response, url) : smartHttp(request, response, url)).catch(error => { failures.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) json(response, 500, { message: 'Test-owned Git HTTP/API operation failed' }); else response.destroy() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`
  const subprocess: SubprocessProvider = { spawn(spec) {
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: { ...spec.env, ...isolatedEnvironment }, signal: spec.signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(spec.stdio.stdin === 'ignore' ? undefined : spec.stdio.stdin.data)
    const diagnostics: Buffer[] = []; child.stderr.on('data', chunk => diagnostics.push(Buffer.from(chunk)))
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => { if (exitCode && spec.argv.includes('push')) console.error('Synthetic Git push stderr:', Buffer.concat(diagnostics).toString('utf8')); resolve({ exitCode, signal }) }) })
    return { stdout: child.stdout, stderr: child.stderr, stdin: child.stdin, done, terminate: () => { child.kill() }, waitForExit: async () => { await done; return true } }
  } }
  return { origin, root, home, projects, objects, failures, subprocess, git, gitRequests: () => gitRequests,
    close: async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }); await rm(root, { recursive: true, force: true }) },
  }
}
