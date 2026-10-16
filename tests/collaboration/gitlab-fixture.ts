import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export const fixtureToken = 'synthetic-management-credential'
export const boundUser = { id: 701, username: 'songlin.liu', email: 'songlin.liu@changhong.com', name: 'Songlin Liu', state: 'active' }

export interface RemoteProject {
  id: number; name: string; path: string; path_with_namespace: string; description: string;
  namespace: { id: number; full_path: string }; http_url_to_repo: string; ssh_url_to_repo: string;
  default_branch: string | null; empty_repo: boolean; visibility: string;
  memberLevel: number; directMember: boolean; head: string | null; manifest?: object;
}

export async function gitlabFixture() {
  const projects = new Map<number, RemoteProject>()
  const counts = { creates: 0, members: 0, searches: 0, headReads: 0 }
  const controls = { loseNextCreateResponse: false, failNextMember: false, wrongRootParent: false, groupMemberLevel: 30, commitParent: null as string | null }
  const namespaces = [
    { id: 42, name: 'Delivery', path: 'delivery', full_path: 'delivery', project_creation_level: 'developer', visibility: 'private' },
    { id: 99, name: 'Management only', path: 'management', full_path: 'management', project_creation_level: 'maintainer', visibility: 'private' },
  ]
  let origin = ''
  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'x-next-page': '' }).end(JSON.stringify(body))
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.headers['private-token'] ?? request.headers.authorization?.replace(/^Bearer /, ''), fixtureToken)
    const url = new URL(request.url ?? '/', origin)
    const route = decodeURIComponent(url.pathname.replace(/^\/api\/v4/, ''))
    if (route === '/user') return send(response, 200, { id: 900, username: 'manager', is_admin: true, state: 'active' })
    if (route === '/users' && request.method === 'GET') {
      counts.searches++
      assert.ok(url.searchParams.get('search') === boundUser.email || url.searchParams.get('username') === boundUser.email)
      return send(response, 200, [boundUser])
    }
    if (route === `/users/${boundUser.id}`) return send(response, 200, boundUser)
    if (route === '/groups') return send(response, 200, namespaces)
    const groupMember = /^\/groups\/(\d+)\/members(?:\/all)?\/701$/.exec(route)
    if (groupMember) return send(response, Number(groupMember[1]) === 42 ? 200 : 404,
      Number(groupMember[1]) === 42 ? { id: 701, access_level: controls.groupMemberLevel, state: 'active', expires_at: null } : { message: 'Not found' })
    const group = /^\/groups\/(\d+)$/.exec(route)
    if (group) {
      const namespace = namespaces.find(item => item.id === Number(group[1]))
      return send(response, namespace ? 200 : 404, namespace ?? { message: 'Not found' })
    }
    if (route === '/projects' && request.method === 'POST') {
      let data = ''
      for await (const chunk of request) data += chunk
      const body = request.headers['content-type']?.includes('application/json') ? JSON.parse(data) : Object.fromEntries(new URLSearchParams(data))
      assert.equal(Number(body.namespace_id), 42)
      assert.equal(body.visibility, 'private')
      assert.notEqual(body.initialize_with_readme, true)
      if ([...projects.values()].some(item => item.path === body.path)) return send(response, 400, { message: 'path has already been taken' })
      counts.creates++
      const id = 1000 + counts.creates
      const project: RemoteProject = {
        id, name: body.name, path: body.path, path_with_namespace: `delivery/${body.path}`, description: body.description ?? '',
        namespace: { id: 42, full_path: 'delivery' }, http_url_to_repo: `${origin}/delivery/${body.path}.git`,
        ssh_url_to_repo: `git@fixture.invalid:delivery/${body.path}.git`, default_branch: null, empty_repo: true,
        visibility: 'private', memberLevel: 30, directMember: false, head: null,
      }
      projects.set(id, project)
      if (controls.loseNextCreateResponse) { controls.loseNextCreateResponse = false; response.destroy(); return }
      return send(response, 201, publicProject(project))
    }
    const projectRoute = /^\/projects\/(.+?)(?:\/(members.*|repository.*))?$/.exec(route)
    if (projectRoute) {
      const selector = projectRoute[1]!
      const project = /^\d+$/.test(selector) ? projects.get(Number(selector)) : [...projects.values()].find(item => item.path_with_namespace === selector)
      if (!project) return send(response, 404, { message: 'Not found' })
      const action = projectRoute[2]
      if (!action) return send(response, 200, publicProject(project))
      if (/^members(?:\/all)?\/701$/.test(action) && request.method === 'GET') {
        if (action === 'members/701' && !project.directMember) return send(response, 404, { message: 'Not found' })
        return send(response, 200, { id: 701, username: boundUser.username, access_level: project.memberLevel, state: 'active', expires_at: null })
      }
      if (/^members(?:\/701)?$/.test(action) && ['POST', 'PUT'].includes(request.method ?? '')) {
        counts.members++
        if (controls.failNextMember) { controls.failNextMember = false; return send(response, 503, { message: 'fixture member failure' }) }
        project.memberLevel = 40; project.directMember = true
        return send(response, 201, { id: 701, username: boundUser.username, access_level: 40, state: 'active', expires_at: null })
      }
      if (action === 'repository/branches/main') {
        counts.headReads++
        return send(response, project.head ? 200 : 404, project.head ? { name: 'main', commit: { id: project.head }, protected: true } : { message: 'Not found' })
      }
      if (action === 'repository/branches') return send(response, 200, project.head ? [{ name: 'main', commit: { id: project.head } }] : [])
      if (action === 'repository/merge_base') {
        const refs = url.searchParams.getAll('refs[]')
        return send(response, 200, { id: refs[0] ?? project.head })
      }
      if (action === 'repository/compare') return send(response, 200, { compare_timeout: false, compare_same_ref: false, diffs: [] })
      if (action.startsWith('repository/commits/')) return send(response, 200, { id: project.head, parent_ids: controls.wrongRootParent ? ['b'.repeat(40)] : controls.commitParent ? [controls.commitParent] : [] })
      if (action === 'repository/tree') {
        const entries = ['场景', '需求', '原型代码'].map(name => ({ id: 'c'.repeat(40), name, path: name, type: 'tree', mode: '040000' }))
        const manifestBytes = Buffer.from(JSON.stringify(project.manifest ?? {}) + '\n')
        const manifestId = createHash('sha1').update(`blob ${manifestBytes.length}\0`).update(manifestBytes).digest('hex')
        return send(response, 200, [...entries, { id: manifestId, name: 'project.assets.json', path: 'project.assets.json', type: 'blob', mode: '100644' }])
      }
      if (/^repository\/blobs\/[a-f0-9]{40}\/raw$/.test(action)) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(JSON.stringify(project.manifest ?? {}) + '\n')
        return
      }
    }
    return send(response, 404, { message: 'Unknown test fixture route' })
  }
  function publicProject(project: RemoteProject) {
    const { memberLevel: _level, directMember: _direct, head: _head, manifest: _manifest, ...value } = project
    return { ...value, permissions: { project_access: { access_level: 50 } } }
  }
  const server = createServer((request, response) => { void handle(request, response).catch(() => send(response, 500, { message: 'GitLab fixture rejected a request' })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`
  return { origin, projects, counts, controls, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }) }
}
