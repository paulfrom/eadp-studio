/** Identify a running desktop development app by the Chromium profile it owns. */
import { spawnSync } from 'node:child_process'

// Chromium keeps one process per profile directory. Helpers repeat the same
// --user-data-dir and are told apart by their --type switch, so only main
// processes are reported. Reported text is UTF-8 so failures stay readable
// under a non-Latin console code page.
const query = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" |',
  '    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:EADP_DESKTOP_DEVELOPMENT_PROFILE) -and -not $_.CommandLine.Contains("--type=") } |',
  '    ForEach-Object { $_.ProcessId }',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n')

/**
 * Read the processes of a desktop development app that still owns `profile`.
 * @param profile - Development Electron profile directory.
 * @param spawn - Process runner; tests pass a stub, production uses spawnSync.
 * @returns Identifiers of the running main processes, empty when none runs.
 */
export function developmentAppPids(profile, spawn = spawnSync) {
  const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, EADP_DESKTOP_DEVELOPMENT_PROFILE: profile },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.trim()
    throw new Error(`Cannot inspect running desktop development apps: ${detail || `powershell exited with ${String(result.status)}`}.`)
  }
  return result.stdout.split(/\s+/).filter(Boolean).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0)
}
