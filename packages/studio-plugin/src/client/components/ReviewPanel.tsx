import { useState } from 'react'
import type { ConfirmationChoice, StudioState } from '../../shared/studio.ts'
import css from '../studio.module.css'

type Review = StudioState['reviews'][number]
export function ReviewPanel({ review, purpose, busy, onRequest, onConfirm }: {
  review: Review | undefined; purpose: 'material' | 'prototype'; busy: boolean;
  onRequest(): void; onConfirm(choice: Extract<ConfirmationChoice, { method: 'ai-assisted' }>): void;
}) {
  const [disposition, setDisposition] = useState({ reviewId: review?.id, value: '' })
  const authorDisposition = disposition.reviewId === review?.id ? disposition.value : ''
  const pending = review?.status === 'pending'
  const label = purpose === 'material' ? '材料' : '原型'
  return <details className="max-h-72 shrink-0 overflow-y-auto border-t border-slate-200 bg-slate-50 px-3 py-2.5" aria-label={`${label} AI辅助评审`}>
    <summary className="cursor-pointer text-[11px] font-semibold text-slate-700">AI辅助评审 <span className="ml-1 font-normal text-slate-500">{pending ? '正在评审…' : review?.status === 'reported' ? '意见已返回，待作者处理' : review?.status === 'failed' ? '未完成，可重新发起' : '可选'}</span></summary>
    <div className="flex flex-col gap-2 pt-2 text-[11px] text-slate-600">
      <div className="flex items-center justify-between gap-3"><p>AI提供检查意见，由你处理并确认；也可以直接确认当前版本。</p><button type="button" disabled={busy || pending} onClick={onRequest}>AI辅助评审</button></div>
      <p className="text-[10px] text-slate-500">修改当前{label}后，本报告失效，需要重新评审。</p>
      {pending && <p role="status">正在检查当前{label}，结果返回后才能按评审意见确认。</p>}
      {review?.status === 'failed' && <p role="alert" className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">{review.error ?? '评审未完成，请重新发起。'}</p>}
      {review?.status === 'reported' && <>
        <div className="rounded border border-slate-200 bg-white p-2.5"><h3 className="font-semibold text-slate-700">评审结论</h3><p className="mt-1 whitespace-pre-wrap">{review.summary}</p>
          {!!review.findings?.length && <ul className="mt-2 space-y-1.5">{review.findings.map((finding, index) => <li key={index} className="flex gap-2"><span className={`shrink-0 ${finding.severity === 'blocking' ? 'text-red-700' : finding.severity === 'warning' ? 'text-amber-700' : 'text-slate-500'}`}>{finding.severity === 'blocking' ? '需处理' : finding.severity === 'warning' ? '建议' : '提示'}</span><span className="whitespace-pre-wrap">{finding.message}</span></li>)}</ul>}
        </div>
        <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (!busy && authorDisposition.trim()) onConfirm({ method: 'ai-assisted', reviewId: review.id, authorDisposition: authorDisposition.trim() }) }}>
          <label>作者处理说明<textarea required rows={2} value={authorDisposition} onChange={event => setDisposition({ reviewId: review.id, value: event.target.value })} placeholder="说明已处理的意见，以及保留意见的原因。" /></label>
          <button className={css.primary} disabled={busy || !authorDisposition.trim()}>处理评审意见并确认当前版本</button>
        </form>
      </>}
    </div>
  </details>
}
