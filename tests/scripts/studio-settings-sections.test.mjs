/** Regression guard for the Studio settings-section nav glyph edit; drift here loses the section icons to the gear fallback. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { STUDIO_SETTINGS_SECTIONS_EDIT } from '../../apps/desktop-distribution/build/studio-settings-sections-edits.mjs'

const upstreamSource = file => readFile(new URL(`../../.local/upstream/dsh/${file}`, import.meta.url), 'utf8')

test('navIcon maps every Studio section id to a host glyph and keeps the gear fallback', () => {
  const original = `import {
  ConnectionIndicator, Tooltip, useModalLayer,
  IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconCloseOutlineRegular, IconDataOutlineMedium,
  IconPersonalizationOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'

function navIcon(id: string) {
  if (id === 'account') return <IconUserOutlineMedium className={css.navIcon} size={16} />
  if (id === 'models') return <IconDataOutlineMedium className={css.navIcon} size={16} />
  return <IconSettingsOutlineMedium className={css.navIcon} size={16} />
}`
  const edited = STUDIO_SETTINGS_SECTIONS_EDIT.apply(original)
  assert.match(edited, /IconInfoOutlineMedium, IconPersonalizationOutlineMedium, IconRefreshOutlineMedium/)
  for (const id of ['studio-collab', 'studio-appearance', 'studio-connection', 'studio-about']) {
    assert.match(edited, new RegExp(`id === '${id}'`), `${id} must have a nav glyph`)
  }
  assert.match(edited, /id === 'account'/, 'native sections keep their glyphs')
  assert.match(edited, /IconSettingsOutlineMedium/, 'the gear fallback stays')
  assert.equal(STUDIO_SETTINGS_SECTIONS_EDIT.apply(edited), edited, 'replay must be idempotent')
  assert.throws(() => STUDIO_SETTINGS_SECTIONS_EDIT.apply('drift'), /anchor/)
})

test('the fixed upstream settings shell accepts the glyph edit with its real anchors', async () => {
  let source
  try { source = await upstreamSource(STUDIO_SETTINGS_SECTIONS_EDIT.file) } catch { return test.skip('fixed DSH source is not fetched on this machine') }
  const edited = STUDIO_SETTINGS_SECTIONS_EDIT.apply(source)
  assert.match(edited, /IconInfoOutlineMedium, IconPersonalizationOutlineMedium, IconRefreshOutlineMedium/)
  assert.match(edited, /id === 'studio-collab'/)
  assert.equal(STUDIO_SETTINGS_SECTIONS_EDIT.apply(edited), edited)
})
