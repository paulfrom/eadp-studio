/**
 * Resolve the outbound proxy used by desktop build downloads and publish it to download-capable processes.
 *
 * Direct access to github.com is refused on this network, so every release download has to travel
 * through the machine proxy. The proxy comes from the environment first, because that is the
 * convention every download tool on this machine follows, and from the Windows system proxy when the
 * environment names none.
 */
import { execFileSync } from 'node:child_process'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

const WINDOWS_INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const LOOPBACK_BYPASS = ['localhost', '127.0.0.1', '::1', '[::1]']

/** One environment value, lowercase name first, as undici and the harness proxy policy read them. */
function environmentValue(environment, lower) {
  for (const name of [lower, lower.toUpperCase()]) {
    const value = environment[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Normalize one proxy value to an http(s) URL; other schemes cannot carry a release download. */
function proxyUrl(value) {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  if (!/^https?:\/\//i.test(candidate)) return undefined
  try {
    new URL(candidate)
  } catch {
    return undefined
  }
  return candidate
}

/** One Windows internet setting, absent when the registry does not hold it. */
function windowsSetting(name) {
  try {
    const output = execFileSync('reg.exe', ['query', WINDOWS_INTERNET_SETTINGS, '/v', name], { encoding: 'utf8', windowsHide: true })
    const match = new RegExp(`^\\s+${name}\\s+\\S+\\s+(.+)$`, 'im').exec(output)
    return match?.[1]?.trim()
  } catch {
    return undefined
  }
}

/** The Windows system proxy, in its per-scheme or shared form. */
function windowsSystemProxy() {
  if (process.platform !== 'win32') return undefined
  if (windowsSetting('ProxyEnable') !== '0x1') return undefined
  const server = windowsSetting('ProxyServer')
  if (!server) return undefined
  const schemes = {}
  let shared
  for (const part of server.split(';')) {
    const entry = part.trim()
    if (!entry) continue
    const separator = entry.indexOf('=')
    if (separator === -1) {
      shared = entry
      continue
    }
    const scheme = entry.slice(0, separator).trim().toLowerCase()
    if (scheme === 'http' || scheme === 'https') schemes[scheme] = entry.slice(separator + 1).trim()
  }
  const httpProxy = proxyUrl(schemes.http ?? shared)
  const httpsProxy = proxyUrl(schemes.https ?? shared ?? schemes.http)
  if (!httpProxy && !httpsProxy) return undefined
  return { httpProxy, httpsProxy }
}

/** The bypass list, always including the loopback addresses a proxy must not tunnel. */
function bypassList(value) {
  const entries = (value ?? '').split(/[,;\s]+/).map(entry => entry.trim()).filter(entry => entry !== '')
  const present = new Set(entries.map(entry => entry.toLowerCase()))
  for (const entry of LOOPBACK_BYPASS) if (!present.has(entry.toLowerCase())) entries.push(entry)
  return entries.join(',')
}

/**
 * Resolve the proxy that desktop build downloads travel through.
 *
 * @param {NodeJS.ProcessEnv} [environment] - Launch environment, where the environment names a proxy first.
 * @returns {{ httpProxy?: string, httpsProxy?: string, noProxy: string } | undefined} Resolved policy, or undefined for a direct connection.
 */
export function resolveDesktopProxy(environment = process.env) {
  const allProxy = proxyUrl(environmentValue(environment, 'all_proxy'))
  const environmentHttp = proxyUrl(environmentValue(environment, 'http_proxy'))
  const environmentHttps = proxyUrl(environmentValue(environment, 'https_proxy'))
  const system = environmentHttp === undefined && environmentHttps === undefined ? windowsSystemProxy() : undefined
  const httpProxy = environmentHttp ?? system?.httpProxy ?? allProxy
  const httpsProxy = environmentHttps ?? system?.httpsProxy ?? allProxy ?? httpProxy
  if (!httpProxy && !httpsProxy) return undefined
  return { httpProxy, httpsProxy, noProxy: bypassList(environmentValue(environment, 'no_proxy')) }
}

/**
 * Publish the resolved proxy to a download-capable child process.
 *
 * The child reaches the proxy through the environment variables its own tooling reads, and the
 * Node proxy switch covers the plain `fetch` calls in the assembled upstream scripts.
 *
 * @param {NodeJS.ProcessEnv} base - Environment the child inherits.
 * @param {{ httpProxy?: string, httpsProxy?: string, noProxy: string } | undefined} proxy - Resolved policy.
 * @returns {NodeJS.ProcessEnv} Environment for a download-capable child process.
 */
export function downloadEnvironment(base, proxy) {
  if (!proxy) return { ...base }
  return {
    ...base,
    ...(proxy.httpProxy ? { HTTP_PROXY: proxy.httpProxy, http_proxy: proxy.httpProxy } : {}),
    ...(proxy.httpsProxy ? { HTTPS_PROXY: proxy.httpsProxy, https_proxy: proxy.httpsProxy } : {}),
    NO_PROXY: proxy.noProxy,
    no_proxy: proxy.noProxy,
    ELECTRON_GET_USE_PROXY: '1',
    NODE_USE_ENV_PROXY: '1',
  }
}

/**
 * Route this process's own requests through the resolved proxy.
 *
 * @param {{ httpProxy?: string, httpsProxy?: string, noProxy: string } | undefined} proxy - Resolved policy.
 * @returns {void}
 */
export function installDesktopProxy(proxy) {
  if (!proxy) return
  setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: proxy.httpProxy, httpsProxy: proxy.httpsProxy, noProxy: proxy.noProxy }))
}
