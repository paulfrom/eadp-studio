/**
 * 转换 worker 的独立入口：在独立线程里解析文件，避免阻塞 Host 事件循环。
 *
 * 只读取 `workerData`、调用 `convertFile`、回传结果；不接触存储、上下文、
 * 模型或网络。启动方在另一个线程创建它，并把这里当作不可信边界校验输入。
 */
import { parentPort, workerData } from 'node:worker_threads'
import type { ConvertInput, ConvertWorkerResult } from './blocks.ts'
import { diagnosticOf } from './failure.ts'
import { convertFile } from './index.ts'

interface WorkerInput {
  fileName?: unknown
  fileTypeHint?: unknown
  bytes?: unknown
}

function invalidResult(diagnostic: string): ConvertWorkerResult {
  return {
    ok: false,
    code: 'PARSE_FAILED',
    problem: '文件内容无法读取，可能已损坏；可以查看原件、重试或手工整理成文档。',
    diagnostic,
  }
}

/** worker 是跨线程边界：先校验输入，再交给转换入口。 */
function readInput(): ConvertInput | ConvertWorkerResult {
  const data: WorkerInput = workerData ?? {}
  if (typeof data.fileName !== 'string' || data.fileName === '') return invalidResult('workerData.fileName is missing')
  if (!(data.bytes instanceof Uint8Array)) return invalidResult('workerData.bytes is not a Uint8Array')
  const input: ConvertInput = { fileName: data.fileName, bytes: data.bytes }
  if (typeof data.fileTypeHint === 'string') input.fileTypeHint = data.fileTypeHint
  return input
}

function isWorkerInput(value: ConvertInput | ConvertWorkerResult): value is ConvertInput {
  return 'bytes' in value
}

const port = parentPort
if (port !== null) {
  const input = readInput()
  let result: ConvertWorkerResult
  try {
    result = isWorkerInput(input) ? await convertFile(input) : input
  }
  catch (error) {
    result = invalidResult(diagnosticOf(error))
  }
  port.postMessage(result)
}
