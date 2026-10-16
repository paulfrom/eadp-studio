/** Keep the official artifact pipeline, without aggregate script/test typecheck programs. */
export const STUDIO_PACKAGING_EDIT = {
  file: 'apps/desktop/scripts/package-target.ts',
  apply(source) {
    const before = "await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)"
    const after = "await execute(['exec', 'tsx', 'scripts/build.ts', '--profile', 'official', '--scope', 'artifacts'], buildEnv, REPOSITORY_ROOT)"
    if (source.includes(after)) return source
    if (source.split(before).length !== 2) throw new Error('Studio packaging edit anchor missing or duplicated.')
    return source.replace(before, after)
  },
}

/** Bind both desktop metadata and client artifact receipts to the packaging entry's single Git snapshot. */
export const STUDIO_PACKAGED_COMMIT_EDIT = {
  file: 'apps/desktop/scripts/desktop-build-commit.mjs',
  apply(source) {
    const before = "    [DESKTOP_BUILD_COMMIT_ENV]: packaged.commit,\n    [DESKTOP_BUILD_DIRTY_ENV]: packaged.dirty ? '1' : '0',"
    const after = "    [DESKTOP_BUILD_COMMIT_ENV]: packaged.commit,\n    DSH_CLIENT_COMMIT_HASH: packaged.commit,\n    [DESKTOP_BUILD_DIRTY_ENV]: packaged.dirty ? '1' : '0',"
    if (source.split(after).length === 2 && !source.includes(before)) return source
    if (source.split(before).length !== 2 || source.includes(after)) throw new Error('Studio packaged-commit edit anchor missing or duplicated.')
    return source.replace(before, after)
  },
}

/** Pack release families with the official bounded scheduler on Windows too; upstream enables it only for macOS. */
export const STUDIO_PACK_CONCURRENCY_EDIT = {
  file: 'apps/desktop/scripts/package-target.ts',
  apply(source) {
    const before = "  const packArguments = mac === undefined ? [] : ['--concurrency', String(mac.packConcurrency)]"
    const after = "  const packArguments = ['--concurrency', String(mac?.packConcurrency ?? 4)]"
    if (source.includes(after)) return source
    if (source.split(before).length !== 2) throw new Error('Studio pack-concurrency edit anchor missing or duplicated.')
    return source.replace(before, after)
  },
}

/** Read tarball manifests with the relative-name pattern of scripts/release/tarball.ts; GNU tar parses a leading drive letter as a remote host. */
export const STUDIO_PACKAGE_SET_TAR_EDIT = {
  file: 'apps/desktop/scripts/prepare-package-set.ts',
  apply(source) {
    const before = "  const value: unknown = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json']))"
    const after = "  const value: unknown = JSON.parse(capture('tar', ['-xOzf', basename(tarball), 'package/package.json'], { cwd: resolve(tarball, '..') }))"
    if (source.includes(after)) return source
    if (source.split(before).length !== 2) throw new Error('Studio package-set tar edit anchor missing or duplicated.')
    return source.replace(before, after)
  },
}
