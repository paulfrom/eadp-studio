import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { STUDIO_TITLEBAR_EDIT } from '../../apps/desktop-distribution/build/studio-titlebar-edits.mjs'

const repo = path.resolve(import.meta.dirname, '../..')
const client = path.join(repo, 'packages/studio-plugin/src/client')
const styles = await readFile(path.join(client, 'studio.module.css'), 'utf8')
const requireBuild = createRequire(path.join(repo, '.local/build/dsh/package.json'))
const typescript = requireBuild('typescript')
const { JSDOM } = requireBuild('jsdom')
const menuSource = await readFile(path.join(repo, '.local/upstream/dsh', STUDIO_TITLEBAR_EDIT.file), 'utf8')

function compile(source) {
  return typescript.transpileModule(source.replace(/^import .+\n/gm, '').replace(/export function /g, 'function '), {
    compilerOptions: { jsx: typescript.JsxEmit.React, target: typescript.ScriptTarget.ES2022 },
  }).outputText
}

test('Windows reuses the native caption row instead of reserving a second Studio row', () => {
  const desktopRule = styles.match(/:global\(html\[data-windows-titlebar\]\) \.topbar\s*\{([^}]+)\}/)?.[1]
  assert.ok(desktopRule, 'Studio header needs Windows caption integration')
  assert.match(desktopRule, /position:\s*fixed/)
  assert.match(desktopRule, /top:\s*0/)
  assert.match(desktopRule, /height:\s*var\(--dsh-windows-titlebar-height\)/)
  assert.match(desktopRule, /left:\s*calc\(var\(--dsh-windows-menu-start, 48px\) \+ var\(--dsh-windows-menu-width\)/)
  assert.match(desktopRule, /right:\s*calc\(100% - env\(titlebar-area-width\)\)/)
  assert.match(desktopRule, /-webkit-app-region:\s*drag/)
  assert.match(styles, /\.topbar\s+:is\(button, a\)\s*\{[^}]*-webkit-app-region:\s*no-drag/)
})

test('shared toolbar keeps the live project, preview target and refresh action', async () => {
  const source = await readFile(path.join(client, 'components/StudioTopbar.tsx'), 'utf8')
  const render = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
  const Component = new Function('React', 'css', `${compile(source)}; return StudioTopbar`)({ createElement: render }, new Proxy({}, { get: (_, key) => key }))
  const find = (tree, type) => tree.type === type ? tree : tree.children.filter(Boolean).filter(child => typeof child === 'object').map(child => find(child, type)).find(Boolean)
  const texts = tree => typeof tree === 'object' ? tree.children.map(texts).join('') : tree ?? ''
  let refreshed = 0
  const state = { connected: true, project: { name: '采购项目', stableBranch: 'main' }, preview: { url: 'http://127.0.0.1:4321' } }
  const header = Component({ state, busy: false, onRefresh: () => { refreshed++ } })
  assert.equal(header.type, 'header')
  assert.match(texts(header), /EADP Studio采购项目.*main（已同步）.*本地原型.*刷新/)
  assert.equal(find(header, 'a').props.href, state.preview.url)
  assert.equal(find(header, 'a').props.rel, 'noreferrer')
  find(header, 'button').props.onClick()
  assert.equal(refreshed, 1)
  const busy = Component({ state: { connected: false }, busy: true, onRefresh() {} })
  assert.equal(find(busy, 'button').props.disabled, true)
  assert.match(texts(busy), /项目工作台.*工作空间.*原型未运行/)
  const panel = await readFile(path.join(client, 'studio/StudioPanel.tsx'), 'utf8')
  assert.match(panel, /<StudioTopbar state=\{state\} busy=\{busy\} onRefresh=\{\(\) => void call\(\{ action: 'state' \}\)\}/)
  assert.doesNotMatch(panel, /EADP Studio|原型未运行/, 'the second inline toolbar has been removed')
})

test('caption geometry follows the actual localized menu and releases its observer on dispose', () => {
  const dom = new JSDOM('<html><body><div data-shell-overlay></div></body></html>')
  const { document, MutationObserver, HTMLElement, HTMLInputElement, HTMLTextAreaElement } = dom.window
  let resize
  let observed
  let disconnected = false
  class ResizeObserver {
    constructor(callback) { resize = callback }
    observe(element) { observed = element }
    disconnect() { disconnected = true }
  }
  const install = new Function('document', 'MutationObserver', 'ResizeObserver', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'ipcRenderer', 'DESKTOP_IPC', 'resolveDesktopLocale', `${compile(STUDIO_TITLEBAR_EDIT.apply(menuSource))}; return installWindowsMenu`)(
    document, MutationObserver, ResizeObserver, HTMLElement, HTMLInputElement, HTMLTextAreaElement,
    { invoke: async () => {} }, { windowsMenu: 'windowsMenu' }, () => ({ messages: { application: '应用', edit: '编辑', menuBar: '应用菜单' } }),
  )
  const menu = install()
  assert.equal(observed, document.querySelector('[data-windows-menu]'))
  assert.equal(observed.shadowRoot.querySelectorAll('[role=menuitem]').length, 2)
  observed.getBoundingClientRect = () => ({ width: 112.5 })
  resize()
  assert.equal(document.documentElement.style.getPropertyValue('--dsh-windows-menu-width'), '112.5px')
  observed.getBoundingClientRect = () => ({ width: 165 })
  menu.update()
  resize()
  assert.equal(document.documentElement.style.getPropertyValue('--dsh-windows-menu-width'), '165px')
  menu.dispose()
  assert.equal(disconnected, true)
  assert.equal(document.documentElement.style.getPropertyValue('--dsh-windows-menu-width'), '')
  assert.equal(document.querySelector('[data-windows-menu]'), null)
  dom.window.close()
})

test('titlebar assembly is idempotent and rejects missing or duplicated upstream anchors', () => {
  const edited = STUDIO_TITLEBAR_EDIT.apply(menuSource)
  assert.equal(STUDIO_TITLEBAR_EDIT.apply(edited), edited)
  assert.throws(() => STUDIO_TITLEBAR_EDIT.apply('upstream drift'), /anchor missing or duplicated/)
  assert.throws(() => STUDIO_TITLEBAR_EDIT.apply(menuSource + STUDIO_TITLEBAR_EDIT.pairs[0][0]), /anchor missing or duplicated/)
  let reversed = edited
  for (const [before, after] of STUDIO_TITLEBAR_EDIT.pairs) reversed = reversed.replace(after, before)
  assert.equal(reversed, menuSource)
})
