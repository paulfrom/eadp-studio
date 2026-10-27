import { useState } from 'react'
import type { DraftBuffer, DraftSnapshot } from './DraftBuffer.ts'
import { DiffBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { diffLabels } from './document.ts'
import css from '../studio.module.css'

/**
 * States that the editor already shows the file's newest content. Unsaved input
 * an external edit replaced stays recoverable here instead of blocking the load.
 */
export function ExternalFileNotice({ buffer, snapshot, readOnly }: { buffer: DraftBuffer; snapshot: DraftSnapshot; readOnly: boolean }) {
  const [comparing, setComparing] = useState(false)
  const latest = snapshot.externalUpdates.at(-1)
  if (!latest && !snapshot.external) return null
  return <section className={css.externalNotice} aria-label="文件外部更新">
    {latest ? <>
      <span>文件已被外部修改，工作台已加载最新内容；你此前未保存的输入仍可恢复。</span>
      <button type="button" disabled={readOnly} onClick={() => buffer.undoExternal(latest)}>恢复未保存输入</button>
    </> : <span>已加载文件的最新内容。</span>}
    <button type="button" onClick={() => setComparing(value => !value)}>{comparing ? '收起改动' : '查看改动'}</button>
    {!latest && !comparing && <button type="button" onClick={() => buffer.clearExternal()}>关闭提示</button>}
    {comparing && <DiffBlock diffs={[{ path: (latest?.draft ?? snapshot.external)!.path, oldText: latest?.replaced.body ?? '', newText: (latest?.draft ?? snapshot.external)!.body }]} labels={diffLabels} />}
  </section>
}
