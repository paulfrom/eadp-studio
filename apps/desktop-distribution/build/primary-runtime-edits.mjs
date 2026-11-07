/** Reuse complete interpreter payloads while retaining the official execution checks. */
export const PRIMARY_RUNTIME_EDIT = {
  file: 'scripts/primary-runtime/prepare.ts',
  apply(source) {
    const anchors = [
      ["import { cp } from 'node:fs/promises'", "import { cp } from 'node:fs/promises'\nimport { readdirSync } from 'node:fs'"],
      ['  const staging = mkdtempSync(join(tmpdir(), \'dsh-primary-\'))', `  const destination = join(paths.runtime, 'primary-runtime')
  const receiptPath = join(paths.runtime, 'primary-runtime.prepared.json')
  const pnpmVersion = options.pythonOnly ? undefined : options.pnpmArchive?.version ??
    (JSON.parse(readFileSync(createRequire(import.meta.url).resolve('pnpm'), 'utf8')) as { version: string }).version
  const identity = createHash('sha256').update(JSON.stringify({
    payload: primaryRuntimePayloadDigest(target, lock, pnpmVersion), version: options.version, pnpmArchive: options.pnpmArchive,
    implementation: readFileSync(new URL('./prepare.ts', import.meta.url), 'utf8'),
    pruning: readFileSync(new URL('./prune-python-tests.ts', import.meta.url), 'utf8'),
  })).digest('hex')
  let reusable = false
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { identity: string; digest: string }
    reusable = receipt.identity === identity && receipt.digest === preparedPayloadDigest(destination)
  } catch { /* Missing or damaged payloads are rebuilt from the locked archives. */ }
  if (!reusable) {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-primary-'))`],
      ["  const assets = options.skillSource ??", `  writeFileSync(receiptPath, JSON.stringify({ identity, digest: preparedPayloadDigest(destination) }))
  } else console.log('Reusing verified primary runtime payload.')
  const assets = options.skillSource ??`],
      ['/**\n * Materialize locked interpreters, libraries and Office resources without executing target code.', `${PREPARED_DIGEST}\n\n/**\n * Materialize locked interpreters, libraries and Office resources without executing target code.`],
    ]
    const unindent = value => value.replace(/(  if \(!reusable\) \{\n)([\s\S]*?)(\n  \} else console\.log\('Reusing verified primary runtime payload\.'\))/, (_, start, body, end) => start + body.split('\n').map(line => line.startsWith('  ') ? line.slice(2) : line).join('\n') + end)
    if (anchors.every(([, after]) => unindent(source).split(after).length === 2)) return source
    if (!anchors.every(([before]) => source.split(before).length === 2)) throw new Error('Primary runtime reuse anchor missing, duplicated, or partially applied')
    const patched = anchors.reduce((value, [before, after]) => value.replace(before, after), source)
    return patched.replace(/(  if \(!reusable\) \{\n)([\s\S]*?)(\n  \} else console\.log\('Reusing verified primary runtime payload\.'\))/, (_, start, body, end) => start + body.split('\n').map(line => line ? '  ' + line : line).join('\n') + end)
  },
}

export const PREPARED_DIGEST = `/** Hash maintained payload entries; Python generates bytecode caches during execution. */
function preparedPayloadDigest(root: string): string {
  const hash = createHash('sha256')
  const visit = (relative: string): void => {
    const filename = join(root, relative)
    const entry = lstatSync(filename)
    hash.update(JSON.stringify(relative)).update('\\0')
    if (entry.isSymbolicLink()) hash.update('link').update(readlinkSync(filename))
    else if (entry.isDirectory()) {
      hash.update('directory')
      for (const child of readdirSync(filename).sort()) {
        if (child === '__pycache__' || child.endsWith('.pyc') || child.endsWith('.pyo')) continue
        visit(relative ? relative + '/' + child : child)
      }
    } else if (entry.isFile()) hash.update('file').update(readFileSync(filename))
    else throw new Error('Unsupported primary runtime payload entry: ' + relative)
    hash.update('\\0')
  }
  visit('')
  return hash.digest('hex')
}`
