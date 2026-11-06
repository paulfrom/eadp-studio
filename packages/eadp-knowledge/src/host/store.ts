import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, mkdir, rename, unlink } from 'node:fs/promises'
import { join, dirname, parse, relative as pathRelative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { KnowledgePackId, KnowledgeDraft, KnowledgeCatalog, KnowledgeRead, KnowledgeSearchResult, KnowledgeErrorCode } from '@eadp/contracts/knowledge'
export class KnowledgeError extends Error {
  constructor(public code: KnowledgeErrorCode, message: string) {
    super(message)
  }
}
export const fail = (code: KnowledgeErrorCode, message: string): never => {
  throw new KnowledgeError(code, message)
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const validId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)
interface Document {
  id: string
  path: string
  title: string
  source: string
  scope: string
  tags: string[]
  sha256: string
}
interface Manifest {
  schemaVersion: 1
  packId: KnowledgePackId
  version: string
  documents: Document[]
}
interface Loaded {
  manifest: Manifest
  texts: Map<string, string>
  exists: boolean
  raw: string | null
}
const empty = (): Manifest => ({
  schemaVersion: 1, packId: 'user', version: '0', documents: []
})
const exact = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
export function validateDraft(draft: KnowledgeDraft): void {
  if (!draft || !exact(draft, ['title', 'source', 'scope', 'tags', 'text']))
    fail('INVALID_ARGUMENT', '知识卡字段不合法。')
  for (const key of ['title', 'source', 'scope'] as const)
    if (typeof draft[key] !== 'string' || !draft[key].trim() || Array.from(draft[key]).length > 1000 || draft[key].includes('\0') || Buffer.from(draft[key]).toString('utf8') !== draft[key])
      fail('INVALID_ARGUMENT', '标题、出处、范围必填且最多 1000 字。')
  if (!Array.isArray(draft.tags) || draft.tags.length > 20 || draft.tags.some(tag => typeof tag !== 'string' || !tag.trim() || Array.from(tag).length > 100 || tag.includes('\0') || Buffer.from(tag).toString('utf8') !== tag))
    fail('INVALID_ARGUMENT', '标签最多 20 个，每个最多 100 字。')
  if (typeof draft.text !== 'string' || !draft.text.trim() || Array.from(draft.text).length > 20000 || draft.text.includes('\0') || Buffer.from(draft.text).toString('utf8') !== draft.text)
    fail('INVALID_ARGUMENT', '正文必须为有效 UTF-8，非空且最多 20000 字。')
}
/** 以不可变正文和原子清单提交保存用户知识，写入失败时保留上一版。 */
export class KnowledgeStore {
  constructor(private readonly diagnostic: (message: string) => void) {
  }
  private tail: Promise<unknown> = Promise.resolve()
  private roots = {
    builtin: fileURLToPath(new URL('../resources/builtin/', import.meta.url)), user: join(resolveDshHome(), 'knowledge')
  }
  mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation)
    this.tail = next.catch(() => {
    })
    return next
  }
  private async safe(pack: KnowledgePackId, relative: string): Promise<string> {
    if (!['builtin', 'user'].includes(pack) || !/^(manifest\.json|cards\/[a-zA-Z0-9_.-]+\.md)$/.test(relative))
      fail('INVALID_ARGUMENT', '知识路径无效。')
    const root = this.roots[pack]
    let cursor = root
    // 检查完整绝对路径的所有祖先，拒绝数据目录及其下的符号链接。
    const anchor = parse(root).root
    const parts = pathRelative(anchor, root).split(sep).filter(Boolean)
    cursor = anchor
    for (const part of [...parts, ...relative.split('/')]) {
      cursor = join(cursor, part)
      try {
        if ((await lstat(cursor)).isSymbolicLink())
          fail('RESOURCE_INVALID', '知识路径不能包含符号链接。')
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error
      }
    }
    return join(root, relative)
  }
  private async text(pack: KnowledgePackId, relative: string, max: number): Promise<string> {
    const path = await this.safe(pack, relative)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > max)
        fail('RESOURCE_INVALID', '知识资源大小或类型无效。')
      const data = await file.readFile()
      if (data.length > max)
        fail('RESOURCE_INVALID', '知识资源过大。')
      return new TextDecoder('utf-8', {
        fatal: true
      }).decode(data)
    }
    finally {
      await file.close()
    }
  }

  /** 独立读取并校验一个知识包，不创建缺失的用户清单。 */
  async load(pack: KnowledgePackId, repair = false): Promise<Loaded> {
    let raw: string
    try {
      raw = await this.text(pack, 'manifest.json', 2000000)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && pack === 'user')
        return {
          manifest: empty(), texts: new Map(), exists: false, raw: null
        }
      throw error
    }
    let m: Manifest
    try {
      m = JSON.parse(raw) as Manifest
    }
    catch {
      return fail('RESOURCE_INVALID', 'manifest JSON 损坏，不能猜测修复。')
    }
    if (!m || !exact(m, ['schemaVersion', 'packId', 'version', 'documents']) || m.schemaVersion !== 1 || m.packId !== pack || typeof m.version !== 'string' || !m.version || m.version.length > 100 || (pack === 'user' && !/^(0|[1-9]\d{0,14})$/.test(m.version)) || !Array.isArray(m.documents) || m.documents.length > 2000)
      fail('RESOURCE_INVALID', '未知或损坏的知识包格式。')
    const texts = new Map<string, string>(), paths = new Set<string>()
    for (const d of m.documents) {
      if (!d || !exact(d, ['id', 'path', 'title', 'source', 'scope', 'tags', 'sha256']) || typeof d.id !== 'string' || !validId(d.id) || texts.has(d.id) || typeof d.path !== 'string' || !/^cards\/[a-zA-Z0-9_.-]+\.md$/.test(d.path) || paths.has(d.path) || !/^[0-9a-f]{64}$/.test(d.sha256))
        fail('RESOURCE_INVALID', '知识卡元数据或路径无效。')
      const text = await this.text(pack, d.path, 100000)
      try {
        validateDraft({
          title: d.title, source: d.source, scope: d.scope, tags: d.tags, text
        })
      }
      catch {
        fail('RESOURCE_INVALID', '知识卡内容或元数据无效。')
      }
      if (!repair && hash(text) !== d.sha256)
        fail('RESOURCE_INVALID', `知识卡 ${d.id} 已在外部修改，请在知识库页签修复。`)
      texts.set(d.id, text)
      paths.add(d.path)
      if (repair)
        d.sha256 = hash(text)
    }
    return {
      manifest: m, texts, exists: true, raw
    }
  }

  /** 汇总有效目录和各包问题，避免一个包损坏影响另一包。 */
  async catalog(): Promise<KnowledgeCatalog> {
    const result: KnowledgeCatalog = {
      packs: [], issues: []
    }
    for (const pack of ['builtin', 'user'] as const)
      try {
        const loaded = await this.load(pack), m = loaded.manifest
        result.packs.push({
          packId: pack, packVersion: m.version, exists: loaded.exists, readOnly: pack === 'builtin', cards: m.documents.map(d => ({
            documentId: d.id, title: d.title, source: d.source, scope: d.scope, tags: d.tags, sha256: d.sha256, packId: pack, packVersion: m.version, version: m.version, readOnly: pack === 'builtin'
          }))
        })
        if (!loaded.exists)
          result.issues.push({
            packId: pack, code: 'NOT_FOUND', message: '用户知识库尚未创建或清单已丢失；保存知识卡后才会初始化。'
          })
      }
      catch (error) {
        result.issues.push({
          packId: pack, code: 'RESOURCE_INVALID', message: (error as Error).message
        })
      }
    return result
  }
  async read(pack: KnowledgePackId, id: string, expected: string | null, offset: number, length: number): Promise<KnowledgeRead> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 16000)
      fail('INVALID_ARGUMENT', '分页范围无效。')
    const { manifest: m, texts } = await this.load(pack)
    if (expected !== null && expected !== m.version)
      fail('VERSION_MISMATCH', '知识已更新，请重新读取。')
    const d = m.documents.find(d => d.id === id)
    if (!d)
      return fail('NOT_FOUND', '知识卡不存在。')
    return this.page(m, d, texts.get(id)!, offset, length)
  }
  /** 从指定版本快照生成 Unicode 分页，不重新读取文件系统。 */
  private page(manifest: Manifest, document: Document, text: string, offset: number, length: number): KnowledgeRead {
    const chars = Array.from(text), end = Math.min(offset + length, chars.length)
    if (offset > chars.length)
      fail('INVALID_ARGUMENT', 'offset 超出正文。')
    return {
      reference: {
        packId: manifest.packId, packVersion: manifest.version, documentId: document.id, sha256: document.sha256
      },
      title: document.title, source: document.source, scope: document.scope, tags: [...document.tags],
      text: chars.slice(offset, end).join(''), offset, length: end - offset,
      truncated: end < chars.length, nextOffset: end < chars.length ? end : null,
    }
  }

  /** 按归一化短语和中文双字候选评分，保留原始出处及正文。 */
  async search(query: string, limit: number, pack: 'all' | KnowledgePackId): Promise<KnowledgeSearchResult> {
    const normalize = (s: string) => s.normalize('NFKC').toLowerCase()
    if (typeof query !== 'string' || query.length > 500 || !/[\p{L}\p{N}]/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 20 || !['all', 'builtin', 'user'].includes(pack))
      fail('INVALID_ARGUMENT', '查询或数量无效。')
    const q = normalize(query.trim())
    const terms: string[] = q.match(/[\p{L}\p{N}]+/gu) ?? []
    for (const run of q.match(/[\p{Script=Han}]+/gu) ?? []) {
      const c = Array.from(run)
      for (let i = 0; i < c.length - 1; i++)
        terms.push(c.slice(i, i + 2).join(''))
    }
    const result: KnowledgeSearchResult = {
      hits: [], issues: []
    }, scored: {
      score: number
      hit: KnowledgeSearchResult['hits'][number]
    }[] = []
    for (const p of ['builtin', 'user'] as const) {
      if (pack !== 'all' && p !== pack)
        continue
      try {
        const { manifest: m, texts, exists } = await this.load(p)
        if (!exists)
          result.issues.push({
            packId: p, code: 'NOT_FOUND', message: '用户知识库尚未创建或清单已丢失。'
          })
        for (const d of m.documents) {
          const body = texts.get(d.id)!, title = normalize(d.title + ' ' + d.tags.join(' ')), full = normalize(body)
          const score = (title.includes(q) ? 100 : 0) + (full.includes(q) ? 30 : 0) + terms.reduce((n, t) => n + (title.includes(t) ? 10 : 0) + (full.includes(t) ? 1 : 0), 0)
          if (score)
            scored.push({
              score, hit: {
                reference: {
                  packId: p, packVersion: m.version, documentId: d.id, sha256: d.sha256
                }, title: d.title, source: d.source, scope: d.scope, excerpt: Array.from(body).slice(0, 500).join('')
              }
            })
        }
      }
      catch (error) {
        result.issues.push({
          packId: p, code: 'RESOURCE_INVALID', message: (error as Error).message
        })
      }
    }
    scored.sort((a, b) => b.score - a.score || a.hit.reference.packId.localeCompare(b.hit.reference.packId) || a.hit.reference.documentId.localeCompare(b.hit.reference.documentId))
    result.hits = scored.slice(0, limit).map(v => v.hit)
    return result
  }
  /** 替换清单前检查与读取器一致的格式和容量上限。 */
  private encode(manifest: Manifest): string {
    if (manifest.documents.length > 2000 || !/^(0|[1-9]\d{0,14})$/.test(manifest.version))
      fail('INVALID_ARGUMENT', '知识卡数量或知识版本达到上限。')
    const json = JSON.stringify(manifest, null, 2) + '\n'
    if (Buffer.byteLength(json, 'utf8') > 2000000)
      fail('INVALID_ARGUMENT', '知识清单超过 2MB 上限。')
    return json
  }
  private async removeTemporary(path: string): Promise<void> {
    try {
      await unlink(path)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.diagnostic(`知识临时文件清理失败：${path}：${String(error)}`)
    }
  }

  /** 核对外部变化后原子替换清单，旧正文在提交前保持有效。 */
  private async commit(loaded: Loaded): Promise<void> {
    const encoded = this.encode(loaded.manifest)
    const target = await this.safe('user', 'manifest.json')
    await mkdir(dirname(target), {
      recursive: true
    })
    const current = await this.load('user', true)
    if (current.raw !== loaded.raw)
      fail('VERSION_MISMATCH', '知识清单已在外部修改。')
    for (const d of current.manifest.documents)
      if (hash(current.texts.get(d.id)!) !== JSON.parse(current.raw!).documents.find((old: Document) => old.id === d.id).sha256)
        fail('RESOURCE_INVALID', '知识正文已在外部修改。')
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      await import('node:fs/promises').then(fs => fs.writeFile(temporary, encoded, {
        flag: 'wx'
      }))
      await rename(temporary, target)
    }
    finally {
      await this.removeTemporary(temporary)
    }
  }

  /** 以不可变正文保存用户卡，成功后返回本次提交的读取快照。 */
  async save(id: string | null, expected: string, draft: KnowledgeDraft, createId?: string): Promise<KnowledgeRead> {
    validateDraft(draft)
    const loaded = await this.load('user')
    if (loaded.manifest.version !== expected)
      fail('VERSION_MISMATCH', '用户知识库已更新。')
    if (id !== null && !loaded.texts.has(id))
      fail('NOT_FOUND', '知识卡不存在。')
    if (createId && loaded.texts.has(createId))
      fail('VERSION_MISMATCH', '新增目标已经存在。')
    const documentId = id ?? createId ?? randomUUID(), sha256 = hash(draft.text), path = `cards/${documentId}.${sha256}.md`, target = await this.safe('user', path)
    await mkdir(dirname(target), {
      recursive: true
    })
    await this.safe('user', path)
    let created = false
    try {
      try {
        const f = await open(target, 'wx')
        created = true
        try {
          await f.writeFile(draft.text, 'utf8')
        }
        finally {
          await f.close()
        }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw error
        if (await this.text('user', path, 100000) !== draft.text)
          fail('RESOURCE_INVALID', '目标正文与 hash 不符。')
      }
      loaded.manifest.documents = loaded.manifest.documents.filter(d => d.id !== documentId)
      const { text: _, ...metadata } = draft
      loaded.manifest.documents.push({
        id: documentId, path, ...metadata, sha256
      })
      loaded.manifest.version = String(Number(expected) + 1)
      await this.commit(loaded)
    }
    catch (error) {
      if (created)
        await this.cleanup({
          id: documentId, path, title: draft.title, source: draft.source, scope: draft.scope, tags: draft.tags, sha256
        })
      throw error
    }
    const previous = loaded.raw ? (JSON.parse(loaded.raw) as Manifest).documents.find(d => d.id === documentId) : undefined
    if (previous && previous.path !== path)
      await this.cleanup(previous)
    return this.page(loaded.manifest, loaded.manifest.documents.find(d => d.id === documentId)!, draft.text, 0, 16000)
  }

  /** 仅清理 hash 未变化的已知正文，失败写入诊断。 */
  private async cleanup(d: Document): Promise<void> {
    try {
      if (hash(await this.text('user', d.path, 100000)) === d.sha256)
        await unlink(await this.safe('user', d.path))
      else
        this.diagnostic(`知识卡清理已保留外部变化的文件：${d.path}`)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.diagnostic(`知识卡清理失败：${d.path}：${String(error)}`)
    }
  }
  async remove(id: string, expected: string): Promise<void> {
    const loaded = await this.load('user')
    if (loaded.manifest.version !== expected)
      fail('VERSION_MISMATCH', '知识库已更新。')
    const d = loaded.manifest.documents.find(d => d.id === id)
    if (!d)
      return fail('NOT_FOUND', '知识卡不存在。')
    loaded.manifest.documents = loaded.manifest.documents.filter(d => d.id !== id)
    loaded.manifest.version = String(Number(expected) + 1)
    await this.commit(loaded)
    await this.cleanup(d)
  }

  /** 由用户明确触发重算正文 hash，不猜测修复元数据。 */
  async repair(): Promise<KnowledgeCatalog> {
    const loaded = await this.load('user', true)
    if (!loaded.exists)
      fail('NOT_FOUND', '知识清单缺失，不能猜测恢复。')
    // 仅在用户明确修复时接受外部正文变化，保留已校验的元数据。
    const target = await this.safe('user', 'manifest.json'), temp = target + '.' + randomUUID() + '.tmp'
    const again = await this.load('user', true)
    if (again.raw !== loaded.raw || [...loaded.texts].some(([id, text]) => again.texts.get(id) !== text))
      fail('VERSION_MISMATCH', '修复期间知识已变化。')
    loaded.manifest.version = String(Number(loaded.manifest.version) + 1)
    const encoded = this.encode(loaded.manifest)
    try {
      await import('node:fs/promises').then(fs => fs.writeFile(temp, encoded, {
        flag: 'wx'
      }))
      await rename(temp, target)
    }
    finally {
      await this.removeTemporary(temp)
    }
    return this.catalog()
  }
}
