// Verifies every challenge package under the repo's challenges/ directory with
// the station's own `boothstrap dev --verify`, and rejects duplicate challenge
// ids, packages outside challenges/, and unsafe symlinks.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const boothstrapBin = path.join(repoRoot, 'node_modules', '.bin', 'boothstrap')

/** Orders names by code unit so the result never depends on the locale. */
function compareNames(left, right) {
  if (left < right) return -1
  if (left > right) return 1

  return 0
}

/** The directory, relative to the repo root, that holds every challenge package. */
const CHALLENGES_DIRECTORY = 'challenges'

/** Error codes for a symlink that dangles, loops, or runs through a file. */
const BROKEN_LINK_CODES = ['ENOENT', 'ENOTDIR', 'ELOOP']

/**
 * True when `entry` is a directory or a symlink to one, because the station
 * keeps in-repo symlinks. A broken symlink is not a directory; see
 * {@link findUnsafeSymlinks} for how it fails verification.
 */
function isDirectoryFollowingSymlinks(directory, entry) {
  try {
    return statSync(path.join(directory, entry.name)).isDirectory()
  } catch (error) {
    if (BROKEN_LINK_CODES.includes(error.code)) return false
    throw error
  }
}

/** True when `directory` holds a challenge.json. */
function holdsManifest(directory) {
  return existsSync(path.join(directory, 'challenge.json'))
}

/** Lists the subdirectories of `directory`, symlinks to directories included, skipping dot-directories and node_modules. */
function listSubdirectories(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .filter((entry) => isDirectoryFollowingSymlinks(directory, entry))
    .map((entry) => entry.name)
    .sort(compareNames)
}

/**
 * Walks `directory` for packages and for the grouping directories between
 * them. A directory holding a challenge.json is a package and is not entered;
 * a directory that resolves to one of its own ancestors is not entered again.
 * Returns `{ packages, groupings }`, where each package is `{ dir, name }`
 * with `name` relative to `root`, and each grouping is a directory walked.
 */
function walkForPackages(root, directory, ancestors) {
  const realDirectory = realpathSync(directory)
  if (ancestors.includes(realDirectory)) return { packages: [], groupings: [] }

  const found = { packages: [], groupings: [directory] }
  for (const name of listSubdirectories(directory)) {
    const child = path.join(directory, name)
    if (holdsManifest(child)) {
      found.packages.push({ dir: child, name: path.relative(root, child).split(path.sep).join('/') })
      continue
    }

    const nested = walkForPackages(root, child, [...ancestors, realDirectory])
    found.packages.push(...nested.packages)
    found.groupings.push(...nested.groupings)
  }

  return found
}

/** Walks `root`/challenges, or returns nothing when it does not exist as a directory. */
function walkChallenges(root) {
  const challenges = path.join(root, CHALLENGES_DIRECTORY)
  const hasChallenges = existsSync(challenges) && statSync(challenges).isDirectory()

  return hasChallenges ? walkForPackages(root, challenges, []) : { packages: [], groupings: [] }
}

/**
 * Lists the packages under `root`/challenges at any depth: directories
 * (symlinks to directories included) that hold a challenge.json, skipping
 * dot-directories and node_modules and never entering a package. Returns
 * `{ dir, name }` sorted by name, where `name` is relative to `root`.
 */
export function findPackages(root) {
  return walkChallenges(root).packages.sort((left, right) => compareNames(left.name, right.name))
}

/**
 * Lists the directories outside `root`/challenges that hold a challenge.json:
 * `root` itself and its top-level directories (symlinks to directories
 * included, dot-directories and node_modules skipped). A package there is
 * invisible to the station, so each one fails verification. Returns the
 * manifest paths relative to `root`.
 */
export function findPackagesOutsideChallenges(root) {
  const strayDirectories = listSubdirectories(root).filter((name) => name !== CHALLENGES_DIRECTORY)
  const strayManifests = strayDirectories
    .filter((name) => holdsManifest(path.join(root, name)))
    .map((name) => `${name}/challenge.json`)

  return holdsManifest(root) ? ['challenge.json', ...strayManifests] : strayManifests
}

/** True when `candidate` is `parent` or lies beneath it. */
function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)

  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Explains why a symlink is unsafe, or returns undefined when it is fine. */
function explainUnsafeSymlink(realRoot, linkPath) {
  if (path.isAbsolute(readlinkSync(linkPath))) return 'has an absolute target'

  let resolved
  try {
    resolved = realpathSync(linkPath)
  } catch (error) {
    if (BROKEN_LINK_CODES.includes(error.code)) return 'is dangling or loops'
    throw error
  }

  return isInside(realRoot, resolved) ? undefined : 'points outside the repo'
}

/**
 * Lists the symlinks directly inside `root` and inside every directory walked
 * under `root`/challenges that the station refuses to unpack: absolute,
 * dangling, looping, or resolving outside `root`. Returns one message per
 * link, naming it relative to `root` and its target.
 */
export function findUnsafeSymlinks(root) {
  const realRoot = realpathSync(root)
  const walkedDirectories = [root, ...walkChallenges(root).groupings]

  return walkedDirectories.flatMap((directory) => readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink() && entry.name !== 'node_modules')
    .flatMap((entry) => {
      const linkPath = path.join(directory, entry.name)
      const reason = explainUnsafeSymlink(realRoot, linkPath)
      const displayName = path.relative(root, linkPath).split(path.sep).join('/')

      return reason === undefined ? [] : [`Unsafe symlink "${displayName}" -> ${readlinkSync(linkPath)}: ${reason}`]
    }))
}

/**
 * Reads the `id` of a package's challenge.json. Returns undefined when the
 * file is unparseable or has no string id; `boothstrap dev --verify` reports that.
 */
export function readChallengeId(packageDir) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'challenge.json'), 'utf8'))
    return typeof manifest?.id === 'string' ? manifest.id : undefined
  } catch {
    return undefined
  }
}

/**
 * Groups packages by challenge id. Returns `[{ id, names }]` for each id
 * shared by more than one package.
 */
export function findDuplicateIds(packages) {
  const namesById = new Map()
  for (const { name, dir } of packages) {
    const id = readChallengeId(dir)
    if (id === undefined) continue
    namesById.set(id, [...(namesById.get(id) ?? []), name])
  }

  return [...namesById]
    .filter(([, names]) => names.length > 1)
    .map(([id, names]) => ({ id, names }))
}

/**
 * Runs the real `boothstrap dev --verify` once on all the given package
 * directories with the given binary; it reports every package, failures
 * included. True when all pass. A binary that cannot start is reported on
 * stderr and counts as a failure.
 */
export function verifyWithBoothstrap(packageDirs, binary = boothstrapBin) {
  const result = spawnSync(binary, ['dev', '--verify', ...packageDirs], { stdio: 'inherit' })
  if (result.error) {
    console.error(`could not run boothstrap at ${binary}: ${result.error.message}; run npm ci`)

    return false
  }

  return result.status === 0
}

/**
 * Verifies all packages under `root`/challenges and returns the process exit
 * code: 0 when every package verifies, ids are unique, no package sits outside
 * challenges/ and no symlink is unsafe (or no packages exist), else 1.
 */
export function main({ root = repoRoot, verify = verifyWithBoothstrap } = {}) {
  const unsafeSymlinks = findUnsafeSymlinks(root)
  for (const message of unsafeSymlinks) console.error(message)

  const strayManifests = findPackagesOutsideChallenges(root)
  for (const manifest of strayManifests) {
    console.error(`${manifest} is outside ${CHALLENGES_DIRECTORY}/; move its package under ${CHALLENGES_DIRECTORY}/`)
  }

  const structureIsValid = unsafeSymlinks.length === 0 && strayManifests.length === 0
  const packages = findPackages(root)
  if (packages.length === 0) {
    console.log('No challenge packages found.')
    return structureIsValid ? 0 : 1
  }

  const allVerified = verify(packages.map(({ dir }) => dir))
  const duplicates = findDuplicateIds(packages)
  for (const { id, names } of duplicates) {
    console.error(`Duplicate challenge id "${id}" in: ${names.join(', ')}`)
  }

  return allVerified && duplicates.length === 0 && structureIsValid ? 0 : 1
}

/** Signals a bad command line; the CLI prints its message without a stack. */
export class UsageError extends Error {}

/**
 * Parses the command line into `{ root }`, defaulting to the repo root.
 * Throws UsageError for a missing --root value or any unknown argument.
 */
export function rootFromArguments(args) {
  let root = repoRoot
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--root') throw new UsageError(`unknown argument: ${args[index]}`)
    const value = args[++index]
    if (value === undefined) throw new UsageError('--root needs a directory')
    root = path.resolve(value)
  }

  return root
}

/** Validates --root, which must be an existing directory. */
function requireDirectory(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new UsageError(`--root is not a directory: ${root}`)
  }

  return root
}

if (import.meta.main) {
  try {
    process.exitCode = main({ root: requireDirectory(rootFromArguments(process.argv.slice(2))) })
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    console.error(`verify: ${error.message}`)
    process.exitCode = 1
  }
}
