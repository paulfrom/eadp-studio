import { readFileSync } from 'node:fs'
export const STUDIO_TEMPLATE_FILES = ['studio-template-archive.mjs', 'studio-template-archive.d.mts']
  .map(file => ({ file: `apps/desktop/scripts/${file}`, source: readFileSync(new URL(file, import.meta.url), 'utf8') }))
export const STUDIO_TEMPLATE_EDIT = {
  file: 'apps/desktop/scripts/prepare-dsh.ts',
  apply(source) {
    const before = "    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:manifests', () => prepareRuntimeManifests(DSH_OUTPUT_ROOT))"
    const after = "    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:studio-template',\n      () => materializeStudioTemplate(join(DSH_OUTPUT_ROOT, 'node_modules', '@eadp-studio', 'studio-plugin')))\n" + before
    const declaration = "import { materializeStudioTemplate } from './studio-template-archive.mjs'\n"
    if (source.includes(after) && source.includes(declaration)) return source
    if (source.split(before).length !== 2 || source.includes(declaration)) throw new Error('Studio template preparation anchor missing or duplicated.')
    return declaration + source.replace(before, after)
  },
}
