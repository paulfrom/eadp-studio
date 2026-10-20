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
  // Type-only modules still emit `export {};` to stay ESM; a Function body cannot contain it.
  return typescript.transpileModule(source
    .replace(/^import .+\n/gm, '')
    .replace(/export function /g, 'function '), {
    compilerOptions: { jsx: typescript.JsxEmit.React, target: typescript.ScriptTarget.ES2022 },
  }).outputText.replace(/^export \{\};\n?/gm, '')
}

test('Windows merges identity and actions into the native caption row; the toolbar row is web-only', () => {
  assert.match(styles, /\.captionIdentity \{[^}]*position:\s*fixed/)
  assert.match(styles, /\.captionIdentity \{[^}]*height:\s*var\(--dsh-windows-titlebar-height/)
  assert.match(styles, /\.captionIdentity \{[^}]*right:\s*150px/, 'the window controls keep their reserved space')
  assert.match(styles, /\.captionIdentity \.captionText \{[^}]*margin-left:\s*calc\(var\(--dsh-windows-menu-start/)
  assert.match(styles, /\.captionIdentity \.captionText \{[^}]*-webkit-app-region:\s*drag/)
  assert.match(styles, /\.captionActions \{[^}]*-webkit-app-region:\s*no-drag/)
  assert.match(styles, /\.captionActions \.primaryAction \{[^}]*background:\s*var\(--accent\)/)
  assert.match(styles, /\.topbarActions \.primaryAction \{[^}]*background:\s*var\(--accent\)/)
  assert.doesNotMatch(styles, /:global\(html\[data-windows-titlebar\]\) \.topbar/, 'the old caption-repositioning block is gone — the toolbar row only renders on web')
  assert.match(styles, /\.topbar\s+:is\(button, a\)\s*\{[^}]*-webkit-app-region:\s*no-drag/)
})

test('shared toolbar keeps the live project, preview target and refresh action', async () => {
  const source = await readFile(path.join(client, 'components/StudioTopbar.tsx'), 'utf8')
  const itemsSource = await readFile(path.join(client, 'topbar/items.tsx'), 'utf8')
  const render = (type, props, ...children) => typeof type === 'function'
    ? type({ ...(props ?? {}), children })
    : { type, props: props ?? {}, children: children.flat(Infinity) }
  const React = { createElement: render, Fragment: 'fragment' }
  const styleProxy = new Proxy({}, { get: (_, key) => key })
  const { topbarItems } = new Function('React', `${compile(itemsSource)}; return { topbarItems }`)(React)
  const Component = new Function('React', 'css', 'topbarItems', 'useState', 'useEffect', 'useRef', 'useSyncExternalStore', `${compile(source)}; return StudioTopbar`)(
    React,
    styleProxy,
    topbarItems,
    initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    () => {},
    current => ({ current }),
    (_subscribe, getSnapshot) => getSnapshot(),
  )
  const findAll = (tree, type) => [
    ...(tree.type === type ? [tree] : []),
    ...tree.children.filter(Boolean).filter(child => typeof child === 'object').flatMap(child => findAll(child, type)),
  ]
  const find = (tree, type) => findAll(tree, type)[0]
  const texts = tree => typeof tree === 'object' ? tree.children.map(texts).join('') : tree ?? ''
  const faces = state => ({
    state,
    busy: state.busy === true,
    theme: { subscribe: () => () => {}, getSnapshot: () => ({ preference: 'system' }) },
    stage: 'scenarios',
    stages: [{ id: 'scenarios', name: '场景' }],
    refresh: state.onRefresh,
    selectStage() {},
    startSession() {},
    openSettings() {},
  })
  let refreshed = 0
  const state = { connected: true, project: { name: '采购项目', stableBranch: 'main' }, preview: { url: 'http://127.0.0.1:4321' }, onRefresh: () => { refreshed++ } }
  // Web (non-captioned) renders the single in-flow toolbar row.
  const header = find(Component({ faces: faces(state), sidebarCollapsed: false, onToggleSidebar() {} }), 'header')
  assert.ok(header, 'the web fallback renders the in-flow toolbar')
  assert.match(texts(header), /EADP Studio.*采购项目.*main（已同步）.*本地原型.*刷新/)
  assert.equal(find(header, 'a').props.href, state.preview.url)
  assert.equal(find(header, 'a').props.rel, 'noreferrer')
  findAll(header, 'button').find(button => texts(button) === '刷新').props.onClick()
  assert.equal(refreshed, 1)
  const busy = find(Component({ faces: faces({ connected: false, busy: true, onRefresh() {} }), sidebarCollapsed: false, onToggleSidebar() {} }), 'header')
  assert.equal(findAll(busy, 'button').find(button => texts(button) === '刷新').props.disabled, true)
  assert.match(texts(busy), /项目工作台.*工作空间/)
  const panel = await readFile(path.join(client, 'studio/StudioPanel.tsx'), 'utf8')
  assert.match(panel, /<StudioTopbar faces=\{\{ state[\s\S]*startSession: props\.startSession[\s\S]*openSettings: props\.openSettings/)
  assert.doesNotMatch(panel, /EADP Studio/, 'the workbench title lives in the declarative identity, not the panel')
})

test('the new-session command is the declarative primary action; the sidebar panel row exists', async () => {
  const source = await readFile(path.join(client, 'topbar/items.tsx'), 'utf8')
  assert.match(source, /id: 'new-session', label: '新建会话', primary: true/, 'new session is the primary caption action')
  assert.match(source, /startSession\(\)/)
  const panelIcon = await readFile(path.join(client, 'panelIcon.tsx'), 'utf8')
  assert.match(panelIcon, /sidebar\.panellist/)
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
