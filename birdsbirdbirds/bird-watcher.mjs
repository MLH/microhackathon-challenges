// Watches the workspace for the participant's Save on the drawing page, so
// Pi hears about a new bird.png without being told.
//
// fs.watch fires several events per write, and the page server saves
// bird.png through a temp file and a rename, so events are debounced and the
// callback fires only for content that differs from the last it fired for.
// A bird.png already there when watching starts counts as seen, so a
// restarted watcher stays quiet about it.

import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import path from 'node:path'

import { isCompletePng, MAX_PNG_BYTES } from './server.mjs'
import { readWorkspaceFile, RefusedFileError } from './workspace-file.mjs'

export const DEFAULT_DEBOUNCE_MS = 200

const DRAWING_FILE = 'bird.png'

/**
 * Watches `workspace` (absolute) until `stop()` is called, calling
 * `onBirdSaved()` when bird.png appears or gets new content. Errors from
 * reading or watching go to `onError(error)`; a missing, symlinked, piped, or
 * oversized bird.png is not an error, just not a save. The watcher never
 * keeps the process alive. Returns `{ stop }`.
 */
export function watchWorkspace({ workspace, onBirdSaved, onError, debounceMs = DEFAULT_DEBOUNCE_MS }) {
  if (!path.isAbsolute(workspace)) throw new Error(`workspace must be an absolute path, got ${JSON.stringify(workspace)}`)

  const drawingPath = path.join(workspace, DRAWING_FILE)
  let lastHash = drawingHash(drawingPath)
  let timer
  let stopped = false

  /** Reports bird.png when its content is new. */
  const checkDrawing = () => {
    const hash = drawingHash(drawingPath)
    if (hash === undefined || hash === lastHash) return

    lastHash = hash
    onBirdSaved()
  }

  /** Checks bird.png once its events have been quiet for `debounceMs`. */
  const scheduleCheck = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (stopped) return
      try {
        checkDrawing()
      } catch (error) {
        onError(error)
      }
    }, debounceMs)
    timer.unref()
  }

  const watcher = watch(workspace, { persistent: false }, (_eventType, fileName) => {
    // Some platforms leave out the name; then bird.png may have changed.
    if (fileName === null || String(fileName) === DRAWING_FILE) scheduleCheck()
  })
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

/**
 * Hex SHA-256 of bird.png, or undefined when it is missing, refused, or not a
 * complete PNG yet (a write caught halfway must not count as a new drawing).
 */
function drawingHash(drawingPath) {
  let bytes
  try {
    bytes = readWorkspaceFile(drawingPath, MAX_PNG_BYTES)
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof RefusedFileError) return undefined
    throw error
  }

  if (!isCompletePng(bytes)) return undefined

  return createHash('sha256').update(bytes).digest('hex')
}
