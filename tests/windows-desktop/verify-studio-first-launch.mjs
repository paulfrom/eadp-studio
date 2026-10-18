/** Native development-machine check with fresh application data; not clean-machine installation acceptance. */
import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, open, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const repository = path.resolve(import.meta.dirname, '../..')
// Product assertions from client/studio/StudioPanel.tsx and components/StudioSettings.tsx.
const expectedStages = ['项目场景', '需求协同', '原型展示', '基线确认', '交接清单']
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

// The CDP connection is private to this launch; onboarding uses its normal UI,
// then Studio refreshes Host state and opens the empty login form.
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
    expectedStages, loginScope: 'empty-form-only-no-authentication-submitted',
  }
  const stdout = await open(path.join(run, 'stdout.log'), 'wx')
  const stderr = await open(path.join(run, 'stderr.log'), 'wx')
  let child, exited = false, client
  let hostRefreshRequested = false, hostRefreshStartedAt = 0
  try {
    child = spawn(executable, [`--user-data-dir=${paths['electron-user-data']}`, `--remote-debugging-port=${port}`], {
      cwd: run, env: environment, shell: false, windowsHide: false, stdio: ['ignore', stdout.fd, stderr.fd],
    })
    let launchError
    child.once('error', error => { launchError = error; exited = true })
    child.once('exit', (code, signal) => { exited = true; result.exit = { code, signal } })
    result.pid = child.pid
    const deadline = Date.now() + timeout
    let lastError, loginRequested = false
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
      const onboarding = await client.request('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const headings = [...document.querySelectorAll('[role="dialog"] h2')];
        const heading = headings.find(element => ['预览版说明', 'Preview Notice', '添加一个 API Key 开始使用', 'Add an API key to get started'].includes(element.textContent.trim()));
        const dialog = heading?.closest('[role="dialog"]');
        if (!dialog) return null;
        const button = [...dialog.querySelectorAll('button')].find(element => !element.disabled
          && ['继续', 'Continue', '稍后配置', 'Configure later'].includes(element.textContent.trim()));
        if (!button) return { waiting: true };
        const bounds = button.getBoundingClientRect();
        return { title: heading.textContent.trim(), x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      })()` })
      if (onboarding.result.value) {
        const step = onboarding.result.value
        if (!step.waiting) {
          await client.request('Input.dispatchMouseEvent', { type: 'mousePressed', x: step.x, y: step.y, button: 'left', clickCount: 1 })
          await client.request('Input.dispatchMouseEvent', { type: 'mouseReleased', x: step.x, y: step.y, button: 'left', clickCount: 1 })
          result.onboarding = [...new Set([...(result.onboarding ?? []), step.title])]
        }
        await delay(250); continue
      }
      const evaluation = await client.request('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const panel = document.querySelector('[data-studio-panel="studio"]');
        const bounds = panel?.getBoundingClientRect();
        const mainSlot = panel?.closest('[data-slot="main"]');
        let mainContainer = mainSlot;
        while (mainContainer && getComputedStyle(mainContainer).display === 'contents') mainContainer = mainContainer.parentElement;
        const mainBounds = mainContainer?.getBoundingClientRect();
        const visible = element => {
          if (!element) return false;
          const box = element.getBoundingClientRect(), style = getComputedStyle(element);
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const text = element => element?.textContent.trim() ?? '';
        const main = panel?.querySelector('main');
        const sidebar = panel?.querySelector('aside[aria-label="工作台导航"]');
        const navigation = [...(sidebar?.querySelectorAll('nav > button') ?? [])];
        // The direct spans contain the decorative icon, stage name, then chevron.
        const stageLabels = navigation.map(button => text(button.querySelector(':scope > span:nth-of-type(2)')));
        const expectedStages = ${JSON.stringify(expectedStages)};
        const welcomeHeading = [...(main?.querySelectorAll('h2') ?? [])].find(element => text(element) === '从一个项目开始');
        const welcome = welcomeHeading?.parentElement;
        const loginEntry = [...(main?.querySelectorAll('button') ?? [])].find(button => text(button) === '登录协同工作台');
        const accountLogin = [...(sidebar?.querySelectorAll('button') ?? [])].find(button => text(button) === '登录');
        const settingsEntry = [...(sidebar?.querySelectorAll('button') ?? [])].find(button => text(button).startsWith('设置'));
        const sidebarLogout = [...(sidebar?.querySelectorAll('button') ?? [])].find(button => text(button) === '退出');
        const newProject = [...(sidebar?.querySelectorAll('button') ?? [])].find(button => text(button) === '＋ 新建 / 获取项目');
        const project = sidebar?.querySelector('#studio-project');
        const dialog = panel?.querySelector('dialog[open][aria-labelledby="studio-settings-title"]');
        const form = dialog?.querySelector('form');
        const username = form?.querySelector('input[autocomplete="username"]');
        const password = form?.querySelector('input[type="password"]');
        const submit = [...(form?.querySelectorAll('button') ?? [])].find(button => button.type === 'submit');
        const luminance = color => {
          const channels = color.match(/[\\d.]+/g)?.slice(0, 3).map(Number);
          if (!channels || channels.length !== 3) return NaN;
          return channels.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; })
            .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        };
        const background = dialog ? luminance(getComputedStyle(dialog).backgroundColor) : NaN;
        const readable = !!dialog && [...dialog.querySelectorAll('h2, label, p')].every(element => {
          const foreground = luminance(getComputedStyle(element).color);
          return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) >= 4.5;
        });
        return { url: location.href, readyState: document.readyState, visibility: document.visibilityState,
          panelCount: document.querySelectorAll('[data-studio-panel="studio"]').length,
          interactive: !!panel && !panel.closest('[inert]'),
          visible: !!bounds && bounds.width > 0 && bounds.height > 0 && getComputedStyle(panel).visibility !== 'hidden',
          fillsMainArea: !!bounds && !!mainBounds && mainBounds.width > 0 && mainBounds.height > 0
            && ['x','y','width','height'].every(key => Math.abs(bounds[key] - mainBounds[key]) <= 2),
          stageLabels,
          fiveStageNavigation: navigation.length === expectedStages.length && stageLabels.every((label, index) => label === expectedStages[index])
            && navigation.every(button => visible(button) && !button.disabled)
            && navigation.filter(button => button.getAttribute('aria-current') === 'page').length === 1
            && navigation[0]?.getAttribute('aria-current') === 'page' && text(main?.querySelector('h1')) === expectedStages[0],
          disconnected: !!main && text(main.querySelector('header')).includes('等待连接')
            && visible(accountLogin) && !accountLogin.disabled && visible(newProject) && newProject.disabled
            && visible(settingsEntry) && !sidebarLogout
            && !!project && project.value === '' && project.options.length === 1,
          welcome: visible(welcomeHeading) && text(welcome).includes('登录协同工作台，创建或打开项目。')
            && text(welcome).includes('场景、需求与原型将在这里持续沉淀。') && text(welcome).includes('一个项目，对应一个 Git 仓库'),
          loginEntry: visible(loginEntry) && !loginEntry.disabled,
          refreshBusy: [...(panel?.querySelectorAll('header button') ?? [])].find(button => text(button) === '刷新')?.disabled !== false,
          alerts: [...(panel?.querySelectorAll('[role="alert"]') ?? [])].map(element => text(element)),
          loginDialog: { visible: visible(dialog), title: text(dialog?.querySelector('#studio-settings-title')),
            readable,
            emptyUsername: visible(username) && username.required && username.type === 'text' && username.value === '',
            emptyPassword: visible(password) && password.required && password.autocomplete === 'current-password' && password.value === '',
            submitReady: visible(submit) && !submit.disabled && text(submit) === '登录协同工作台' },
          bounds: bounds?.toJSON(), mainBounds: mainBounds?.toJSON(), viewport: { width: innerWidth, height: innerHeight } };
      })()` })
      if (evaluation.exceptionDetails) throw new Error('Studio DOM evaluation failed.')
      result.dom = evaluation.result.value
      result.checks = {
        singleVisibleMainPanel: result.dom.panelCount === 1 && result.dom.visible && result.dom.fillsMainArea && result.dom.visibility === 'visible',
        interactive: result.dom.interactive,
        fiveStageNavigation: result.dom.fiveStageNavigation, disconnected: result.dom.disconnected,
        welcome: result.dom.welcome, loginEntry: result.dom.loginEntry,
        loginForm: result.dom.loginDialog.visible && result.dom.loginDialog.title === '设置'
          && result.dom.loginDialog.emptyUsername && result.dom.loginDialog.emptyPassword && result.dom.loginDialog.submitReady && result.dom.loginDialog.readable,
        hostState: hostRefreshRequested && Date.now() - hostRefreshStartedAt >= 200 && !result.dom.refreshBusy && result.dom.alerts.length === 0,
      }
      const workspaceReady = Object.entries(result.checks).filter(([name]) => name !== 'loginForm' && name !== 'hostState').every(([, passed]) => passed)
      if (workspaceReady && !hostRefreshRequested) {
        const refreshed = await client.request('Runtime.evaluate', { returnByValue: true, expression: `(() => {
          const panel = document.querySelector('[data-studio-panel="studio"]');
          const button = [...panel.querySelectorAll('header button')].find(element => element.textContent.trim() === '刷新');
          if (!button || button.disabled) return false;
          button.click(); return true;
        })()` })
        if (refreshed.exceptionDetails || refreshed.result.value !== true) throw new Error('Studio Host state refresh could not start.')
        hostRefreshRequested = true; hostRefreshStartedAt = Date.now(); await delay(250); continue
      }
      if (workspaceReady && result.checks.hostState && !loginRequested) {
        const opened = await client.request('Runtime.evaluate', { returnByValue: true, expression: `(() => {
          const panel = document.querySelector('[data-studio-panel="studio"]');
          const button = [...panel.querySelectorAll('main button')].find(element => element.textContent.trim() === '登录协同工作台');
          if (!button || button.disabled) return false;
          button.click(); return true;
        })()` })
        if (opened.exceptionDetails || opened.result.value !== true) throw new Error('Studio login entry could not open its form.')
        loginRequested = true; await delay(100); continue
      }
      if (workspaceReady && result.checks.hostState && result.checks.loginForm) {
        let screenshotBytes
        if (values.screenshot) {
          // Let Electron paint the verified DOM before capturing its compositor surface.
          await client.request('Runtime.evaluate', { awaitPromise: true, expression:
            'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))' })
          await delay(1000)
          const captured = await client.request('Page.captureScreenshot', { format: 'png' })
          screenshotBytes = Buffer.from(captured.data, 'base64')
        }
        const stable = await client.request('Runtime.evaluate', { returnByValue: true, expression: `(() => {
          const panel = document.querySelector('[data-studio-panel="studio"]');
          return !!panel && !panel.closest('[inert]') && document.visibilityState === 'visible'
            && !!panel.querySelector('dialog[open][aria-labelledby="studio-settings-title"]')
            && !document.querySelector('[role="dialog"][aria-modal="true"]');
        })()` })
        if (stable.exceptionDetails || stable.result.value !== true) { await delay(250); continue }
        if (screenshotBytes) {
          await writeFile(path.join(run, 'studio.png'), screenshotBytes, { flag: 'wx' })
          result.screenshot = path.join(run, 'studio.png')
        }
        result.status = 'passed'
        break
      }
      await delay(250)
    }
    if (result.status !== 'passed') throw new Error(`Current full Studio first launch did not pass before timeout. Missing checks: ${Object.entries(result.checks ?? { fullStudio: false }).filter(([, passed]) => !passed).map(([name]) => name).join(', ')}.${lastError ? ` Last CDP error: ${lastError.message}` : ''}`)
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
