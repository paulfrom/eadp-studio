/** Keep the official artifact pipeline, without aggregate script/test typecheck programs. */
export const STUDIO_PACKAGING_EDIT = {
  file: 'apps/desktop/scripts/package-target.ts',
  apply(source) {
    const before = "await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)"
    const after = "await execute(['exec', 'tsx', 'scripts/build.ts', '--profile', 'official', '--artifacts-only'], buildEnv, REPOSITORY_ROOT)"
    if (source.includes(after)) return source
    if (source.split(before).length !== 2) throw new Error('Studio packaging edit anchor missing or duplicated.')
    return source.replace(before, after)
  },
}
