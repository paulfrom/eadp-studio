/** Native development-machine check with fresh application data; not clean-machine installation acceptance. */
import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, open, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const repository = path.resolve(import.meta.dirname, '../..')
const usage = 'node tests/windows-desktop/verify-studio-first-launch.mjs --exe <absolute packaged .exe> [--timeout-ms 120000] [--screenshot]'

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

// The one CDP connection is private to this launch, with no page interaction.
async function connect(url, deadline) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let sequence = 0
  const rejectPending = error => {
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(`CDP: ${message.error.message}`))
    else request.resolve(message.result)
  })
  socket.addEventListener('close', () => rejectPending(new Error('CDP connection closed')))
  const connectionTimeout = setTimeout(() => socket.close(), Math.max(1, deadline - Date.now()))
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true })
      socket.addEventListener('close', () => reject(new Error('CDP connection closed before opening')), { once: true })
    })
  } catch (error) {
    clearTimeout(connectionTimeout)
    throw error
  }
  return {
    async request(method, params = {}) {
      const id = ++sequence
      const timeout = setTimeout(() => {
        pending.get(id)?.reject(new Error(`CDP timed out: ${method}`))
        pending.delete(id)
      }, Math.max(1, Math.min(10_000, deadline - Date.now())))
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          socket.send(JSON.stringify({ id, method, params }))
        })
      } finally { clearTimeout(timeout) }
    },
    close() { clearTimeout(connectionTimeout); socket.close() },
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    exe: { type: 'string' }, 'timeout-ms': { type: 'string', default: '120000' },
    screenshot: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } })
  if (values.help) { console.log(usage); return }
  if (process.platform !== 'win32') throw new Error('This check requires native Windows.')
  if (!values.exe || !path.isAbsolute(values.exe) || path.extname(values.exe).toLowerCase() !== '.exe') {
    throw new Error(usage)
  }
  const timeout = Number(values['timeout-ms'])
  if (!Number.isSafeInteger(timeout) || timeout < 5000 || timeout > 600_000) throw new Error('timeout-ms must be 5000 through 600000.')
  const executable = await realpath(values.exe)
  if (!(await stat(executable)).isFile()) throw new Error('Packaged executable must be a regular file.')
  const acceptanceRoot = path.join(repository, '.local/acceptance')
  await mkdir(acceptanceRoot, { recursive: true })
  if (await realpath(acceptanceRoot) !== acceptanceRoot) throw new Error('Acceptance root must not redirect through a link.')
  const run = await mkdtemp(path.join(acceptanceRoot, 'studio-first-launch-'))
  const paths = Object.fromEntries(['home', 'agents', 'electron-user-data', 'native-cache', 'os-home', 'appdata', 'localappdata', 'tmp']
    .map(name => [name, path.join(run, name)]))
  await Promise.all(Object.values(paths).map(directory => mkdir(directory)))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^DSH_|^ELECTRON_|^NODE_OPTIONS$|^NODE_PATH$|^(?:npm|pnpm|corepack)_/iu.test(name)
    && !/^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|NARB_NATIVE_CACHE_DIR|XDG_(?:CONFIG|CACHE|STATE)_HOME)$/iu.test(name)))
  Object.assign(environment, {
    DSH_HOME: paths.home, DSH_AGENTS_HOME: paths.agents, NARB_NATIVE_CACHE_DIR: paths['native-cache'],
    HOME: paths['os-home'], USERPROFILE: paths['os-home'], APPDATA: paths.appdata, LOCALAPPDATA: paths.localappdata,
    XDG_CONFIG_HOME: paths.home, XDG_CACHE_HOME: paths.home, XDG_STATE_HOME: paths.home,
    TEMP: paths.tmp, TMP: paths.tmp,
  })
  const port = await availablePort()
  const result = {
    status: 'failed', scope: 'development-machine-fresh-application-data', cleanMachineInstallationVerified: false,
    startedAt: new Date().toISOString(), executable, runDirectory: run, userData: paths['electron-user-data'],
    dshHome: paths.home, agentsHome: paths.agents, debugPort: port,
  }
  const stdout = await open(path.join(run, 'stdout.log'), 'wx')
  const stderr = await open(path.join(run, 'stderr.log'), 'wx')
  let child, exited = false, client
  try {
    child = spawn(executable, [`--user-data-dir=${paths['electron-user-data']}`, `--remote-debugging-port=${port}`], {
      cwd: run, env: environment, shell: false, windowsHide: false, stdio: ['ignore', stdout.fd, stderr.fd],
    })
    let launchError
    child.once('error', error => { launchError = error; exited = true })
    child.once('exit', (code, signal) => { exited = true; result.exit = { code, signal } })
    result.pid = child.pid
    const deadline = Date.now() + timeout
    let lastError
    while (Date.now() < deadline) {
      if (launchError) throw launchError
      if (exited) throw new Error('Packaged application exited before Studio verification.')
      let targets
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
        if (!response.ok) throw new Error(`CDP target list: HTTP ${response.status}`)
        targets = await response.json()
      } catch (error) { lastError = error; await delay(250); continue }
      result.targets = targets.map(({ type, url, title }) => ({ type, url, title }))
      if (targets.some(target => target.type === 'page' && /\/renderer\/welcome\.html(?:[?#]|$)/u.test(target.url.replaceAll('\\', '/')))) {
        throw new Error('First launch opened the vendor Welcome page; no skip or credential was supplied.')
      }
      const page = targets.find(target => target.type === 'page' && target.url.startsWith('dsh-app://app/'))
      if (!page) { await delay(250); continue }
      if (!client) {
        client = await connect(page.webSocketDebuggerUrl, deadline)
        await client.request('Page.bringToFront')
      }
      const evaluation = await client.request('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const panel = document.querySelector('[data-studio-panel="studio"]');
        const bounds = panel?.getBoundingClientRect();
        const mainSlot = panel?.closest('[data-slot="main"]');
        let mainContainer = mainSlot;
        while (mainContainer && getComputedStyle(mainContainer).display === 'contents') mainContainer = mainContainer.parentElement;
        const mainBounds = mainContainer?.getBoundingClientRect();
        return { url: location.href, readyState: document.readyState, visibility: document.visibilityState,
          panelCount: document.querySelectorAll('[data-studio-panel="studio"]').length,
          visible: !!bounds && bounds.width > 0 && bounds.height > 0 && getComputedStyle(panel).visibility !== 'hidden',
          fillsMainArea: !!bounds && !!mainBounds && mainBounds.width > 0 && mainBounds.height > 0
            && ['x','y','width','height'].every(key => Math.abs(bounds[key] - mainBounds[key]) <= 2),
          bounds: bounds?.toJSON(), mainBounds: mainBounds?.toJSON(), viewport: { width: innerWidth, height: innerHeight } };
      })()` })
      if (evaluation.exceptionDetails) throw new Error('Studio DOM evaluation failed.')
      result.dom = evaluation.result.value
      if (result.dom.panelCount === 1 && result.dom.visible && result.dom.fillsMainArea && result.dom.visibility === 'visible') {
        if (values.screenshot) {
          // Let Electron paint the verified DOM before capturing its compositor surface.
          await client.request('Runtime.evaluate', { awaitPromise: true, expression:
            'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))' })
          await delay(1000)
          const captured = await client.request('Page.captureScreenshot', { format: 'png' })
          await writeFile(path.join(run, 'studio.png'), Buffer.from(captured.data, 'base64'), { flag: 'wx' })
          result.screenshot = path.join(run, 'studio.png')
        }
        result.status = 'passed'
        break
      }
      await delay(250)
    }
    if (result.status !== 'passed') throw new Error(`Studio marker was not visible before timeout.${lastError ? ` Last CDP error: ${lastError.message}` : ''}`)
  } catch (error) {
    result.error = error.message
    process.exitCode = 1
  } finally {
    client?.close()
    // Never load a PID from disk or kill an exited/reused PID. Only this live
    // ChildProcess owns the tree selected by the fixed taskkill invocation.
    if (child?.pid && !exited && child.exitCode === null && child.signalCode === null) {
      try {
        await promisify(execFile)(path.join(process.env.SystemRoot, 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
        result.cleanup = 'owned-process-tree-terminated'
      } catch (error) {
        // taskkill can report a descendant already gone while the owned root's
        // exit notification is still pending in Node's event loop.
        await delay(1000)
        if (!exited) { result.cleanupError = error.message; result.status = 'failed'; process.exitCode = 1 }
        else result.cleanup = 'owned-process-exited-during-cleanup'
      }
    } else result.cleanup = 'owned-process-already-exited'
    await stdout.close()
    await stderr.close()
    result.finishedAt = new Date().toISOString()
    await writeFile(path.join(run, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    console.log(`${result.status}: ${path.join(run, 'result.json')}`)
  }
}

await main().catch(error => { console.error(error.message); process.exitCode = 1 })
