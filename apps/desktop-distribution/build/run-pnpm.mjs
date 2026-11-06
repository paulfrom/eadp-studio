/** Fixed pnpm operations used to assemble the local Workbench. */
import { spawnSync } from 'node:child_process'

const OPERATIONS = {
  install: ['install', '--no-frozen-lockfile'],
  productInstall: ['install', '--frozen-lockfile', '--ignore-scripts'],
  checkWindows: ['run', 'package:desktop:win:x64:unsigned', '--check'],
  packageWindows: ['run', 'package:desktop:win:x64:unsigned'],
  // The official library build emits Host Remote contracts before Client consumers.
  libraries: ['run', 'build:lib'],
  desktop: ['run', 'build:desktop'],
  artifacts: ['run', 'build:artifacts'],
  startDesktop: ['run', 'start:desktop'],
  electron: ['--filter', '@deepseek-ai/dsh-desktop', 'exec', 'install-electron'],
  primaryRuntime: ['--filter', '@deepseek-ai/dsh-desktop', 'run', 'prepare:primary-runtime'],
  // Relative to .local/build/local-workbench-dsh/packages/eadp/<package>.
  pack: ['pack', '--pack-destination', '../../../../packed-workbench'],
}

export function pnpmInvocation(operation) {
  if (!Object.hasOwn(OPERATIONS, operation)) throw new Error(`Unknown pnpm operation: ${operation}`)
  const args = OPERATIONS[operation]
  // Node cannot execute Windows .cmd shims directly. Use the documented
  // command interpreter form, with command text made only from constants.
  // cwd stays a separate spawn option, including spaces and shell characters.
  const windows = process.platform === 'win32'
  const command = windows ? 'cmd.exe' : 'pnpm'
  const commandArgs = windows ? ['/d', '/s', '/c', `pnpm ${args.join(' ')}`] : args
  return { command, args: commandArgs }
}

export function runPnpm(operation, cwd, environment = process.env) {
  const { command, args: commandArgs } = pnpmInvocation(operation)
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    // Avoid the upstream lefthook postinstall writing hooks to this repository.
    env: { ...environment, CI: 'true' },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${OPERATIONS[operation].join(' ')} exited with ${String(result.status)}`)
}
