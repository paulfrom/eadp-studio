import { canonical } from '@eadp/asset-domain'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Locator, type Page } from 'playwright-core'
import { allowPrototypeBrowserRequest, prototypeBrowserRoute, PrototypeBrowserRun, type PrototypeBrowserAction, type PrototypeBrowserScope } from './browser-scope.ts'
import { verifyPrototypeBrowserRuntime } from './browser-runtime.ts'

type Role = Parameters<Page['getByRole']>[0]
export type PrototypeLocator =
  | { by: 'role'; role: Role; name: string }
  | { by: 'label' | 'testId'; value: string }
export type PrototypeBrowserCommand =
  | { action: 'open'; route: string }
  | { action: 'click'; target: PrototypeLocator }
  | { action: 'fill'; target: PrototypeLocator; value: string }
  | { action: 'select'; target: PrototypeLocator; value: string }
  | { action: 'key'; target: PrototypeLocator; key: 'Enter' | 'Escape' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Space' }
  | { action: 'wait'; target: PrototypeLocator; state: 'visible' | 'hidden' }
  | { action: 'assert'; target: PrototypeLocator; condition: 'visible' | 'text' | 'value'; expected: string }
  | { action: 'trace'; durationMs: number }
  | { action: 'snapshot' | 'screenshot' | 'diagnostics' }

interface Diagnostic { kind: 'blocked' | 'console' | 'pageerror' | 'popup' | 'download'; detail: string }
export interface PrototypeBrowserProviderOptions {
  scope: PrototypeBrowserScope
  current(): Promise<PrototypeBrowserScope | undefined>
  /** Paths and digest originate in the installed product, never in a tool call. */
  runtime: { root: string; manifest: string; manifestSha256: string }
  /** Host-owned stores choose every path and preserve the actual attachment bytes. */
  attach(scope: PrototypeBrowserScope, kind: 'screenshot', bytes: Buffer): Promise<{ id: string; sha256: string }>
  captureTrace(scope: PrototypeBrowserScope, write: (filename: string) => Promise<void>): Promise<{ id: string; sha256: string; bytes: Buffer }>
  headless: boolean
  signal: AbortSignal
}

const roles = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'heading', 'dialog', 'alert', 'table', 'row', 'cell', 'option', 'tab', 'menuitem', 'listitem', 'switch', 'status'])
function bounded(value: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('浏览器操作参数无效')
  return value
}
function locator(page: Page, target: PrototypeLocator): Locator {
  if (!target || typeof target !== 'object') throw new Error('浏览器定位目标无效')
  if (target.by === 'role') {
    if (!roles.has(target.role)) throw new Error('浏览器角色不受支持')
    return page.getByRole(target.role, { name: bounded(target.name, 500), exact: true })
  }
  if (target.by === 'label') return page.getByLabel(bounded(target.value, 500), { exact: true })
  if (target.by === 'testId') return page.getByTestId(bounded(target.value, 500))
  throw new Error('浏览器定位方式不受支持')
}

/** Restricted browser primitive; this class alone does not expose tools to an Agent. */
export class PrototypeBrowserProvider {
  private constructor(private readonly scope: PrototypeBrowserScope, private readonly context: BrowserContext, private readonly page: Page, private readonly run: PrototypeBrowserRun, private readonly diagnostics: Diagnostic[], private readonly attach: PrototypeBrowserProviderOptions['attach'], private readonly captureTrace: PrototypeBrowserProviderOptions['captureTrace']) {}

  static async open(options: PrototypeBrowserProviderOptions): Promise<PrototypeBrowserProvider> {
    options.signal.throwIfAborted()
    const scope = structuredClone(options.scope)
    prototypeBrowserRoute(scope, '/')
    if (canonical(await options.current()) !== canonical(scope)) throw new Error('当前预览与浏览器验证身份不一致')
    const runtime = await verifyPrototypeBrowserRuntime(options.runtime.root, options.runtime.manifest, options.runtime.manifestSha256, options.headless ? 'headless' : 'headed')
    options.signal.throwIfAborted()
    if (canonical(await options.current()) !== canonical(scope)) throw new Error('预览已变化，未启动浏览器')
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []))
    let server: BrowserServer | undefined, browser: Browser | undefined, context: BrowserContext | undefined
    let closing: Promise<void> | undefined
    const closeResources = (): Promise<void> => {
      if (closing) return closing
      if (!server && !browser && !context) return Promise.resolve()
      closing = Promise.resolve().then(async () => {
        const graceful = (async () => {
          try { await context?.close() } finally {
            try { await browser?.close() } finally { await server?.close() }
          }
        })()
        let deadline: NodeJS.Timeout | undefined
        try {
          await Promise.race([graceful, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('浏览器进程树关闭超时')), 10_000) })])
        } catch (error) {
          if (!server) throw error
          await server.kill()
          await graceful.catch(() => {})
        } finally { if (deadline) clearTimeout(deadline) }
      })
      return closing
    }
    const cancel = (): void => { void closeResources().catch(() => {}) }
    options.signal.addEventListener('abort', cancel, { once: true })
    try {
      server = await chromium.launchServer({ executablePath: runtime.executablePath, headless: options.headless, chromiumSandbox: true, env, timeout: 15_000 })
      browser = await chromium.connect(server.wsEndpoint(), { timeout: 15_000 })
      options.signal.throwIfAborted()
      if (browser.version() !== runtime.manifest.chromiumVersion) throw new Error('浏览器版本与发行清单不匹配')
      context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, permissions: [], viewport: { width: 1280, height: 800 } })
      context.setDefaultTimeout(15_000)
      context.setDefaultNavigationTimeout(20_000)
      const diagnostics: Diagnostic[] = []
      const record = (kind: Diagnostic['kind'], detail: string): void => { diagnostics.push({ kind, detail: detail.slice(0, 2000) }); if (diagnostics.length > 200) diagnostics.shift() }
      let page: Page | undefined
      await context.route('**/*', async route => {
        const request = route.request()
        let allowed = false
        try {
          const frame = request.frame(), main = !!page && frame === page.mainFrame()
          const type = request.resourceType()
          allowed = !!page && frame.page() === page && ['GET', 'HEAD'].includes(request.method()) && ['document', 'script', 'stylesheet', 'image', 'font', 'media', 'other'].includes(type) && allowPrototypeBrowserRequest(scope, { url: request.url(), resourceType: type, isMainFrame: main })
        } catch { allowed = false }
        if (allowed) await route.continue()
        else { record('blocked', request.url()); await route.abort('blockedbyclient') }
      })
      await context.routeWebSocket(/.*/, async socket => { record('blocked', socket.url()); await socket.close() })
      page = await context.newPage()
      const ownedPage = page
      context.on('page', other => { if (other !== ownedPage) { record('popup', '新页面已拒绝'); void other.close().catch(() => {}) } })
      page.on('download', download => { record('download', '下载已拒绝'); void download.cancel().catch(() => {}) })
      page.on('filechooser', () => { record('blocked', '文件选择已拒绝') })
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
      page.on('console', message => record('console', `${message.type()}: ${message.text()}`))
      page.on('pageerror', error => record('pageerror', error.message))
      options.signal.throwIfAborted()
      if (canonical(await options.current()) !== canonical(scope)) throw new Error('预览已变化，浏览器能力未建立')
      options.signal.throwIfAborted()
      const run = new PrototypeBrowserRun(scope, options.current, closeResources)
      return new PrototypeBrowserProvider(scope, context, page, run, diagnostics, options.attach, options.captureTrace)
    } catch (error) {
      await closeResources()
      throw error
    } finally { options.signal.removeEventListener('abort', cancel) }
  }

  /** Only these bounded actions can reach Playwright; arbitrary scripts, paths and URLs are absent. */
  async execute(command: PrototypeBrowserCommand, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const cancel = (): void => { void this.run.close().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await this.run.run(command.action as PrototypeBrowserAction, signal, async (_scope, combined) => {
        if (command.action === 'open') {
          const url = prototypeBrowserRoute(this.scope, bounded(command.route, 2000))
          await this.page.goto(url, { waitUntil: 'domcontentloaded' })
          return { action: 'open', url: this.page.url() }
        }
        if (command.action === 'diagnostics') return { action: command.action, entries: structuredClone(this.diagnostics) }
        if (command.action === 'snapshot') {
          const snapshot = await this.page.locator('body').ariaSnapshot({ timeout: 15_000 })
          return { action: command.action, snapshot: snapshot.slice(0, 100_000), truncated: snapshot.length > 100_000 }
        }
        if (command.action === 'screenshot') {
          const bytes = await this.page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' })
          const attachment = await this.attach(this.scope, 'screenshot', bytes)
          if (!attachment.id || attachment.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('截图附件与原始字节不一致')
          return { action: command.action, attachment }
        }
        if (command.action === 'trace') {
          if (!Number.isSafeInteger(command.durationMs) || command.durationMs < 100 || command.durationMs > 5000) throw new Error('浏览器 trace 时长无效')
          let active = false
          try {
            await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false })
            active = true
            await delay(command.durationMs, undefined, { signal: combined })
            const captured = await this.captureTrace(this.scope, async filename => {
              await this.context.tracing.stop({ path: filename })
              active = false
            })
            if (!captured.id || captured.sha256 !== createHash('sha256').update(captured.bytes).digest('hex')) throw new Error('trace 附件与原始字节不一致')
            return { action: command.action, attachment: { id: captured.id, sha256: captured.sha256 } }
          } finally { if (active) await this.context.tracing.stop().catch(() => {}) }
        }
        const target = locator(this.page, command.target)
        if (command.action === 'click') await target.click()
        else if (command.action === 'fill') await target.fill(bounded(command.value, 10_000))
        else if (command.action === 'select') await target.selectOption(bounded(command.value, 500))
        else if (command.action === 'key') {
          if (!['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(command.key)) throw new Error('浏览器按键不受支持')
          await target.press(command.key)
        } else if (command.action === 'wait') {
          if (command.state !== 'visible' && command.state !== 'hidden') throw new Error('浏览器等待状态无效')
          await target.waitFor({ state: command.state })
        } else if (command.action === 'assert') {
          if (!['visible', 'text', 'value'].includes(command.condition)) throw new Error('浏览器断言方式无效')
          const expected = bounded(command.expected, 10_000)
          const actual = command.condition === 'visible' ? String(await target.isVisible()) : command.condition === 'text' ? await target.innerText() : await target.inputValue()
          return { action: command.action, condition: command.condition, expected, actual: actual.slice(0, 10_000), passed: actual === expected }
        } else throw new Error('浏览器操作不受支持')
        return { action: command.action, completed: true }
      })
    } finally { signal.removeEventListener('abort', cancel) }
  }

  /** Stop new actions, terminate the owned server process tree and await started work. */
  close(): Promise<void> { return this.run.close() }
}
