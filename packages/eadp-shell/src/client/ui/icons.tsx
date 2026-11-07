/**
 * 16px linear icon set. Glyphs are inlined SVG paths; no icon package is
 * bundled into the Client closure and every icon is decorative (`aria-hidden`).
 */
import type { ReactElement, ReactNode } from 'react'

interface IconProps {
  /** Rendered square size in pixels; defaults to 16. */
  size?: number
}

function glyph(size: number | undefined, children: ReactNode): ReactElement {
  const dimension = size ?? 16
  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false">
      {children}
    </svg>
  )
}

export function IconFile({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <path d="M7 3.5h6.5l4 4v12.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
    <path d="M13.5 3.5v4h4" />
  </>)
}

export function IconFolder({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6l1.6 1.6a2 2 0 0 0 1.4.6h4.4a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    <path d="M3.5 9.5h17" />
  </>)
}

export function IconFolderOpen({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <path d="M3.5 8.5a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6l1.6 1.6a2 2 0 0 0 1.4.6h3.9a2 2 0 0 1 2 2v1" />
    <path d="M3.5 10.5h16.2l-2 8.6a2 2 0 0 1-2 1.6H5.4a2 2 0 0 1-2-1.6z" />
  </>)
}

export function IconPlus({ size }: IconProps): ReactElement {
  return glyph(size, <path d="M12 5v14M5 12h14" />)
}

export function IconMore({ size }: IconProps): ReactElement {
  return glyph(size, <path d="M5 12h.01M12 12h.01M19 12h.01" />)
}

export function IconSearch({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.6-3.6" />
  </>)
}

export function IconClose({ size }: IconProps): ReactElement {
  return glyph(size, <path d="m6 6 12 12M18 6 6 18" />)
}

export function IconCheck({ size }: IconProps): ReactElement {
  return glyph(size, <path d="m5 12.5 4.5 4.5L19 7.5" />)
}

export function IconSave({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <path d="M5 3.5h11l3 3V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z" />
    <path d="M8 3.5v5.5h7V3.5M8 20.5v-6h8v6" />
  </>)
}

export function IconChevronRight({ size }: IconProps): ReactElement {
  return glyph(size, <path d="m9 6 6 6-6 6" />)
}

export function IconChevronDown({ size }: IconProps): ReactElement {
  return glyph(size, <path d="m6 9 6 6 6-6" />)
}

export function IconAlert({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <path d="M12 4 2.8 19.5h18.4L12 4z" />
    <path d="M12 9.5v5" />
    <path d="M12 17h.01" />
  </>)
}

export function IconInfo({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <path d="M12 7.5h.01" />
  </>)
}

export function IconTrash({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <path d="M4.5 6.5h15" />
    <path d="M9.5 6.5V4.5h5v2" />
    <path d="M6.5 6.5 7.4 20a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13.5" />
    <path d="M10.5 10.5v6.5M13.5 10.5v6.5" />
  </>)
}

export function IconPencil({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
    <path d="m14.5 7.5 2 2" />
  </>)
}

export function IconRefresh({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <path d="M19.5 5.5v5h-5" />
    <path d="M18.8 10.5A7.5 7.5 0 1 0 19 15" />
  </>)
}

export function IconSparkles({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <path d="M12 3.5 13.7 9 19 10.7 13.7 12.4 12 18l-1.7-5.6L5 10.7 10.3 9z" />
    <path d="M18.5 15.5v3M17 17h3" />
  </>)
}

export function IconChat({ size }: IconProps): ReactElement {
  return glyph(size, <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-5 4z" />)
}

export function IconPanelRight({ size }: IconProps): ReactElement {
  return glyph(size, <>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <path d="M14.5 5v14" />
  </>)
}
