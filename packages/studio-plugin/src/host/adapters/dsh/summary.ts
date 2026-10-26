import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'

/** A one-shot summary call has no Session log, Agent, tools, or filesystem authority. */
export async function summarizeText(ctx: Context, input: { subject: string; facts: string }, signal: AbortSignal): Promise<string> {
  const call = await ctx.llm.prepareCall({ ...ctx.agentDefaultModel.currentSelection(), maxTokens: 1024 }, signal)
  const assembler = new BlockAssembler()
  let finished = false
  for await (const chunk of call.stream({ ...call.config, signal, tools: [],
    system: '用不超过120字中文概括输入的本地材料变更事实。仅依据输入，不编造未提供的内容，直接输出摘要文本。',
    messages: [{ role: 'user', content: [{ type: 'text', text: `${input.subject}\n${input.facts}` }] }],
  })) { signal.throwIfAborted(); if (chunk.type === 'finish') finished = true; assembler.push(chunk) }
  signal.throwIfAborted()
  if (!finished || assembler.finish.kind !== 'stop' || assembler.blocks().some(block => block.type === 'tool-call')) throw new Error('状态摘要未产生完整文本结果')
  return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('\n')
}
