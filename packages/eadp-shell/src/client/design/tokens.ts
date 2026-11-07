/**
 * EADP design tokens. Values are ported from the SATA-licensed dsh-editor
 * design system (packages/dsh-editor-shell/src/design-system/tokens.ts); only
 * the keys this workbench consumes are kept. The rendering counterpart is
 * `design/tokens.module.css`, which declares the same values as `--eadp-*`
 * custom properties for the light theme and `body[data-ds-dark-theme]` for the
 * dark theme; keep both files in sync when a value changes.
 *
 * This module is the typed, programmatic source. Components consume the CSS
 * variables, never these maps, so a token value changes in one place per theme.
 */

/** Light-theme color and elevation values. */
export const LIGHT_TOKENS = {
  bg: '#F7F8F4',
  surface: '#EEF1EC',
  raised: '#FFFFFF',
  text: '#1E2420',
  muted: '#5C655E',
  faint: '#656E67',
  line: 'rgba(30, 36, 32, 0.10)',
  'line-strong': 'rgba(30, 36, 32, 0.18)',
  hover: 'rgba(30, 36, 32, 0.06)',
  selected: 'rgba(46, 79, 122, 0.12)',
  accent: '#2E4F7A',
  'accent-hover': '#233D5F',
  'accent-soft': 'rgba(46, 79, 122, 0.10)',
  'accent-border': 'rgba(46, 79, 122, 0.32)',
  'on-accent': '#FFFFFF',
  marker: '#B23A2A',
  success: '#2F6B3F',
  'success-soft': '#E3F0E5',
  warning: '#8A5A12',
  'warning-soft': '#F6EEDC',
  danger: '#A8322A',
  'danger-soft': '#F7E4E1',
  scrim: 'rgba(16, 20, 18, 0.48)',
  'menu-fill': '#FFFFFF',
  'elevation-soft': '0 0 0 0.5px rgba(30, 36, 32, 0.16)',
  'elevation-panel': '0 0 0 0.5px rgba(30, 36, 32, 0.18), 0 6px 20px rgba(30, 36, 32, 0.08)',
  'elevation-prominent': '0 0 0 0.5px rgba(30, 36, 32, 0.20), 0 12px 32px rgba(30, 36, 32, 0.12)',
} as const

/** Dark-theme values; the key set must stay identical to {@link LIGHT_TOKENS}. */
export const DARK_TOKENS: Record<keyof typeof LIGHT_TOKENS, string> = {
  bg: '#1C201D',
  surface: '#202521',
  raised: '#252A26',
  text: '#DADFD6',
  muted: '#97A096',
  faint: '#8A938A',
  line: 'rgba(218, 223, 214, 0.10)',
  'line-strong': 'rgba(218, 223, 214, 0.18)',
  hover: 'rgba(218, 223, 214, 0.06)',
  selected: 'rgba(143, 176, 222, 0.16)',
  accent: '#8FB0DE',
  'accent-hover': '#A9C3E8',
  'accent-soft': 'rgba(143, 176, 222, 0.14)',
  'accent-border': 'rgba(143, 176, 222, 0.36)',
  'on-accent': '#14181B',
  marker: '#E07A68',
  success: '#7CC78F',
  'success-soft': '#1F3326',
  warning: '#E0B060',
  'warning-soft': '#332A1A',
  danger: '#F08A7E',
  'danger-soft': '#3A1F1C',
  scrim: 'rgba(0, 0, 0, 0.55)',
  'menu-fill': '#252A26',
  'elevation-soft': '0 0 0 0.5px rgba(218, 223, 214, 0.18)',
  'elevation-panel': '0 0 0 0.5px rgba(218, 223, 214, 0.18), 0 6px 20px rgba(0, 0, 0, 0.35)',
  'elevation-prominent': '0 0 0 0.5px rgba(218, 223, 214, 0.20), 0 12px 32px rgba(0, 0, 0, 0.45)',
}
