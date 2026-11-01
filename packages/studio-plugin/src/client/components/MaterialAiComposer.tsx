import { useState } from 'react'
import css from './material-confirmation.module.css'

/** Sends any material action to the current native AI session. */
export function MaterialAiComposer({ kind, busy, onSubmit }: {
  kind: 'scenario' | 'requirement'; busy: boolean; onSubmit(prompt: string): Promise<boolean>;
}) {
  const [prompt, setPrompt] = useState('')
  const material = kind === 'scenario' ? '场景' : '需求'
  const submit = async (value: string) => {
    if (!value.trim()) return
    if (await onSubmit(value.trim())) setPrompt('')
  }
  return <section className={css.aiComposer} aria-label={`AI ${material}操作`}>
    <div className={css.heading}><strong>交给 AI</strong><span>直接处理，或给出可执行方案</span></div>
    <form onSubmit={event => { event.preventDefault(); void submit(prompt) }}>
      <textarea required value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={`描述你想完成的${material}操作，例如：整理当前内容、处理待澄清项、检查并修改正文…`} />
      <div className={css.aiActions}>
        <button type="button" disabled={busy} onClick={() => void submit(`检查当前${material}，直接处理可以完善的部分，并说明还需要我决定什么。`)}>检查并完善</button>
        <button type="button" disabled={busy} onClick={() => void submit(`分析当前${material}的待澄清项和检查提示，逐项给出建议；可以确定的直接整理进写入提议。`)}>解决待办</button>
        <button className={css.aiPrimary} disabled={busy}>{busy ? '正在交给 AI…' : '发送给 AI'}</button>
      </div>
    </form>
  </section>
}
