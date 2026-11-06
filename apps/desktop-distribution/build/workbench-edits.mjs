import { DESKTOP_BRAND_EDITS } from './desktop-brand-edits.mjs'
import { DESKTOP_STARTUP_EDIT } from './desktop-startup-edits.mjs'
import { STUDIO_PACKAGING_EDIT, STUDIO_PACKAGED_COMMIT_EDIT, STUDIO_PACK_CONCURRENCY_EDIT, STUDIO_PACKAGE_SET_TAR_EDIT } from './studio-packaging-edits.mjs'
import { STUDIO_MODEL_SELECTION_EDITS } from './model-selection-edits.mjs'
import { STUDIO_TYPERT_EDIT } from './studio-typert-edits.mjs'
import { PRIMARY_RUNTIME_EDIT } from './primary-runtime-edits.mjs'
import { WORKBENCH_RUNTIME_EDITS, WORKBENCH_RUNTIME_FILES } from './workbench-runtime-edits.mjs'
import { PROTOTYPE_TEMPLATE_EDIT, PROTOTYPE_TEMPLATE_FILES, PROTOTYPE_TEMPLATE_TRANSFORM_EDITS } from './prototype-template-edits.mjs'

/** Product assembly edits fail when fixed upstream anchors are absent or duplicated. */
function replace(source, before, after, file) {
  if (source.split(before).length !== 2) throw new Error(`Workbench anchor missing or duplicated: ${file}`)
  return source.replace(before, after)
}

export const WORKBENCH_BUNDLES = ['@eadp/shell', '@eadp/requirements', '@eadp/prototype', '@eadp/knowledge']
export const WORKBENCH_ADDITIONS = [...WORKBENCH_RUNTIME_FILES, ...PROTOTYPE_TEMPLATE_FILES]
export const WORKBENCH_EDITS = [
  ...DESKTOP_BRAND_EDITS,
  DESKTOP_STARTUP_EDIT,
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
      if (manifest.name !== '@deepseek-ai/dsh' || !manifest.dependencies || WORKBENCH_BUNDLES.some(name => name in manifest.dependencies)) throw new Error('Workbench CLI dependency anchor mismatch')
      Object.assign(manifest.dependencies, Object.fromEntries(WORKBENCH_BUNDLES.map(name => [name, 'workspace:*'])))
      return JSON.stringify(manifest, null, 2) + '\n'
    },
  },
  ...WORKBENCH_RUNTIME_EDITS,
  STUDIO_PACKAGING_EDIT,
  STUDIO_PACKAGED_COMMIT_EDIT,
  STUDIO_PACK_CONCURRENCY_EDIT,
  STUDIO_PACKAGE_SET_TAR_EDIT,
  {
    file: 'apps/desktop/scripts/prepare-package-set.ts',
    apply(source) {
      let next = replace(source,
        "import { basename, join, resolve } from 'node:path'",
        "import { basename, delimiter, join, resolve } from 'node:path'", this.file)
      next = replace(next,
        'const inputs = (values.from ?? defaultInputs).map(path => resolve(REPOSITORY_ROOT, path))',
        "const extraInputs = (process.env.DSH_DESKTOP_PACKED_EXTRA ?? '').split(delimiter).filter(Boolean)\n  const inputs = (values.from ?? [...defaultInputs, ...extraInputs]).map(path => resolve(REPOSITORY_ROOT, path))", this.file)
      return next
    },
  },
  ...STUDIO_MODEL_SELECTION_EDITS,
  PRIMARY_RUNTIME_EDIT,
  PROTOTYPE_TEMPLATE_EDIT,
  ...PROTOTYPE_TEMPLATE_TRANSFORM_EDITS,
]
