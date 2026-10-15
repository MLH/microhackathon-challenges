// Where setup leaves the running server's details for cleanup, and how both
// hooks ask the server who it is. State lives in <workspace>/.birdsbirdbirds/
// because cleanup may run in a fresh process after a crash.

import path from 'node:path'

export const HEALTH_POLL_INTERVAL_MS = 100

/** The attempt's workspace: $BOOTHSTRAP_WORKSPACE, or the current directory when run by hand. */
export function workspaceFromEnvironment(environment) {
  const workspace = environment.BOOTHSTRAP_WORKSPACE

  return path.resolve(workspace === undefined || workspace === '' ? process.cwd() : workspace)
}

/** Paths of the state directory and the files in it for `workspace`. */
export function statePaths(workspace) {
  const directory = path.join(workspace, '.birdsbirdbirds')

  return {
    directory,
    serverFile: path.join(directory, 'server.json'),
    logFile: path.join(directory, 'server.log'),
  }
}

/**
 * Asks the server on `port` for its instance hash. Resolves the hash, or
 * undefined when nothing answers in `timeoutMs` or the answer isn't ours.
 */
export async function fetchInstance(port, timeoutMs) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return undefined
    const { instance } = await response.json()

    return typeof instance === 'string' ? instance : undefined
  } catch {
    return undefined
  }
}

/** Resolves after `milliseconds`. */
export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
