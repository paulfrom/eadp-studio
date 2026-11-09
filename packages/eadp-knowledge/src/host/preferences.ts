import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface SessionPreferencesFile {
  schemaVersion: 1
  /** 只记录被关闭的会话；缺省即开启，避免每个会话都堆积一条记录。 */
  autoReference: Record<string, false>
}

const EMPTY: SessionPreferencesFile = { schemaVersion: 1, autoReference: {} }
const MAX_SESSION_ID = 200

/**
 * 需求会话的“自动参考知识”开关。开关是业务偏好，不进入资料内容身份；
 * 只保存关闭的会话，读取时失败按默认开启处理并写诊断，不删除未知文件。
 */
export class SessionPreferences {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly root: string, private readonly diagnostic: (message: string) => void) {}

  private get file(): string {
    return join(this.root, 'preferences.json')
  }

  private async read(): Promise<SessionPreferencesFile> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY
      this.diagnostic(`自动参考开关读取失败：${String(error)}`)
      return EMPTY
    }
    try {
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null) throw new Error('not an object')
      const record = value as Record<string, unknown>
      if (record['schemaVersion'] !== 1 || typeof record['autoReference'] !== 'object' || record['autoReference'] === null) throw new Error('unsupported preferences')
      const autoReference: Record<string, false> = {}
      for (const [sessionId, disabled] of Object.entries(record['autoReference'] as Record<string, unknown>)) {
        if (sessionId.length > MAX_SESSION_ID || disabled !== false) continue
        autoReference[sessionId] = false
      }
      return { schemaVersion: 1, autoReference }
    } catch (error) {
      this.diagnostic(`自动参考开关内容无效，按开启处理：${String(error)}`)
      return EMPTY
    }
  }

  async autoReference(sessionId: string): Promise<boolean> {
    const preferences = await this.read()
    return preferences.autoReference[sessionId] !== false
  }

  setAutoReference(sessionId: string, enabled: boolean): Promise<void> {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_SESSION_ID) throw new Error('会话标识无效。')
    const next = this.tail.then(async () => {
      const preferences = await this.read()
      if (enabled) delete preferences.autoReference[sessionId]
      else preferences.autoReference[sessionId] = false
      await mkdir(this.root, { recursive: true })
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(preferences, null, 2) + '\n')
      await rename(temporary, this.file)
    })
    this.tail = next.catch(() => {
      /* 保留队列继续执行；失败由调用方收到。 */
    })
    return next
  }
}
