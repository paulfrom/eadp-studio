/**
 * Shared per-segment file-name rules for every project-local path seam.
 * Each seam keeps its own root policy (需求/, 原型/, template allowances) and
 * hidden-name lists; the shape checks below are identical and must not drift.
 */
export const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu
export const ILLEGAL_NAME_CHARACTERS = /[<>:"|?*\x00-\x1f]/u
export const TRAILING_DOT_OR_SPACE = /[ .]$/u

export type PathRejection =
  | 'invalid-path'
  | 'backslash'
  | 'segment-empty'
  | 'segment-dot'
  | 'segment-too-long'
  | 'illegal-characters'
  | 'trailing-dot-or-space'
  | 'windows-reserved'

export interface PathPolicyOptions {
  /** Maximum total path length; omitted means no length limit. */
  maxPathLength?: number
  /** Maximum single segment length; omitted means no length limit. */
  maxNameLength?: number
  /** Accepts '' as an empty path (directory roots). */
  allowEmpty?: boolean
}

export type PathNamesResult = { ok: true; names: string[] } | { ok: false; reason: PathRejection }

/** Validates path shape only; callers map rejections onto their own error types and messages. */
export function checkPathNames(value: unknown, options: PathPolicyOptions = {}): PathNamesResult {
  if (typeof value !== 'string' || (options.maxPathLength !== undefined && value.length > options.maxPathLength))
    return { ok: false, reason: 'invalid-path' }
  if (value.includes('\\')) return { ok: false, reason: 'backslash' }
  if (value === '') {
    if (options.allowEmpty) return { ok: true, names: [] }
    return { ok: false, reason: 'segment-empty' }
  }
  const names = value.split('/')
  for (const name of names) {
    if (!name) return { ok: false, reason: 'segment-empty' }
    if (name === '.' || name === '..') return { ok: false, reason: 'segment-dot' }
    if (options.maxNameLength !== undefined && name.length > options.maxNameLength) return { ok: false, reason: 'segment-too-long' }
    if (ILLEGAL_NAME_CHARACTERS.test(name)) return { ok: false, reason: 'illegal-characters' }
    if (TRAILING_DOT_OR_SPACE.test(name)) return { ok: false, reason: 'trailing-dot-or-space' }
    if (WINDOWS_RESERVED_NAME.test(name)) return { ok: false, reason: 'windows-reserved' }
  }
  return { ok: true, names }
}
