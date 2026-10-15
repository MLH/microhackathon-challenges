// The cleanup hook: asks the page server setup started to shut down, waits
// for it to stop answering, and removes .birdsbirdbirds/. Safe to run twice,
// after a crash, and after a failed setup; bird.png and bird.json stay.

import { readFileSync, rmSync } from 'node:fs'

import { sha256Hex } from '../server.mjs'
import { delay, fetchInstance, HEALTH_POLL_INTERVAL_MS, statePaths, workspaceFromEnvironment } from './state.mjs'

const SHUTDOWN_REQUEST_TIMEOUT_MS = 1000
const STOP_WAIT_TIMEOUT_MS = 3000

/** The `{ port, token }` setup recorded, or undefined when there is none or it is unreadable. */
function readServerRecord(serverFile) {
  try {
    const { port, token } = JSON.parse(readFileSync(serverFile, 'utf8'))
    if (!Number.isInteger(port) || typeof token !== 'string') return undefined

    return { port, token }
  } catch {
    return undefined
  }
}

/** Asks the server to shut down; a server that is already gone is fine. */
async function requestShutdown({ port, token }) {
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST',
      headers: { 'X-Bird-Token': token },
      signal: AbortSignal.timeout(SHUTDOWN_REQUEST_TIMEOUT_MS),
    })
  } catch {
    // Nothing answering means there is nothing left to stop.
  }
}

/** Waits until the port no longer answers as this server, up to the stop timeout. */
async function waitUntilStopped({ port, token }) {
  const ourInstance = sha256Hex(token)
  const deadline = Date.now() + STOP_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await fetchInstance(port, 500) !== ourInstance) return
    await delay(HEALTH_POLL_INTERVAL_MS)
  }

  console.error(`birdsbirdbirds cleanup: the page server on port ${port} is still answering; teardown will stop it`)
}

/** Stops the recorded server, if any, and removes the state directory. */
async function cleanUp(environment) {
  const { directory, serverFile } = statePaths(workspaceFromEnvironment(environment))
  const record = readServerRecord(serverFile)

  if (record !== undefined) {
    await requestShutdown(record)
    await waitUntilStopped(record)
  }
  rmSync(directory, { recursive: true, force: true })
}

try {
  await cleanUp(process.env)
  process.exit(0)
} catch (error) {
  console.error(`birdsbirdbirds cleanup: ${error.stack}`)
  process.exit(1)
}
