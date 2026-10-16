import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { STUDIO_FRAME_EDIT } from '../../apps/desktop-distribution/build/studio-frame-edits.mjs'

const upstream = path.resolve(import.meta.dirname, '../../.local/upstream/dsh')
const appFrame = await readFile(path.join(upstream, 'packages/client/ui-layout/src/client/AppFrame.tsx'), 'utf8')
const columnsSource = await readFile(path.join(upstream, 'packages/client/ui-layout/src/client/columns.ts'), 'utf8')
const computeColumns = new Function(`${stripTypeScriptTypes(columnsSource)
  .replace(/export interface Columns[\s\S]*?\n}\n/, '')
  .replace(/export const/g, 'const')
  .replace(/export function /g, 'function ')}; return computeColumns`)()

// The patched geometry block, evaluated with the same stubs the component would have.
function geometry(source, { panelId, viewport = 1600, sidebar = 280, narrowExpanded = false }) {
  const start = source.indexOf('  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE')
  const endMarker = ': SIDEBAR_COLLAPSED'
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, 'geometry block must exist')
  const block = source.slice(start, end + endMarker.length)
  const run = new Function('usePanelInfo', 'viewport', 'layoutInfo', 'document', `
    const SIDEBAR_AUTO_COLLAPSE = 1024
    const SIDEBAR_DEFAULT = 280
    const RIGHTBAR_DEFAULT_RATIO = 0.45
    const SIDEBAR_COLLAPSED = 56
    ${stripTypeScriptTypes(block)}
    return { sidebarCollapsed, sidebarPreference, collapsedWidth }
  `)
  return run(
    (select) => select({ activePanelId: panelId }),
    viewport,
    { sidebar, narrowExpanded },
    { documentElement: { dataset: {}, hasAttribute: () => false } },
  )
}

test('upstream shell keeps the sidebar column for every main panel', () => {
  const result = geometry(appFrame, { panelId: 'studio' })
  assert.equal(result.sidebarCollapsed, false)
  assert.equal(result.collapsedWidth, 56)
  assert.ok(computeColumns(1600, result.sidebarPreference, 0, result.collapsedWidth).sidebar > 0)
})

test('studio panel closes the shell sidebar column entirely', () => {
  const edited = STUDIO_FRAME_EDIT.apply(appFrame)
  const result = geometry(edited, { panelId: 'studio' })
  assert.equal(result.sidebarCollapsed, true)
  assert.equal(result.collapsedWidth, 0)
  assert.equal(computeColumns(1600, result.sidebarPreference, 0, result.collapsedWidth).sidebar, 0)
  assert.ok(edited.includes("activePanelId !== 'studio' && <div className={css.sidebarCol}>"))
})

test('other panels keep upstream sidebar behavior', () => {
  const edited = STUDIO_FRAME_EDIT.apply(appFrame)
  const conversation = geometry(edited, { panelId: 'conversation' })
  assert.equal(conversation.sidebarCollapsed, false)
  assert.equal(conversation.collapsedWidth, 56)
  const narrow = geometry(edited, { panelId: 'conversation', viewport: 800 })
  assert.equal(narrow.sidebarCollapsed, true)
})

test('frame edit is idempotent, byte-reversible, and fails on anchor drift', () => {
  const edited = STUDIO_FRAME_EDIT.apply(appFrame)
  assert.equal(STUDIO_FRAME_EDIT.apply(edited), edited)
  assert.throws(() => STUDIO_FRAME_EDIT.apply('upstream drift'), /anchor missing or duplicated/)
  assert.throws(() => STUDIO_FRAME_EDIT.apply(`${appFrame}\n  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE\n  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0`), /anchor missing or duplicated/)
  // Outside the three patched regions the file stays byte-for-byte upstream.
  let reversed = edited
  for (const [before, after] of STUDIO_FRAME_EDIT.pairs) reversed = reversed.replace(after, before)
  assert.equal(reversed, appFrame)
})
