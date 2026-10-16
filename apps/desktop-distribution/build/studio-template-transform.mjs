/** Frozen template assets are source material, not installed dependency manifests. */
import { createRequire } from 'node:module'
import path from 'node:path'

const transformer = createRequire(import.meta.url)('app-builder-lib/out/fileTransformer.js')
const marker = Symbol.for('@eadp-studio/template-source-transformer')
const original = transformer.createTransformer
if (!original[marker]) {
  const wrapped = (...args) => {
    const transform = original(...args)
    return filename => path.resolve(filename).replaceAll('\\', '/').includes('/node_modules/@eadp-studio/studio-plugin/assets/prototype-template/')
      ? null : transform(filename)
  }
  Object.defineProperty(wrapped, marker, { value: true })
  transformer.createTransformer = wrapped
}
