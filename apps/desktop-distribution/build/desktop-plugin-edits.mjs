/** Put the built-in plugin in the launcher's actual production dependency graph. */
export const STUDIO_PACKAGE = '@eadp-studio/studio-plugin'

export const DESKTOP_PLUGIN_EDIT = {
  file: 'apps/cli/package.json',
  apply(source) {
    const manifest = JSON.parse(source)
    if (manifest.name !== '@deepseek-ai/dsh' || !manifest.dependencies) {
      throw new Error('Studio dependency edit requires the fixed dsh CLI package manifest')
    }
    const existing = manifest.dependencies[STUDIO_PACKAGE]
    if (existing === 'workspace:*') return source
    if (existing !== undefined) throw new Error('Studio CLI dependency differs from the product workspace contract')
    manifest.dependencies[STUDIO_PACKAGE] = 'workspace:*'
    return `${JSON.stringify(manifest, null, 2)}\n`
  },
}
