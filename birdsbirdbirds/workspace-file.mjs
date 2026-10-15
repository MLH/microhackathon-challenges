// Reads bird.json and bird.png from the workspace without trusting what sits
// there: a symlink could point anywhere, a named pipe would block the reader
// forever, and a huge file would eat memory. Only a regular file within a
// byte cap is ever read.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'

/** O_NOFOLLOW refuses a symlink swapped in after lstat; O_NONBLOCK keeps a swapped-in pipe from blocking open. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/** The errors open gives under O_NOFOLLOW for a symlink: ELOOP on Linux, EMLINK on some BSDs. */
const SYMLINK_OPEN_ERRORS = ['ELOOP', 'EMLINK']

/** A workspace file that is not a regular file, or is over its byte cap; the message names it. */
export class RefusedFileError extends Error {
  /** Builds the error; `tooLarge` tells a size refusal apart from a file-type one. */
  constructor(message, { tooLarge }) {
    super(message)
    this.tooLarge = tooLarge
  }
}

/**
 * Reads `filePath` when it is a regular file of at most `maxBytes`, and
 * returns its bytes. Throws RefusedFileError for a symlink, pipe, device,
 * directory, or oversized file, and the fs error (such as ENOENT) when it
 * cannot be read at all.
 */
export function readWorkspaceFile(filePath, maxBytes) {
  const name = path.basename(filePath)
  /** The refusal for anything but a regular file. */
  const notRegular = () => new RefusedFileError(`${name} is not a regular file (it may be a symlink or a pipe)`, { tooLarge: false })
  /** The refusal for a file of `size` bytes. */
  const tooLarge = (size) => new RefusedFileError(`${name} is ${size} bytes, over the ${maxBytes}-byte cap`, { tooLarge: true })

  if (!lstatSync(filePath).isFile()) throw notRegular()

  const descriptor = openRefusingSymlinks(filePath, notRegular)
  try {
    const stats = fstatSync(descriptor)
    if (!stats.isFile()) throw notRegular()
    if (stats.size > maxBytes) throw tooLarge(stats.size)

    const buffer = Buffer.alloc(maxBytes + 1)
    let bytesRead = 0
    for (;;) {
      const chunkBytes = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (chunkBytes === 0) break
      bytesRead += chunkBytes
      if (bytesRead > maxBytes) throw tooLarge(fstatSync(descriptor).size)
    }

    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(descriptor)
  }
}

/** Opens `filePath` with OPEN_FLAGS, throwing `notRegular()` when it turned out to be a symlink. */
function openRefusingSymlinks(filePath, notRegular) {
  try {
    return openSync(filePath, OPEN_FLAGS)
  } catch (error) {
    if (SYMLINK_OPEN_ERRORS.includes(error.code)) throw notRegular()
    throw error
  }
}
