import type { ConvertFailureCode } from './blocks.ts'

/**
 * 解析器内部使用的转换失败。
 *
 * `problem` 面向用户并说明还能做什么，`diagnostic` 保留技术细节；
 * `message` 只是给日志和诊断用的简短说明，不直接展示给用户。
 */
export class ConvertFailure extends Error {
  constructor(
    readonly code: ConvertFailureCode,
    message: string,
    readonly problem: string,
    readonly diagnostic: string,
  ) {
    super(message)
    this.name = 'ConvertFailure'
  }
}

/** 明确无法自动整理（格式不受支持、图片、旧版 Office 等）。 */
export function unsupported(problem: string, diagnostic: string): never {
  throw new ConvertFailure('UNSUPPORTED', problem, problem, diagnostic)
}

/** 文件可识别但解析失败（损坏、加密、结构超限等）。 */
export function parseFailed(problem: string, diagnostic: string): never {
  throw new ConvertFailure('PARSE_FAILED', problem, problem, diagnostic)
}

/** 文件有效但没有可整理的正文。 */
export function emptyDocument(problem: string, diagnostic: string): never {
  throw new ConvertFailure('EMPTY', problem, problem, diagnostic)
}

/** 把未知错误整理成诊断文本；不带用户文案，只用于诊断入口。 */
export function diagnosticOf(error: unknown): string {
  if (error instanceof ConvertFailure) return error.diagnostic
  if (error instanceof Error) {
    const stack = error.stack?.split('\n').slice(0, 6).join('\n')
    return `${error.name}: ${error.message}${stack ? `\n${stack}` : ''}`
  }
  return String(error)
}
