/** Regression guards for chrome-related upstream edits: drift here kills the Host or loses the model-config entry. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { STUDIO_SETTINGS_BRIDGE_EDIT } from '../../apps/desktop-distribution/build/studio-settings-bridge-edits.mjs'
import { STUDIO_FRAME_EDIT, STUDIO_SIDEBAR_CSS_EDIT } from '../../apps/desktop-distribution/build/studio-frame-edits.mjs'
import { STUDIO_PLATFORM_EDITS } from '../../apps/desktop-distribution/build/studio-platform-edits.mjs'

const upstreamSource = file => readFile(new URL(`../../.local/upstream/dsh/${file}`, import.meta.url), 'utf8')

test('frame edit collapses the shell sidebar without unmounting its slots; sidebar CSS hides the shell caption toggle under Studio', async () => {
  const frame = await upstreamSource(STUDIO_FRAME_EDIT.file).catch(() => undefined)
  const source = frame ?? `  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE\n  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0`
  const edited = STUDIO_FRAME_EDIT.apply(source)
  assert.match(edited, /activePanelId === 'studio' \|\| \(narrow \? !layoutInfo\.narrowExpanded/)
  assert.match(edited, /const collapsedWidth = activePanelId === 'studio'/)
  assert.doesNotMatch(edited, /activePanelId !== 'studio' && sidebar/, 'unmounting the sidebar would take the shared settings dialog with it')
  assert.equal(STUDIO_FRAME_EDIT.apply(edited), edited)

  const css = await upstreamSource(STUDIO_SIDEBAR_CSS_EDIT.file).catch(() => undefined)
  const cssSource = css ?? `:global(html[data-windows-titlebar]:has([data-sidebar-collapsed='true'])) {\n  --dsh-windows-menu-start: 84px;\n}`
  const cssEdited = STUDIO_SIDEBAR_CSS_EDIT.apply(cssSource)
  assert.match(cssEdited, /:has\(\[data-studio-panel='studio'\]\)\) \.toggle \{\n  display: none;/)
  assert.equal(STUDIO_SIDEBAR_CSS_EDIT.apply(cssEdited), cssEdited)
})

test('settings bridge hoists dialog state to activation scope and wires the product event', () => {
  const original = `  ctx.slots.inject('sidebar.settings', () => {\n    const shellHandle = createSettingsShellStore()\n    const shellInstance = shellHandle.create()\n    const shellStore: typeof shellHandle = { ...shellHandle, create: () => shellInstance }`
  const edited = STUDIO_SETTINGS_BRIDGE_EDIT.apply(original)
  assert.ok(edited.indexOf("window.addEventListener('eadp:open-settings'") < edited.indexOf("ctx.slots.inject('sidebar.settings'"), 'the listener must register at plugin activation, not inside the sidebar slot factory')
  assert.match(edited, /actions\.openSection\(section\)/)
  assert.match(edited, /const shellStore: typeof shellHandle = \{ \.\.\.shellHandle, create: \(\) => shellInstance \}/)
  assert.equal(STUDIO_SETTINGS_BRIDGE_EDIT.apply(edited), edited)
  assert.throws(() => STUDIO_SETTINGS_BRIDGE_EDIT.apply('drift'), /anchor/)
})

test('the fixed upstream settings shell accepts the bridge edit with its real anchors', async () => {
  let source
  try { source = await upstreamSource(STUDIO_SETTINGS_BRIDGE_EDIT.file) } catch { return test.skip('fixed DSH source is not fetched on this machine') }
  const edited = STUDIO_SETTINGS_BRIDGE_EDIT.apply(source)
  assert.match(edited, /addEventListener\('eadp:open-settings'/)
  assert.equal(STUDIO_SETTINGS_BRIDGE_EDIT.apply(edited), edited)
})

test('the host process must intercept studio secret requests before the host-event validation kills the child', async () => {
  let source
  try { source = await upstreamSource('apps/desktop/src/host-process.ts') } catch { return test.skip('fixed DSH source is not fetched on this machine') }
  const edit = STUDIO_PLATFORM_EDITS.find(edit => edit.file === 'apps/desktop/src/host-process.ts')
  const edited = edit.apply(source)
  const secretCheck = edited.indexOf('isStudioSecretRequest(message)')
  const hostEventCheck = edited.indexOf('!isDesktopHostEvent(message)')
  assert.ok(secretCheck >= 0, 'studio secret interception is missing after replay')
  assert.ok(hostEventCheck >= 0, 'host event validation is missing after replay')
  assert.ok(secretCheck < hostEventCheck, 'an unhandled secret request reaches the host-event rejection and terminates the Host')
  assert.match(edited, /handleStudioSecretRequest\(child, message\)/)
  assert.equal(edit.apply(edited), edited)
})
