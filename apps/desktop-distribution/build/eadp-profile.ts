/** App-owned desktop profile composition, deployed into the fixed dsh profile directory. */
import { readProfileManifest, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'

/**
 * Bundles this application contributes to its desktop profile.
 * They are locked to the end of the profile's bundle list, so the app composition is restored on
 * every Host start even when a person removed one in the plugin manager.
 */
export const EADP_PROFILE_BUNDLES: readonly string[] = [
  '@eadp/shell',
  '@eadp/requirements',
  '@eadp/prototype',
  '@eadp/knowledge',
]

/**
 * Append the app bundles to a shipped bundle list.
 * @param baseBundles - ordered shipped bundle names for this application.
 * @returns the shipped order followed by the app bundles, without duplicates.
 */
export function withEadpBundles(baseBundles: readonly string[]): string[] {
  return [...new Set([...baseBundles, ...EADP_PROFILE_BUNDLES])]
}

/**
 * Reconcile an initialized profile's bundle list with the app composition.
 * Author-installed bundles keep their order, shipped base bundles are prepended only when absent,
 * and the app bundles stay locked at the end, so recovery and upgrades converge on the next start.
 * Writes the manifest only when the list changes; a missing or malformed manifest fails closed.
 * @param profileDir - desktop profile directory, already initialized with a manifest.
 * @param baseBundles - ordered shipped bundle names for this application.
 */
export function deployEadpProfile(profileDir: string, baseBundles: readonly string[]): void {
  const manifest = readProfileManifest('eadp studio', profileDir)
  const previous = manifest.dsh?.profile?.bundles
  const kept = (previous ?? []).filter(name => !EADP_PROFILE_BUNDLES.includes(name))
  const next = [...baseBundles.filter(name => !kept.includes(name)), ...kept, ...EADP_PROFILE_BUNDLES]
  const unchanged = previous !== undefined && previous.length === next.length
    && previous.every((name, index) => name === next[index])
  if (!unchanged) writeProfileBundles(profileDir, manifest, next)
}
