/**
 * Reads, writes, and removes a file in the participant's workspace without trusting what sits
 * there: a symlink could point anywhere, a hard link could alias a file elsewhere, a named pipe would
 * block the reader forever, and a huge file would eat memory. Only a regular file with exactly one
 * link, within a byte cap, is ever read, replaced, or removed.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** O_NOFOLLOW refuses a symlink swapped in after lstat; O_NONBLOCK keeps a swapped-in pipe from blocking open. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The errors open gives under O_NOFOLLOW for a symlink: ELOOP on Linux, EMLINK on some BSDs. */
const SYMLINK_OPEN_ERRORS = ['ELOOP', 'EMLINK'];

/** A workspace file that is not a lone regular file, or is over its byte cap; the message names it. */
export class RefusedFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefusedFileError';
  }
}

/** Whether `stats` describe a regular file with no other names. */
function isLoneRegularFile(stats) {
  return stats.isFile() && stats.nlink === 1;
}

/** The refusal for `file` when it is a symlink, hard link, pipe, device, or directory. */
function notLoneRegularFile(file) {
  return new RefusedFileError(
    `${path.basename(file)} is not a regular file with one link (it may be a symlink or a pipe)`,
  );
}

/**
 * Throw {@link RefusedFileError} when `file` exists but is not a lone regular file. Returns whether
 * it exists at all.
 */
async function checkExisting(file) {
  let stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  if (!isLoneRegularFile(stats)) {
    throw notLoneRegularFile(file);
  }

  return true;
}

/** Open `file` for reading, refusing a symlink swapped in after the lstat. */
async function openRefusingSymlinks(file) {
  try {
    return await open(file, READ_FLAGS);
  } catch (error) {
    if (SYMLINK_OPEN_ERRORS.includes(error.code)) {
      throw notLoneRegularFile(file);
    }
    throw error;
  }
}

/**
 * Read `file` as UTF-8 when it is a lone regular file of at most `maxBytes`.
 *
 * @returns {Promise<string | null>} the contents, or `null` when the file does not exist.
 * @throws {RefusedFileError} for a symlink, hard link, pipe, device, directory, or oversized file.
 */
export async function readWorkspaceFile(file, maxBytes) {
  if (!(await checkExisting(file))) {
    return null;
  }

  const handle = await openRefusingSymlinks(file);
  try {
    const stats = await handle.stat();
    if (!isLoneRegularFile(stats)) {
      throw notLoneRegularFile(file);
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    for (;;) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) {
        break;
      }
      bytesRead += chunk.bytesRead;
      if (bytesRead > maxBytes) {
        throw new RefusedFileError(`${path.basename(file)} is over the ${maxBytes}-byte cap`);
      }
    }

    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Replace `file` with `contents` through a freshly created temporary file and a rename, so a reader
 * never sees half a file and a planted symlink is never written through.
 *
 * @throws {RefusedFileError} when `file` exists but is not a lone regular file.
 */
export async function writeWorkspaceFile(file, contents) {
  await checkExisting(file);

  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();

  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Remove `file` when it is a lone regular file; a missing file is already removed.
 *
 * @throws {RefusedFileError} when `file` exists but is not a lone regular file.
 */
export async function removeWorkspaceFile(file) {
  if (await checkExisting(file)) {
    await rm(file, { force: true });
  }
}
