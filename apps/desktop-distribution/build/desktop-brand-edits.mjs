/** Product identity applied only to the disposable, fixed-version DSH build tree. */
export const STUDIO_APP_ID = 'io.github.paulfrom.eadp.studio'

function replace(source, before, after, count, file, replayCount = count) {
  const afterCount = source.split(after).length - 1
  if ((!source.includes(before) || after.includes(before)) && afterCount === replayCount) return source
  if (afterCount !== 0 && after.includes(before)) throw new Error(`Desktop brand anchor missing or duplicated: ${file}`)
  if (source.split(before).length - 1 !== count) throw new Error(`Desktop brand anchor missing or duplicated: ${file}`)
  return source.replaceAll(before, after)
}

function edit(file, replacements) {
  return { file, apply: source => replacements.reduce((next, [before, after, count = 1, replayCount = count]) => replace(next, before, after, count, file, replayCount), source) }
}

export const DESKTOP_BRAND_EDITS = [
  // One upstream source of truth feeds Vite HTML, client title projection and
  // release artifact-record validation for the official build profile.
  edit('scripts/client-build-environment.ts', [["DSH_CLIENT_TITLE: 'DeepSeek Harness',", "DSH_CLIENT_TITLE: 'eadp studio',"]]),
  edit('apps/desktop/scripts/electron-builder-config.mjs', [
    ['DeepSeek Harness', 'eadp studio', 3, 4],
    ["schemes: ['dsh']", "schemes: ['eadp-studio']"],
    ["productName: 'eadp studio',", "productName: 'eadp studio',\n    executableName: 'eadp studio',"],
    ['artifactName: `deepseek-harness-', 'artifactName: `eadp-studio-'],
    ['dshDesktopAppId: appId,', "name: 'eadp-studio',\n      dshDesktopAppId: appId,"],
  ]),
  edit('apps/desktop/src/main.ts', [
    ['DeepSeek Harness', 'eadp studio', 1, 2],
    ['app.setAppLogsPath()', "app.setName('eadp studio')\n// Product-owned home: never inherit the official DSH application's data directory.\nprocess.env.DSH_HOME = join(app.getPath('home'), '.eadp-studio')\nif (process.platform === 'win32') app.setAppUserModelId('io.github.paulfrom.eadp.studio')\napp.setAppLogsPath()"],
    ["app.setAsDefaultProtocolClient('dsh')", "app.setAsDefaultProtocolClient('eadp-studio')"],
    ["url === 'dsh://open' || url === 'dsh://open/'", "url === 'eadp-studio://open' || url === 'eadp-studio://open/'"],
  ]),
  edit('apps/desktop/src/locale.ts', [['DeepSeek Harness', 'eadp studio', 22]]),
  edit('apps/desktop/installer/strings.nsh', [['DeepSeek Harness', 'eadp studio', 6]]),
  edit('apps/desktop/installer/extract-report.h', [['DeepSeek Harness', 'eadp studio']]),
  edit('apps/desktop/scripts/smoke-packaged-runtime.ts', [['DeepSeek Harness', 'eadp studio', 3]]),
  edit('apps/desktop/scripts/package-target.ts', [['DeepSeek Harness.app', 'eadp studio.app']]),
]
