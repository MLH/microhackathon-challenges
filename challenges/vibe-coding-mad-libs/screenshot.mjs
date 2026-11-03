// Saves screenshot.png in the current directory: the participant's app as its
// first screen looks at 1280x800, for the gallery.
//   node screenshot.mjs [url]   (default http://127.0.0.1:4321/, the preview)
// Runs the station's Google Chrome headless with a throwaway profile and
// captures the page over the DevTools protocol; Chrome's own --screenshot flag
// can stall without writing a file. Node built-ins only.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DEFAULT_URL = 'http://127.0.0.1:4321/'
const OUTPUT_FILE = 'screenshot.png'
const VIEWPORT = { width: 1280, height: 800 }

/** Names a Chrome to use instead of the standard installs, as `boothstrap dev` does. */
const CHROME_PATH_VARIABLE = 'CHROME_PATH'

/** Where Google Chrome installs on macOS and Linux. */
const INSTALLED_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
]

/**
 * The whole helper, the preview check and Chrome's start included, gives up
 * after this. The skill gives its command at least twice as long, so the
 * helper always stops Chrome itself.
 */
const CAPTURE_TIMEOUT_MS = 30_000

/** How long Chrome gets to exit after SIGTERM before it is killed. */
const STOP_GRACE_MS = 2_000

/**
 * Chrome's helper processes can still write to the profile for a moment
 * after Chrome exits, so the profile counts as removed only once it has
 * stayed gone this long, within the overall limit after it.
 */
const PROFILE_QUIET_MS = 300
const PROFILE_REMOVAL_LIMIT_MS = 5_000

/**
 * Signals a person or a parent can send to end the helper early. Pi's bash
 * tool instead SIGKILLs the command's whole process group on abort or
 * timeout; that can't be caught, but Chrome shares the group, so it reaches
 * Chrome too.
 */
const INTERRUPTS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** How often to look for Chrome's first page while it opens. */
const PAGE_POLL_INTERVAL_MS = 50

/** Lets the app's own script draw its first screen after the load event. */
const SETTLE_MS = 500

const DEVTOOLS_LISTENING = /DevTools listening on (ws:\/\/\S+)/

/** Resolves after `milliseconds`. */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Returns the Chrome executable: `CHROME_PATH` when set, else the first
 * standard install that exists. Throws when `CHROME_PATH` names a missing
 * file or no Chrome is installed.
 */
export function findChrome(environment = process.env, candidates = INSTALLED_CHROME_PATHS) {
  const configured = environment[CHROME_PATH_VARIABLE] ?? ''
  if (configured !== '') {
    if (!existsSync(configured)) throw new Error(`${CHROME_PATH_VARIABLE} is ${configured}, which does not exist`)

    return configured
  }

  const installed = candidates.find((candidate) => existsSync(candidate))
  if (!installed) throw new Error(`no Google Chrome found; set ${CHROME_PATH_VARIABLE} to Chrome's executable`)

  return installed
}

/** Throws unless `url` answers with a 2xx status before `signal` aborts. */
async function assertAnswering(url, signal) {
  try {
    const response = await fetch(url, { signal })
    await response.arrayBuffer()
    if (response.ok) return
  } catch {
    // Reported below with the URL.
  }

  throw new Error(`${url} is not answering; is the preview running?`)
}

/**
 * Starts headless Chrome with `profile` as its user-data directory. Returns
 * the child at once, so a caller can always stop it, and `browserEndpoint`, a
 * promise of its DevTools endpoint that rejects if Chrome exits first.
 */
function launchChrome(executable, profile) {
  // Chrome puts its singleton socket in its temporary directory, and a deep
  // session TMPDIR passes the Unix socket path limit and aborts Chrome. A
  // relative one, resolved from the profile, keeps the path short and the
  // socket inside the profile.
  const shortTemporaryDirectory = { TMPDIR: '.', MAC_CHROMIUM_TMPDIR: '.' }
  const child = spawn(executable, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    // A login Keychain lookup can prompt or block on macOS; the station's own launcher passes this too.
    '--use-mock-keychain',
    '--disable-background-networking',
    '--disable-component-update',
    '--hide-scrollbars',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ], {
    cwd: profile,
    env: { ...process.env, ...shortTemporaryDirectory },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const browserEndpoint = new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4096)
      const listening = DEVTOOLS_LISTENING.exec(stderr)
      if (listening) resolve(listening[1])
    })
    child.once('error', (error) => reject(new Error(`Chrome did not start: ${error.message}`)))
    child.once('exit', (code, signal) => reject(new Error(`Chrome exited (${signal ?? `code ${code}`}) before opening DevTools`)))
  })

  return { child, browserEndpoint }
}

/**
 * Returns the DevTools endpoint of Chrome's first page, found through the
 * browser endpoint's HTTP side. Chrome can open DevTools before that page, so
 * this polls until it appears; the capture deadline bounds the wait.
 */
async function findPageEndpoint(browserEndpoint) {
  const { host } = new URL(browserEndpoint)
  for (;;) {
    const response = await fetch(`http://${host}/json/list`)
    const targets = await response.json()
    const page = targets.find((target) => target.type === 'page')
    if (page) return page.webSocketDebuggerUrl

    await delay(PAGE_POLL_INTERVAL_MS)
  }
}

/**
 * Connects to a DevTools endpoint. Returns `send(method, params)`, resolving
 * with the result or throwing the protocol error; `nextEvent(method)`,
 * resolving when that event next arrives; and `close()`.
 */
async function connectDevTools(endpoint) {
  const socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error('could not connect to Chrome over DevTools'))
  })

  let lastId = 0
  const pendingCommands = new Map()
  const eventWaiters = new Map()
  socket.onclose = () => {
    pendingCommands.forEach(({ reject }) => reject(new Error('Chrome closed the DevTools connection')))
    pendingCommands.clear()
  }
  socket.onmessage = (message) => {
    const { id, method, result, error } = JSON.parse(message.data)
    if (pendingCommands.has(id)) {
      const { resolve, reject } = pendingCommands.get(id)
      pendingCommands.delete(id)
      if (error) reject(new Error(`${error.message} (DevTools)`))
      else resolve(result)
      return
    }

    eventWaiters.get(method)?.()
    eventWaiters.delete(method)
  }

  return {
    send(method, params = {}) {
      lastId += 1
      const id = lastId
      socket.send(JSON.stringify({ id, method, params }))

      return new Promise((resolve, reject) => pendingCommands.set(id, { resolve, reject }))
    },
    nextEvent(method) {
      return new Promise((resolve) => eventWaiters.set(method, resolve))
    },
    close() {
      socket.close()
    },
  }
}

/** Loads `url` in the page behind `devTools` at the viewport size and returns its first screen as PNG bytes. */
async function capturePage(devTools, url) {
  await devTools.send('Page.enable')
  await devTools.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false })

  const loaded = devTools.nextEvent('Page.loadEventFired')
  const navigation = await devTools.send('Page.navigate', { url })
  if (navigation.errorText) throw new Error(`Chrome could not open ${url}: ${navigation.errorText}`)
  await loaded
  await delay(SETTLE_MS)

  const { data } = await devTools.send('Page.captureScreenshot', { format: 'png' })

  return Buffer.from(data, 'base64')
}

/** True while `child` has started and not yet exited. */
function isRunning(child) {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null
}

/**
 * Asks Chrome to quit with SIGTERM, which also ends its helper processes, and
 * kills it if it hasn't exited after the grace period. Resolves once it has
 * exited, or at once if it never started.
 */
async function stopChrome(child) {
  if (!isRunning(child)) return

  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const killTimer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
  await exited
  clearTimeout(killTimer)
}

/**
 * Removes `profile`, again whenever a late Chrome helper process recreates
 * part of it, until it has stayed gone for the quiet period. Gives up after
 * the removal limit, leaving the rest for the session reset, which wipes
 * TMPDIR.
 */
async function removeProfile(profile) {
  const giveUpAt = Date.now() + PROFILE_REMOVAL_LIMIT_MS
  while (Date.now() < giveUpAt) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
    await delay(PROFILE_QUIET_MS)
    if (!existsSync(profile)) return
  }
}

/**
 * Until the returned function is called, makes an interrupt kill Chrome,
 * remove `profile`, and exit 1, since a signal skips `finally` blocks.
 */
function cleanUpOnInterrupt(child, profile) {
  const onInterrupt = () => {
    if (isRunning(child)) child.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
    process.exit(1)
  }
  INTERRUPTS.forEach((signal) => process.once(signal, onInterrupt))

  return () => INTERRUPTS.forEach((signal) => process.off(signal, onInterrupt))
}

/**
 * Rejects `expired` and aborts `signal` after `milliseconds`, with a message
 * naming the limit; `clear()` cancels it.
 */
function deadline(milliseconds) {
  const controller = new AbortController()
  const reason = new Error(`the screenshot took longer than ${milliseconds} ms`)
  let timer
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(reason)
      reject(reason)
    }, milliseconds)
  })

  return { expired, signal: controller.signal, clear: () => clearTimeout(timer) }
}

/**
 * Captures `url` with the Chrome `findChrome` picks and writes the PNG to
 * `outputPath`, replacing any file or link there. Throws, writing nothing,
 * when the page isn't answering, Chrome is missing or fails, or the whole
 * capture takes longer than `timeoutMs`. Chrome's profile lives in TMPDIR and
 * is removed, with Chrome stopped, on every outcome but a SIGKILL, which
 * leaves the profile for the session's reset.
 */
export async function saveScreenshot({ url, outputPath, environment = process.env, timeoutMs = CAPTURE_TIMEOUT_MS }) {
  const timeout = deadline(timeoutMs)
  let chrome
  let profile
  let stopCleaningUpOnInterrupt = () => {}
  let devTools
  try {
    const capture = (async () => {
      await assertAnswering(url, timeout.signal)
      const executable = findChrome(environment)
      timeout.signal.throwIfAborted()

      profile = mkdtempSync(path.join(tmpdir(), 'mad-libs-screenshot-'))
      chrome = launchChrome(executable, profile)
      stopCleaningUpOnInterrupt = cleanUpOnInterrupt(chrome.child, profile)
      devTools = await connectDevTools(await findPageEndpoint(await chrome.browserEndpoint))

      return capturePage(devTools, url)
    })()
    // After a timeout the capture still settles; its failure is already reported.
    capture.catch(() => {})
    const png = await Promise.race([capture, timeout.expired])

    rmSync(outputPath, { force: true })
    writeFileSync(outputPath, png, { flag: 'wx' })
  } finally {
    timeout.clear()
    devTools?.close()
    if (chrome) await stopChrome(chrome.child)
    if (profile) await removeProfile(profile)
    stopCleaningUpOnInterrupt()
  }
}

if (import.meta.main) {
  const url = process.argv[2] ?? DEFAULT_URL
  try {
    await saveScreenshot({ url, outputPath: path.resolve(OUTPUT_FILE) })
    process.stdout.write(`Saved ${OUTPUT_FILE} (${VIEWPORT.width}x${VIEWPORT.height}) of ${url}\n`)
  } catch (error) {
    process.stderr.write(`vibe-coding-mad-libs: ${error.message}\n`)
    process.exitCode = 1
  }
}
