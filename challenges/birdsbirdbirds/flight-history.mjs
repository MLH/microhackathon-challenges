// Keeps every distinct flight that passed the checker, so the sky page can
// show what the last change did and Pi can count how many flights the
// participant directed. Each new passing bird.json is copied to
// <workspace>/.flights/NNN.json, numbered from 001.
//
// Recording runs when the workspace changes and whenever the page asks. It
// never relies on what fs.watch says changed, since Linux and macOS report
// different events and names: any event schedules one debounced check, and a
// check that finds nothing new does nothing.

import { lstatSync, mkdirSync, readdirSync, watch, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadBirdFile } from './check-bird.mjs'
import { changedWaypoints, flightOf } from './flight-path.mjs'

export const FLIGHTS_DIRECTORY = '.flights'
export const DEFAULT_FLIGHT_DEBOUNCE_MS = 200

const FLIGHT_FILE_PATTERN = /^(\d{3,})\.json$/

/**
 * Copies <workspace>/bird.json into .flights/ as the next number when it
 * passes the checker and differs from the latest recorded flight. Returns
 * the new flight's number, or undefined when nothing was recorded.
 */
export function recordFlight(workspace) {
  const { entry, errors } = loadBirdFile(path.join(workspace, 'bird.json'))
  if (errors.length > 0) return undefined

  const directory = flightsDirectory(workspace)
  const recorded = recordedFlights(directory)
  const latest = recorded.at(-1)
  if (latest !== undefined && canonicalJson(latest.entry) === canonicalJson(entry)) return undefined

  const number = (recorded.length === 0 ? 0 : Math.max(...recorded.map((flight) => flight.number))) + 1
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, `${String(number).padStart(3, '0')}.json`), `${JSON.stringify(entry, null, 2)}\n`, { flag: 'wx' })

  return number
}

/**
 * The latest recorded flight and the one before it, as the page shows them:
 * `{ current, previous, changed }`. Each flight is flightOf's shape or null,
 * and `changed` lists the current waypoints that differ from the previous.
 */
export function readFlightHistory(workspace) {
  const latestFlights = recordedFlights(flightsDirectory(workspace))
    .slice(-2)
    .map(({ entry, number }) => flightOf(entry, number))
  const current = latestFlights.at(-1)
  const previous = latestFlights.length === 2 ? latestFlights[0] : undefined

  return {
    current: current ?? null,
    previous: previous ?? null,
    changed: current === undefined ? [] : changedWaypoints(current, previous),
  }
}

/**
 * Records flights as the workspace changes until `stop()` is called. Any
 * event schedules one check `debounceMs` after events go quiet; errors go to
 * `onError`. The watcher never keeps the process alive. Returns `{ stop }`.
 */
export function watchFlights({ workspace, onError, debounceMs = DEFAULT_FLIGHT_DEBOUNCE_MS }) {
  let timer
  let stopped = false

  /** Checks for a new flight once events have been quiet for `debounceMs`. */
  const scheduleCheck = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (stopped) return
      try {
        recordFlight(workspace)
      } catch (error) {
        onError(error)
      }
    }, debounceMs)
    timer.unref()
  }

  const watcher = watch(workspace, { persistent: false }, scheduleCheck)
  watcher.on('error', onError)

  return {
    /** Stops watching and cancels a pending check; safe to call more than once. */
    stop() {
      stopped = true
      watcher.close()
      clearTimeout(timer)
    },
  }
}

/** The .flights directory of `workspace`. */
function flightsDirectory(workspace) {
  return path.join(workspace, FLIGHTS_DIRECTORY)
}

/**
 * The flights in `directory` that still pass the checker, oldest first, each
 * `{ number, entry }`. Empty when the directory doesn't exist yet. Throws when
 * it is anything but a real directory, so a symlink never redirects writes.
 */
function recordedFlights(directory) {
  try {
    if (!lstatSync(directory).isDirectory()) throw new Error(`${directory} is not a directory; remove it so flights can be recorded`)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  return readdirSync(directory)
    .flatMap((name) => {
      const number = FLIGHT_FILE_PATTERN.exec(name)?.[1]
      if (number === undefined) return []
      const { entry, errors } = loadBirdFile(path.join(directory, name))

      return errors.length === 0 ? [{ number: Number(number), entry }] : []
    })
    .sort((left, right) => left.number - right.number)
}

/** JSON text of `value` with object keys sorted, so key order never makes two flights distinct. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }

  return JSON.stringify(value)
}
