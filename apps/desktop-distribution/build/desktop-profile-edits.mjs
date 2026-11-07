/** App-owned profile deployment: the EADP composition is reconciled before every Host start. */
import { readFileSync } from 'node:fs'

const projectManager = 'apps/desktop/src/project-manager.ts'

const bootImport = `import {
  initProfile, PROFILE_TEMPLATES, removeLinkProjections, sanitizeProfile, type ProfileTemplate,
} from '@deepseek-ai/dsh-app-boot'`

const releaseAnchor = `      createPluginProfile(this.paths.profile)
      removeLinkProjections(this.paths.profile)`

const recoveryAnchor = "    return this.withLock(() => sanitizeProfile('dsh', this.paths.profile, WEB_PROFILE.bundles))"

export const EADP_PROFILE_SOURCE = readFileSync(new URL('eadp-profile.ts', import.meta.url), 'utf8')

export const DESKTOP_PROFILE_FILES = [{ file: 'apps/desktop/src/eadp-profile.ts', source: EADP_PROFILE_SOURCE }]

/** Apply each exact upstream anchor once; a missing or duplicated anchor aborts the assembly. */
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Desktop profile anchor missing or duplicated: ${projectManager}`)
  return source.replace(before, after)
}

export const DESKTOP_PROFILE_EDITS = [{
  file: projectManager,
  apply(source) {
    const declaration = "import { deployEadpProfile, withEadpBundles } from './eadp-profile.ts'"
    const imported = replace(source, bootImport, `${bootImport}\n${declaration}`)
    // The profile is initialized just before this point, and the Host starts only after the lock is released.
    const deployed = replace(imported, releaseAnchor,
      `      createPluginProfile(this.paths.profile)\n      deployEadpProfile(this.paths.profile, WEB_PROFILE.bundles)\n      removeLinkProjections(this.paths.profile)`)
    // Recovery resets the bundle list to its own argument, so it has to name the app composition too.
    return replace(deployed, recoveryAnchor,
      "    return this.withLock(() => sanitizeProfile('dsh', this.paths.profile, withEadpBundles(WEB_PROFILE.bundles)))")
  },
}]
