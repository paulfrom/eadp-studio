import { STUDIO_TYPERT_EDIT } from './studio-typert-edits.mjs'
/** Product assembly edits fail when fixed upstream anchors are absent or duplicated. */
function replace(source, before, after, file) {
  if (source.split(before).length !== 2) throw new Error(`Workbench anchor missing or duplicated: ${file}`)
  return source.replace(before, after)
}
export const WORKBENCH_BUNDLES = ['@eadp/shell', '@eadp/requirements', '@eadp/prototype', '@eadp/knowledge']
export const WORKBENCH_EDITS = [
  STUDIO_TYPERT_EDIT,
  {
    file: 'apps/desktop/src/project-manager.ts',
    apply(source) {
      return replace(source, 'const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate',
        `const SHIPPED_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate\nconst WEB_PROFILE: ProfileTemplate = { ...SHIPPED_PROFILE, bundles: [...SHIPPED_PROFILE.bundles, ...${JSON.stringify(WORKBENCH_BUNDLES)}] }`, this.file)
    },
  },
  {
    file: 'apps/cli/package.json',
    apply(source) {
      const manifest = JSON.parse(source)
      if (!manifest.dependencies || WORKBENCH_BUNDLES.some(name => name in manifest.dependencies)) throw new Error('Workbench CLI dependency anchor mismatch')
      Object.assign(manifest.dependencies, Object.fromEntries(WORKBENCH_BUNDLES.map(name => [name, 'workspace:*'])))
      return JSON.stringify(manifest, null, 2) + '\n'
    },
  },
]
