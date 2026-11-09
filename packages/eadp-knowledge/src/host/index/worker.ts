/**
 * 索引 worker 的独立入口：持有 SQLite 连接，执行切片、词项、发布与查询。
 *
 * 只接收 Host 已核对的消息，不接触存储、上下文、模型或网络；跨线程边界只回传
 * 纯数据或错误文本。消息串行处理，单连接读写不需要额外并发协议。
 */
import { rmSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { IndexDatabase } from './database.ts'
import type { WorkerOptions, WorkerRequest, WorkerResponse } from './protocol.ts'

/** SQLite 损坏类错误：明确诊断后重建衍生库；暂时性 I/O 错误不删除数据库。 */
const CORRUPTION = /SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database|database disk image is malformed/i

/** worker 启动参数来自 Host；跨线程边界先校验类型。 */
function readOptions(value: unknown): WorkerOptions {
  if (typeof value !== 'object' || value === null) throw new Error('索引线程参数缺失。')
  const options = value as { dbPath?: unknown; processingSignature?: unknown }
  if (typeof options.dbPath !== 'string' || options.dbPath === '') throw new Error('索引库路径无效。')
  if (typeof options.processingSignature !== 'string' || options.processingSignature === '') throw new Error('索引处理签名无效。')
  return { dbPath: options.dbPath, processingSignature: options.processingSignature }
}

/**
 * 打开索引库；只在确认是损坏时丢弃衍生库重建一次，其他错误原样上报。
 * @param options - 库路径与处理签名。
 * @returns 已迁移的索引库。
 */
function openDatabase(options: WorkerOptions): IndexDatabase {
  try {
    return new IndexDatabase(options.dbPath, options.processingSignature)
  } catch (error) {
    if (!CORRUPTION.test(messageOf(error))) throw error
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${options.dbPath}${suffix}`, { force: true })
    return new IndexDatabase(options.dbPath, options.processingSignature)
  }
}

/** 按请求类型执行一次操作；未知类型直接失败，不猜测语义。 */
function handle(request: WorkerRequest, database: IndexDatabase): unknown {
  switch (request.type) {
    case 'open':
      return database.openResult()
    case 'state':
      return database.documentState(request.packId, request.documentId)
    case 'build':
      return database.stage(request.job, request.document, request.reuseGenerationId)
    case 'publish':
      database.publish(request.job, request.buildId)
      return null
    case 'discard':
      database.discard(request.buildId)
      return null
    case 'refresh':
      database.refresh(request.job, request.document)
      return null
    case 'drop':
      database.drop(request.packId, request.documentId)
      return null
    case 'fail-job':
      database.failJob(request.job, request.packId, request.documentId, request.error)
      return null
    case 'search':
      return database.search(request.query)
    case 'dispose':
      database.close()
      return null
  }
}

/** 取出错误文本；跨线程只传说明，不传 Error 实例。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const port = parentPort
if (port !== null) {
  let database: IndexDatabase | null = null
  let startupError = ''
  try {
    const options = readOptions(workerData)
    database = openDatabase(options)
  } catch (error) {
    startupError = messageOf(error)
  }
  port.on('message', (message: WorkerRequest) => {
    if (typeof message !== 'object' || message === null || typeof message.id !== 'number') return
    let response: WorkerResponse
    if (database === null) {
      response = { id: message.id, ok: false, error: startupError }
    } else {
      try {
        response = { id: message.id, ok: true, result: handle(message, database) }
      } catch (error) {
        response = { id: message.id, ok: false, error: messageOf(error) }
      }
    }
    port.postMessage(response)
  })
}
