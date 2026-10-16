/** Fixed pnpm operations used to assemble the Studio plugin. */
import { spawnSync } from 'node:child_process'

const OPERATIONS = {
  install: ['install', '--no-frozen-lockfile'],
  productInstall: ['install', '--frozen-lockfile', '--ignore-scripts'],
  checkWindows: ['run', 'package:desktop:win:x64:unsigned', '--check'],
  packageWindows: ['run', 'package:desktop:win:x64:unsigned'],
  // The official library build emits Host Remote contracts before Client consumers.
  libraries: ['exec', 'tsx', 'scripts/compile-referenced-projects.ts', 'libraries'],
  desktop: ['run', 'build:desktop'],
  // Relative to .local/build/dsh/packages/eadp/studio-plugin. Keeping this
  // fixed avoids placing a machine-local path into a Windows shell command.
  pack: ['pack', '--pack-destination', '../../../../packed-studio'],
}

export function runPnpm(operation, cwd, environment = process.env) {
  if (!Object.hasOwn(OPERATIONS, operation)) throw new Error(`Unknown pnpm operation: ${operation}`)
  const args = OPERATIONS[operation]
  // Node cannot execute Windows .cmd shims directly. Use the documented
  // command interpreter form, with command text made only from constants.
  // cwd stays a separate spawn option, including spaces and shell characters.
  const windows = process.platform === 'win32'
  const command = windows ? 'cmd.exe' : 'pnpm'
  const commandArgs = windows ? ['/d', '/s', '/c', `pnpm ${args.join(' ')}`] : args
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    // Avoid the upstream lefthook postinstall writing hooks to this repository.
    env: { ...environment, CI: 'true' },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} exited with ${String(result.status)}`)
}
