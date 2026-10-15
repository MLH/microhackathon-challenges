// Verifies every challenge package at the top level of the repo with the
// station's own `boothstrap dev --verify`, and rejects duplicate challenge ids.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

/**
 * Lists the top-level directories of `root` that hold a challenge.json,
 * skipping dot-directories and node_modules. Returns `{ dir, name }` sorted by name.
 */
export function findPackages(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .filter((entry) => existsSync(path.join(root, entry.name, 'challenge.json')))
    .map((entry) => ({ name: entry.name, dir: path.join(root, entry.name) }))
    .sort((left, right) => compareNames(left.name, right.name))
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
 * Runs the real `boothstrap dev --verify` on one package with the given
 * binary; true when it passes. A binary that cannot start is reported on
 * stderr and counts as a failure.
 */
export function verifyWithBoothstrap(packageDir, binary = boothstrapBin) {
  const result = spawnSync(binary, ['dev', '--verify', packageDir], { stdio: 'inherit' })
  if (result.error) {
    console.error(`boothstrap not found at ${binary}; run npm ci`)

    return false
  }

  return result.status === 0
}

/**
 * Verifies all packages under `root` and returns the process exit code:
 * 0 when every package verifies and ids are unique (or none exist), else 1.
 */
export function main({ root = repoRoot, verify = verifyWithBoothstrap } = {}) {
  const packages = findPackages(root)
  if (packages.length === 0) {
    console.log('No challenge packages found.')
    return 0
  }

  // Run every package so one failure doesn't hide the others.
  const verifyResults = packages.map(({ dir }) => verify(dir))
  const duplicates = findDuplicateIds(packages)
  for (const { id, names } of duplicates) {
    console.error(`Duplicate challenge id "${id}" in: ${names.join(', ')}`)
  }

  return verifyResults.every(Boolean) && duplicates.length === 0 ? 0 : 1
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
