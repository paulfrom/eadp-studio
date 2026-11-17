/** Unsigned packages ship without a mandatory-update service; signed releases keep the upstream deployment origin. */

/** Apply one anchor once; an already edited file is returned unchanged and a missing anchor aborts. */
function replaceAnchor(source, before, after, file) {
  if (source.split(after).length === 2) return source
  if (source.split(before).length !== 2) {
    throw new Error(`Desktop policy edit anchor missing or duplicated: ${file}`)
  }
  return source.replace(before, after)
}

/**
 * Resolve no policy for unsigned packages, keeping signed releases on the upstream path.
 * Upstream requires the deployment origin before artifact preparation and embeds the resolved
 * policy into the installer; this repository ships no cooperation update service, so its
 * unsigned development installer must neither require the origin nor poll an unconfigured one.
 */
export const DESKTOP_POLICY_EDIT = {
  file: 'apps/desktop/scripts/desktop-policy-environment.mjs',
  apply(source) {
    let next = replaceAnchor(source,
      'export function resolveDesktopPolicyEnvironment(environment) {\n'
      + '  const deployment = resolveDesktopAutoUpdateEnvironment(environment)',
      'export function resolveDesktopPolicyEnvironment(environment) {\n'
      + '  // Unsigned packages carry no mandatory-update service; signed releases keep the deployment origin.\n'
      + "  if (environment.DSH_DESKTOP_UNSIGNED === '1') return undefined\n"
      + '  const deployment = resolveDesktopAutoUpdateEnvironment(environment)', this.file)
    return replaceAnchor(next,
      ' * @returns {{ origin: string, allowedPageOrigins: string[], authentication: \'anonymous\' | \'feishu-test\', [key: string]: unknown }} Selected policy.',
      ' * @returns {{ origin: string, allowedPageOrigins: string[], authentication: \'anonymous\' | \'feishu-test\', [key: string]: unknown } | undefined} Selected policy, or undefined for unsigned packages.',
      this.file)
  },
}

/** Keep the shipped declaration in step with the runtime contract. */
export const DESKTOP_POLICY_DECLARATION_EDIT = {
  file: 'apps/desktop/scripts/desktop-policy-environment.d.mts',
  apply(source) {
    let next = replaceAnchor(source,
      'export function resolveDesktopPolicyEnvironment(environment: NodeJS.ProcessEnv): DesktopPolicyEnvironment',
      'export function resolveDesktopPolicyEnvironment(environment: NodeJS.ProcessEnv): DesktopPolicyEnvironment | undefined',
      this.file)
    return replaceAnchor(next,
      ' * @returns Policy metadata with deployment-selected origin and authentication.',
      ' * @returns Policy metadata with deployment-selected origin and authentication; undefined for unsigned packages.',
      this.file)
  },
}

export const DESKTOP_POLICY_EDITS = [DESKTOP_POLICY_EDIT, DESKTOP_POLICY_DECLARATION_EDIT]
