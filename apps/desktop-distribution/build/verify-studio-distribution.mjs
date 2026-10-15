/** Verify extracted final resources (or the official prepared dsh/runtime trees). */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyStudioDistribution } from './studio-payload.mjs'

const [dshRoot, runtimeRoot] = process.argv.slice(2)
if (!dshRoot || !runtimeRoot || process.argv.length !== 4) throw new Error('Usage: node verify-studio-distribution.mjs <dsh resource directory> <runtime/studio-tools directory>')
const repo = fileURLToPath(new URL('../../../', import.meta.url))
await verifyStudioDistribution(path.resolve(dshRoot, 'node_modules/@eadp-studio/studio-plugin'), path.resolve(runtimeRoot), repo)
console.log('Verified current complete Studio Host/client, template, contracts production closure and full toolchain payload.')
