/** Pure presentation helpers for the material editor; no React and no IO. */

import type { DraftSnapshot } from '../DraftBuffer.ts'

export type SaveStatus = 'composing' | 'applying' | 'saving' | 'dirty' | 'saved'

/** Locale key for each status, shared by the document header and screen readers. */
export type SaveStatusKey = 'composing' | 'applyingProposal' | 'saving' | 'dirty' | 'saved'

/** Status precedence: composing > applying > saving > unsaved > saved. */
export function saveStatus(snapshot: DraftSnapshot): SaveStatus {
  if (snapshot.composing) return 'composing'
  if (snapshot.applying) return 'applying'
  if (snapshot.saving) return 'saving'
  return snapshot.dirty ? 'dirty' : 'saved'
}

export function saveStatusKey(snapshot: DraftSnapshot): SaveStatusKey {
  const status = saveStatus(snapshot)
  return status === 'applying' ? 'applyingProposal' : status
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu

/** Counts CJK characters one each and runs of Latin letters or digits one each. */
export function countWords(text: string): number {
  let characters = 0
  const latin = text.replace(CJK, () => {
    characters += 1
    return ' '
  })
  const words = latin.match(/[A-Za-z0-9]+/gu)
  return characters + (words?.length ?? 0)
}

export function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length
}

/** File name shown in the document header and tree rows. */
export function displayName(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator >= 0 ? path.slice(separator + 1) : path
}

/** Versions are opaque handles; the status bar only needs a stable readable tail. */
export function versionTail(version: string): string {
  return version.length > 12 ? version.slice(-8) : version
}

/** Remote failures carry machine codes in `details`; returns undefined for plain errors. */
export function failureCode(error: unknown): string | undefined {
  const details = (error as { details?: { code?: unknown } } | null | undefined)?.details
  return typeof details?.code === 'string' ? details.code : undefined
}
