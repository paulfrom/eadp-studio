import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '../..')
const requireBuild = createRequire(path.join(repo, '.local/build/dsh/package.json'))
const { JSDOM } = requireBuild('jsdom')
const ts = requireBuild('typescript')

test('native preview yields to portaled host menus and resumes after dismissal', async () => {
  const dom = new JSDOM('<body><div id="canvas"></div></body>', { pretendToBeVisual: true })
  const canvas = dom.window.document.getElementById('canvas')
  const bounds = () => ({ x: 10, y: 10, left: 10, top: 10, right: 610, bottom: 410, width: 600, height: 400 })
  canvas.getBoundingClientRect = bounds
  dom.window.document.elementFromPoint = () => canvas
  const calls = []
  dom.window.studioPrototypeCanvas = { layout: async value => { calls.push(value) } }
  let changed, dispose
  const globals = {
    window: dom.window, document: dom.window.document, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: callback => { callback(); return 1 }, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { constructor(callback) { changed = callback } observe() {} disconnect() {} },
  }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  try {
    const filename = path.join(repo, 'packages/studio-plugin/src/client/prototype/PrototypeCanvas.tsx')
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', compiled)(name => {
      if (name === 'react') return { useRef: () => ({ current: canvas }), useState: () => ['', () => {}], useEffect: effect => { dispose = effect() } }
      if (name === 'react/jsx-runtime') return { jsx: () => null }
      throw new Error(`Unexpected runtime dependency: ${name}`)
    }, module, module.exports)
    module.exports.PrototypeCanvas({ identity: { projectId: 'p', prototypeTaskId: 't' }, visible: true })
    assert.equal(calls.at(-1).visible, true)
    // The official Menu portals outside the workbench, beyond the preview's sampled points.
    const menu = dom.window.document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.getBoundingClientRect = bounds
    dom.window.document.body.append(menu)
    changed()
    assert.equal(calls.at(-1).visible, false)
    menu.remove()
    changed()
    assert.equal(calls.at(-1).visible, true)
    dispose()
    assert.equal(calls.at(-1).visible, false)
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  }
})
