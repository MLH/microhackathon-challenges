// The preview server for the participant's app, run by the hooks:
//   node preview.mjs start <workspace>   (setup) serve <workspace>/index.html
//   node preview.mjs stop <workspace>    (cleanup) stop that server
// `start` runs the server as a child in its own process group, which is
// setup's, so teardown stops it, and exits 0 once it answers. The child gets a
// random token, saved in the workspace, that `stop` must show, so cleanup
// never stops a listener it didn't start. Node built-ins only.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

const HOST = '127.0.0.1'

/** The skill gives participants this port; tests override it to run side by side. */
const DEFAULT_PORT = 4321

/** Where `start` saves the port and token for `stop`. */
const STATE_FILE = '.preview-state.json'

const TOKEN_HEADER = 'x-preview-token'
const STOP_PATH = '/__stop'
const RELOAD_PATH = '/__reload'

/** How long `start` waits for the server to answer, and `stop` for it to go. */
const READY_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50

/** Editors truncate then write, so reloading on the first change can show an empty page. */
const RELOAD_DEBOUNCE_MS = 100

/** Larger files are refused rather than read into memory. */
const MAX_APP_BYTES = 2_000_000

/** Blocks every request but the page's own inline code and its reload stream. Allows eval, which generated calculators use. */
const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' data:; media-src data:; font-src data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"

/** Reloads the page whenever index.html changes. */
const RELOAD_SCRIPT = `<script>new EventSource('${RELOAD_PATH}').onmessage = () => location.reload()</script>`

const WAITING_PAGE = '<!doctype html><title>Waiting for your app</title><p>Waiting for Pi to write index.html…</p>'

/** Reads the port from MAD_LIBS_PREVIEW_PORT, or the default. Throws on a bad value. */
function readPort() {
  const configured = process.env.MAD_LIBS_PREVIEW_PORT
  if (configured === undefined) return DEFAULT_PORT

  const port = Number(configured)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MAD_LIBS_PREVIEW_PORT must be a port number, not ${configured}`)
  }

  return port
}

/** Resolves after `milliseconds`. */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** True when the request carries `token`, compared in constant time. */
function carriesToken(request, token) {
  const given = Buffer.from(String(request.headers[TOKEN_HEADER] ?? ''))
  const expected = Buffer.from(token)

  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * Reads `workspace/index.html` without following a symlink out of the
 * workspace. Returns its text, or undefined when there is none yet.
 */
function readApp(workspace) {
  let descriptor
  try {
    descriptor = openSync(path.join(workspace, 'index.html'), constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }

  try {
    const stats = fstatSync(descriptor)
    if (!stats.isFile() || stats.size > MAX_APP_BYTES) throw new Error('index.html is not a small regular file')

    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

/** Sends `page` with the reload script added and the lockdown headers. */
function sendPage(response, page) {
  const closingBody = /<\/body\s*>/i
  const withReload = closingBody.test(page) ? page.replace(closingBody, `${RELOAD_SCRIPT}</body>`) : page + RELOAD_SCRIPT
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  response.end(withReload)
}

/**
 * Serves `workspace/index.html` at `/` until stopped, telling the parent over
 * IPC whether it listens. A POST to the stop path with the token ends it.
 */
function serve({ workspace, port, token }) {
  const reloadStreams = new Set()

  const server = createServer((request, response) => {
    // Loopback alone doesn't stop a page on a hostname rebound to 127.0.0.1.
    if (request.headers.host !== `${HOST}:${port}`) {
      response.writeHead(403).end()
      return
    }

    const requestPath = (request.url ?? '').split('?', 1)[0]
    if (requestPath === STOP_PATH && request.method === 'POST') {
      if (!carriesToken(request, token)) {
        response.writeHead(403).end()
        return
      }

      response.writeHead(204).end(shutDown)
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    if (requestPath === RELOAD_PATH) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      response.flushHeaders()
      reloadStreams.add(response)
      request.on('close', () => reloadStreams.delete(response))
      return
    }
    if (requestPath !== '/' && requestPath !== '/index.html') {
      response.writeHead(404).end()
      return
    }

    try {
      sendPage(response, readApp(workspace) ?? WAITING_PAGE)
    } catch {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('index.html could not be read')
    }
  })

  let reloadTimer
  const watcher = watch(workspace, (_eventType, filename) => {
    if (filename !== 'index.html') return

    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => reloadStreams.forEach((stream) => stream.write('data: reload\n\n')), RELOAD_DEBOUNCE_MS)
  })

  /** Closes every connection and the watcher, so the process exits. */
  function shutDown() {
    clearTimeout(reloadTimer)
    watcher.close()
    reloadStreams.forEach((stream) => stream.end())
    server.close()
    server.closeAllConnections()
  }

  server.once('error', (error) => {
    watcher.close()
    process.send({ listening: false, error: error.code === 'EADDRINUSE' ? `port ${port} is already in use` : error.message })
    process.disconnect()
  })
  server.listen(port, HOST, () => {
    process.send({ listening: true }, () => process.disconnect())
  })
  process.once('SIGTERM', shutDown)
}

/** Resolves true once `url` answers with 200 within the ready timeout. */
async function waitUntilAnswering(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) })
      await response.arrayBuffer()
      if (response.ok) return true
    } catch {
      // Not answering yet.
    }
    await delay(POLL_INTERVAL_MS)
  }

  return false
}

/** Resolves with the server child's first IPC report, or a failure if it exits or stalls. */
function waitForReport(child) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ listening: false, error: 'it did not listen in time' }), READY_TIMEOUT_MS)
    child.once('message', (report) => {
      clearTimeout(timer)
      resolve(report)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      resolve({ listening: false, error: 'it exited' })
    })
  })
}

/**
 * Starts the server for `workspace` as a child and returns once it answers,
 * leaving it running. Throws, with the child stopped, when it can't start.
 */
async function start(workspace) {
  const port = readPort()
  const token = randomBytes(32).toString('hex')
  const child = spawn(process.execPath, [import.meta.filename, 'serve', workspace], {
    env: { ...process.env, MAD_LIBS_PREVIEW_PORT: String(port), MAD_LIBS_PREVIEW_TOKEN: token },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })

  try {
    const report = await waitForReport(child)
    if (!report.listening) throw new Error(`the preview server did not start: ${report.error}`)

    writeFileSync(path.join(workspace, STATE_FILE), JSON.stringify({ port, token }), { mode: 0o600 })
    if (!(await waitUntilAnswering(`http://${HOST}:${port}/`))) {
      throw new Error(`the preview server on port ${port} did not answer`)
    }
  } catch (error) {
    child.kill()
    throw error
  }

  child.unref()
  if (child.connected) child.disconnect()
  process.stdout.write(`Preview: http://${HOST}:${port}/\n`)
}

/** Reads the saved port and token, or returns undefined when `start` never saved them. */
function readState(workspace) {
  try {
    return JSON.parse(readFileSync(path.join(workspace, STATE_FILE), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/** True when `error`, thrown by fetch, means nothing listens on the port. */
function isConnectionRefused(error) {
  return error.cause?.code === 'ECONNREFUSED'
}

/** True once nothing accepts connections on `port`. */
async function portClosed(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/`, { signal: AbortSignal.timeout(POLL_INTERVAL_MS * 10) })
    await response.arrayBuffer()

    return false
  } catch (error) {
    return isConnectionRefused(error)
  }
}

/**
 * Stops the server `start` left for `workspace`, then forgets it. Does
 * nothing when none was started, it is already gone, or another listener
 * holds the port and refuses the token. Throws, keeping the state, when the
 * server can't be reached or won't stop in time.
 */
async function stop(workspace) {
  const state = readState(workspace)
  if (!state) return

  const { port, token } = state
  let accepted = false
  try {
    const response = await fetch(`http://${HOST}:${port}${STOP_PATH}`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    })
    accepted = response.status === 204
  } catch (error) {
    if (!isConnectionRefused(error)) throw new Error(`the preview server on port ${port} did not answer the stop request: ${error.message}`)
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (accepted && !(await portClosed(port))) {
    if (Date.now() > deadline) throw new Error(`the preview server on port ${port} did not stop`)
    await delay(POLL_INTERVAL_MS)
  }

  rmSync(path.join(workspace, STATE_FILE), { force: true })
}

const [command, workspace] = process.argv.slice(2)
try {
  if (!workspace) throw new Error('usage: node preview.mjs start|stop|serve <workspace>')

  if (command === 'serve') {
    serve({ workspace, port: readPort(), token: process.env.MAD_LIBS_PREVIEW_TOKEN })
  } else if (command === 'start') {
    await start(workspace)
  } else if (command === 'stop') {
    await stop(workspace)
  } else {
    throw new Error(`unknown command ${command}; use start, stop, or serve`)
  }
} catch (error) {
  process.stderr.write(`vibe-coding-mad-libs: ${error.message}\n`)
  process.exitCode = 1
}
