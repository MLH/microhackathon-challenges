// The setup hook: starts the page server in the background and exits once
// /health proves it is this attempt's server, so Pi starts with the page up.
// The server stays in setup's process group (never detached), so teardown's
// SIGTERM reaches it; its output goes to .birdsbirdbirds/server.log so the
// hook's own pipes close when the hook exits.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PORT, PORT_BUSY_EXIT_CODE, sha256Hex } from '../server.mjs'
import { delay, fetchInstance, HEALTH_POLL_INTERVAL_MS, statePaths, workspaceFromEnvironment } from './state.mjs'

const SERVER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')
const STARTUP_TIMEOUT_MS = 10_000

/** A setup failure whose message is shown to the participant as is. */
class SetupError extends Error {}

/** Reads BIRDSBIRDBIRDS_PORT (default 4322), failing on anything but a port number. */
function portFromEnvironment(environment) {
  const portText = environment.BIRDSBIRDBIRDS_PORT ?? String(DEFAULT_PORT)
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new SetupError(`BIRDSBIRDBIRDS_PORT must be a port number from 1 to 65535, got ${JSON.stringify(portText)}`)
  }

  return port
}

/** Spawns server.mjs with its output appended to `logFile`, unref'd so setup can exit while it runs. */
function spawnServer({ workspace, port, token, logFile }) {
  const logDescriptor = openSync(logFile, 'a')
  try {
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      env: {
        ...process.env,
        BIRDSBIRDBIRDS_WORKSPACE: workspace,
        BIRDSBIRDBIRDS_PORT: String(port),
        BIRDSBIRDBIRDS_TOKEN: token,
      },
      stdio: ['ignore', logDescriptor, logDescriptor],
    })
    child.unref()

    return child
  } finally {
    closeSync(logDescriptor)
  }
}

/**
 * Polls /health until it reports this token's hash. Fails when the child
 * exits first (naming the busy port for exit code 3) or after the timeout.
 */
async function waitUntilHealthy({ child, port, token, logFile }) {
  const expectedInstance = sha256Hex(token)
  let exitCode
  child.on('exit', (code, signal) => {
    exitCode = code ?? signal
  })

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exitCode === PORT_BUSY_EXIT_CODE) throw new SetupError(`port ${port} is busy; stop whatever is using it`)
    if (exitCode !== undefined) throw new SetupError(`the page server stopped (${exitCode}) before it was ready:\n${readLogTail(logFile)}`)
    if (await fetchInstance(port, 500) === expectedInstance) return
    await delay(HEALTH_POLL_INTERVAL_MS)
  }

  child.kill()
  throw new SetupError(`the page server did not answer on port ${port} within ${STARTUP_TIMEOUT_MS / 1000} s; see ${logFile}`)
}

/** The last lines of the server log, for a failure message. */
function readLogTail(logFile) {
  try {
    return readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).join('\n')
  } catch {
    return `(no log at ${logFile})`
  }
}

/** Starts the server for the workspace and records `{ port, token }` for cleanup. */
async function setUp(environment) {
  const workspace = workspaceFromEnvironment(environment)
  const port = portFromEnvironment(environment)
  const { directory, serverFile, logFile } = statePaths(workspace)
  const token = randomBytes(32).toString('hex')

  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const child = spawnServer({ workspace, port, token, logFile })
  await waitUntilHealthy({ child, port, token, logFile })
  writeFileSync(serverFile, `${JSON.stringify({ port, token })}\n`, { mode: 0o600 })

  console.log(`birdsbirdbirds: page server ready at http://127.0.0.1:${port}/`)
}

try {
  await setUp(process.env)
  process.exit(0)
} catch (error) {
  console.error(`birdsbirdbirds setup: ${error instanceof SetupError ? error.message : error.stack}`)
  process.exit(1)
}
