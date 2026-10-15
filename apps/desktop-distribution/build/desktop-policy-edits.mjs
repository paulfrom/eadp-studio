/** Product transport policy, replayed only into the disposable DSH build tree. */

function replaceAnchored(source, before, after, file) {
  if (source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error(`Desktop policy edit anchor missing or duplicated: ${file}`)
  return source.replace(before, after)
}

function edit(file, replacements) {
  return { file, apply: source => replacements.reduce((next, [before, after]) => replaceAnchored(next, before, after, file), source) }
}

export const DESKTOP_POLICY_EDITS = [
  edit('apps/desktop/scripts/desktop-policy-environment.mjs', [
    ['function origin(value, name) {', 'function origin(value, name, allowHttp = false) {'],
    ["if (url.protocol !== 'https:' || url.username", "if ((url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) || url.username"],
    ['catch { throw new Error(`desktop package: ${name} requires an HTTPS origin`) }', 'catch { throw new Error(`desktop package: ${name} requires an HTTP or HTTPS origin`) }'],
    ['throw new Error(`desktop package: ${name} requires an HTTPS origin without credentials, path, query, or fragment`)', 'throw new Error(`desktop package: ${name} requires an HTTP or HTTPS origin without credentials, path, query, or fragment`)'],
    ['const selected = origin(environment[name], name)', 'const selected = origin(environment[name], name, true)'],
    ["pages.map(value => origin(value, 'allowedPageOrigins'))", "pages.map(value => origin(value, 'allowedPageOrigins', true))"],
  ]),
  edit('apps/desktop/src/mandatory-update-policy.ts', [
    ['function origin(value: unknown, local: boolean)', 'function origin(value: unknown, allowHttp: boolean)'],
    ["!(local && url.protocol === 'http:' && url.hostname === '127.0.0.1')", "!(allowHttp && url.protocol === 'http:')"],
    ['expected an HTTPS origin without credentials, path, query, or fragment', 'expected an HTTP or HTTPS origin without credentials, path, query, or fragment'],
    [' * @param allowLoopback - Explicit unpackaged/test permission for an HTTP 127.0.0.1 policy origin only.', ' * Policy transport accepts HTTP and HTTPS in every desktop mode.'],
    ['resolveDesktopPolicyConfig(input: unknown, allowLoopback = false)', 'resolveDesktopPolicyConfig(input: unknown)'],
    ["origin(value.origin, authentication === 'anonymous' && allowLoopback)", 'origin(value.origin, true)'],
    ['value.allowedPageOrigins.map(item => origin(item, false))', 'value.allowedPageOrigins.map(item => origin(item, true))'],
  ]),
  edit('apps/desktop/src/main.ts', [
    ['resolveDesktopPolicyConfig(policyInput, !app.isPackaged)', 'resolveDesktopPolicyConfig(policyInput)'],
  ]),
  // Keep upstream regression sources aligned with the removed loopback-only contract.
  edit('apps/desktop/tests/mandatory-update-policy.spec.ts', [
    ['requires explicit production origins and confines HTTP to an explicit local policy fixture', 'accepts HTTP and HTTPS policy origins without a development-only switch'],
    ["expect(() => resolveDesktopPolicyConfig({ ...deployment, origin: 'http://127.0.0.1:19001' })).toThrow('HTTPS')", "expect(resolveDesktopPolicyConfig({ ...deployment, origin: 'http://127.0.0.1:19001' })!.origin).toBe('http://127.0.0.1:19001')"],
    ["expect(resolveDesktopPolicyConfig({ ...deployment, origin: 'http://127.0.0.1:19001' }, true)!.origin).toBe('http://127.0.0.1:19001')", "expect(resolveDesktopPolicyConfig({ ...deployment, origin: 'http://100.119.183.44' })!.origin).toBe('http://100.119.183.44')"],
    ["expect(() => resolveDesktopPolicyConfig({ ...deployment, origin: 'http://example.com' }, true)).toThrow('HTTPS')", "expect(() => resolveDesktopPolicyConfig({ ...deployment, origin: 'ftp://example.com' })).toThrow('HTTPS')"],
  ]),
  edit('apps/desktop/tests/desktop-policy-environment.spec.ts', [
    ["undefined, '', 'http://test.example.com',", "undefined, '', 'ftp://test.example.com',"],
    ['{\"allowedPageOrigins\":[\"http://example.com\"]}', '{\"allowedPageOrigins\":[\"ftp://example.com\"]}'],
  ]),
  edit('apps/desktop/tests/fixtures/local-updater.mjs', [
    ['intervalMs: 600_000, timeoutMs: 1000 }, true)', 'intervalMs: 600_000, timeoutMs: 1000 })'],
  ]),
]
