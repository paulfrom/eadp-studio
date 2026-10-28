import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TaskView } from '../../../shared/studio.ts'
import type { PrototypeMaterialContext } from '../../application/prototype-material-context.ts'

/** Register read-only project materials in the owning native prototype session. */
export function registerPrototypeMaterialTools(scope: Context, agent: AgentHandle['agent'], task: TaskView, materials: PrototypeMaterialContext): void {
  scope.systemPrompt.section({ name: 'eadp-prototype-materials', order: 70, text: '需求目录只提供身份和可用来源，不代表已读取正文。需要业务依据时先查询目录，再按需求实际读取草稿或已确认材料；草稿不可当作已确认材料。不要修改或确认需求材料。', interpolate: false })
  scope.tools.register(defineTool({
    name: 'prototype_requirement_catalog',
    description: '列出当前项目中本人有权读取的需求身份及可用草稿/已确认版本，不读取正文。',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { result: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    execute: async (_args, exec) => {
      if (exec.agent !== agent) throw new Error('需求目录只对所属原型会话开放')
      exec.signal.throwIfAborted()
      const value = await materials.catalog(task)
      exec.signal.throwIfAborted()
      return { result: JSON.stringify(value) }
    },
  }))
  scope.tools.register(defineTool({
    name: 'prototype_read_requirement',
    description: '只读指定需求的本人草稿或已确认版本正文，并返回实际范围及内容身份。',
    parameters: {
      requirementId: { type: 'string', required: true, description: '需求目录中可读的需求 ID。' },
      source: { type: 'string', required: true, enum: ['draft', 'accepted'], description: '读取本人草稿或已确认版本。' },
      startLine: { type: 'integer', description: '正文起始行，从 1 开始。' },
      count: { type: 'integer', description: '本次读取的行数，最多 200。' },
    },
    output: {
      schema: { type: 'object', properties: { result: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    execute: async (args, exec) => {
      if (exec.agent !== agent) throw new Error('需求正文只对所属原型会话开放')
      exec.signal.throwIfAborted()
      const value = await materials.read(task, args.requirementId, args.source, args.startLine ?? 1, args.count ?? 100)
      exec.signal.throwIfAborted()
      const { content: _content, totalLines: _totalLines, truncated: _truncated, ...receipt } = value
      await materials.record(receipt)
      exec.signal.throwIfAborted()
      return { result: JSON.stringify(value) }
    },
  }))
}
