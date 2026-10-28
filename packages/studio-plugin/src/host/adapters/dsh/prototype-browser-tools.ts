import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import type { TaskView } from '../../../shared/studio.ts'
import type { PrototypeBrowserAttachmentStore } from '../../prototype/browser-attachments.ts'
import { PrototypeBrowserProvider, type PrototypeBrowserCommand } from '../../prototype/browser-provider.ts'
import type { PrototypeBrowserScope } from '../../prototype/browser-scope.ts'

interface Options {
  runtime?: { root: string; manifest: string; manifestSha256: string }
  unavailable?: string
  attachments: PrototypeBrowserAttachmentStore
  scope(task: TaskView, validationRunId: string): Promise<PrototypeBrowserScope | undefined>
}
interface BrowserRun { task: TaskView; pending: Promise<PrototypeBrowserProvider> }

/** Owns one fenced browser capability per native task session. */
export class PrototypeBrowserTools {
  private readonly runs = new Map<string, BrowserRun>()
  constructor(private readonly options: Options) {}

  private async current(task: TaskView, runId: string): Promise<PrototypeBrowserScope> {
    const scope = await this.options.scope(task, runId)
    if (!scope) throw new Error('当前事项没有可用于验证的受管预览')
    return scope
  }

  private async provider(task: TaskView, signal: AbortSignal): Promise<PrototypeBrowserProvider> {
    const existing = this.runs.get(task.sessionId)
    if (existing) return existing.pending
    if (!this.options.runtime) throw new Error(this.options.unavailable ?? '受信浏览器运行时尚未随产品安装')
    const validationRunId = randomUUID(), scope = await this.current(task, validationRunId)
    const record: BrowserRun = { task, pending: PrototypeBrowserProvider.open({
      scope, current: () => this.options.scope(task, validationRunId), runtime: this.options.runtime!, headless: true, signal,
      attach: (current, kind, bytes) => this.options.attachments.attach(current, kind, bytes),
      captureTrace: (current, write) => this.options.attachments.captureTrace(current, write),
    }) }
    this.runs.set(task.sessionId, record)
    try {
      const provider = await record.pending
      if (this.runs.get(task.sessionId) !== record) { await provider.close(); throw new Error('浏览器能力已在启动期间撤销') }
      return provider
    } catch (error) {
      if (this.runs.get(task.sessionId) === record) this.runs.delete(task.sessionId)
      throw error
    }
  }

  /** Register bounded business actions; arbitrary scripts, origins and executable paths are absent. */
  register(scope: Context, agent: AgentHandle['agent'], task: TaskView): void {
    scope.tools.register(defineTool({
      name: 'prototype_browser',
      description: '在当前事项的受管预览中执行受限业务操作。先运行预览，再使用定位器执行打开、点击、填写、断言、截图或 trace；不能执行脚本或访问其他地址。',
      parameters: {
        action: { type: 'string', required: true, enum: ['open', 'click', 'fill', 'select', 'key', 'wait', 'assert', 'snapshot', 'screenshot', 'diagnostics', 'trace'] },
        route: { type: 'string', description: 'open 动作的原型内路由，以 / 开头。' },
        target: { type: 'object', additionalProperties: false, properties: {
          by: { type: 'string', enum: ['role', 'label', 'testId'] },
          role: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' },
        } },
        value: { type: 'string', description: 'fill/select 的输入值。' },
        key: { type: 'string', enum: ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'] },
        state: { type: 'string', enum: ['visible', 'hidden'] },
        condition: { type: 'string', enum: ['visible', 'text', 'value'] },
        expected: { type: 'string' },
        durationMs: { type: 'integer', description: 'trace 时长，100–5000 ms。' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args, exec) => {
        if (exec.agent !== agent) throw new Error('浏览器能力只对所属原型会话开放')
        exec.signal.throwIfAborted()
        const provider = await this.provider(task, exec.signal)
        const command = { action: args.action, ...(args.route !== undefined ? { route: args.route } : {}), ...(args.target !== undefined ? { target: args.target } : {}),
          ...(args.value !== undefined ? { value: args.value } : {}), ...(args.key !== undefined ? { key: args.key } : {}), ...(args.state !== undefined ? { state: args.state } : {}),
          ...(args.condition !== undefined ? { condition: args.condition } : {}), ...(args.expected !== undefined ? { expected: args.expected } : {}), ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}) } as PrototypeBrowserCommand
        return JSON.stringify(await provider.execute(command, exec.signal))
      },
    }))
  }

  async close(sessionId: string): Promise<void> {
    const record = this.runs.get(sessionId)
    if (!record) return
    this.runs.delete(sessionId)
    const provider = await record.pending.catch(() => undefined)
    await provider?.close()
  }

  async dispose(): Promise<void> {
    const ids = [...this.runs.keys()]
    const results = await Promise.allSettled(ids.map(id => this.close(id)))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '原型浏览器未能完整关闭')
  }
}
