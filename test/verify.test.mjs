// Proves tools/verify.mjs finds packages, rejects duplicate ids, and exits
// correctly. The CLI tests run the real `boothstrap dev --verify`, offline.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { findDuplicateIds, findPackages, main, verifyWithBoothstrap } from '../tools/verify.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const verifyScript = path.join(testDirectory, '..', 'tools', 'verify.mjs')
const fixtureRoot = (name) => path.join(testDirectory, 'fixtures', 'roots', name)

/** Runs tools/verify.mjs as a child process with the given arguments. */
const runCliWith = (args) => spawnSync(process.execPath, [verifyScript, ...args], { encoding: 'utf8' })

/** Runs tools/verify.mjs against one root directory. */
const runCli = (root) => runCliWith(['--root', root])

/** Builds a verifier fake that records each directory and rejects package alpha. */
const fakeVerifierRejectingAlpha = () => {
  const attempted = []
  const verify = (dir) => {
    attempted.push(dir)

    return !dir.endsWith('alpha')
  }

  return { attempted, verify }
}

/** Builds a verifier fake that records each directory and accepts everything. */
const fakeVerifierAcceptingAll = () => {
  const verified = []
  const verify = (dir) => {
    verified.push(dir)

    return true
  }

  return { verified, verify }
}

/** Runs `run` with console output silenced and returns its result. */
const quietly = (run) => {
  const originalLog = console.log
  const originalError = console.error
  console.log = console.error = () => {}
  try {
    return run()
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

test('finds only top-level directories that hold a challenge.json', () => {
  const names = findPackages(fixtureRoot('layout')).map((entry) => entry.name)

  assert.deepEqual(names, ['top-a', 'top-b'])
})

test('reports packages that share a challenge id with the directories involved', () => {
  const packages = findPackages(fixtureRoot('duplicate'))

  assert.deepEqual(findDuplicateIds(packages), [{ id: 'fixture-alpha', names: ['one', 'two'] }])
})

test('reports no duplicates when every id is unique', () => {
  const packages = findPackages(fixtureRoot('ok'))

  assert.deepEqual(findDuplicateIds(packages), [])
})

test('exits 0 when every package verifies and ids are unique', () => {
  const { verified, verify } = fakeVerifierAcceptingAll()

  const code = quietly(() => main({ root: fixtureRoot('ok'), verify }))

  assert.equal(code, 0)
  assert.deepEqual(verified.map((dir) => path.basename(dir)), ['alpha', 'beta'])
})

test('exits 1 on duplicate ids even when every package verifies', () => {
  const code = quietly(() => main({ root: fixtureRoot('duplicate'), verify: () => true }))

  assert.equal(code, 1)
})

test('exits 1 when the verifier rejects a package, after trying the others', () => {
  const { attempted, verify } = fakeVerifierRejectingAlpha()

  const code = quietly(() => main({ root: fixtureRoot('ok'), verify }))

  assert.equal(code, 1)
  assert.deepEqual(attempted.map((dir) => path.basename(dir)), ['alpha', 'beta'])
})

test('exits 0 and says so when there are no packages', async () => {
  const emptyRoot = await mkdtemp(path.join(tmpdir(), 'verify-empty-'))

  try {
    const result = runCli(emptyRoot)

    assert.equal(result.status, 0)
    assert.match(result.stdout, /No challenge packages found/)
  } finally {
    await rm(emptyRoot, { recursive: true, force: true })
  }
})

test('CLI exits 0 for valid packages verified by the real boothstrap', () => {
  const result = runCli(fixtureRoot('ok'))

  assert.equal(result.status, 0, result.stderr)
})

test('CLI exits 1 for a package the real boothstrap rejects', () => {
  const result = runCli(fixtureRoot('invalid'))

  assert.equal(result.status, 1)
  assert.match(result.stderr, /not a valid challenge package/)
})

test('CLI exits 1 and names the directories for duplicate ids', () => {
  const result = runCli(fixtureRoot('duplicate'))

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Duplicate challenge id "fixture-alpha" in: one, two/)
})

test('CLI rejects an unknown flag with a one-line message and no stack', () => {
  const result = runCliWith(['--bogus'])

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'verify: unknown argument: --bogus\n')
})

test('CLI rejects --root without a directory with a one-line message', () => {
  const result = runCliWith(['--root'])

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'verify: --root needs a directory\n')
})

test('CLI rejects a --root that is not a directory with a one-line message', () => {
  const missing = path.join(tmpdir(), 'verify-no-such-root')

  const result = runCliWith(['--root', missing])

  assert.equal(result.status, 1)
  assert.equal(result.stderr, `verify: --root is not a directory: ${missing}\n`)
})

test('reports a missing boothstrap binary on stderr and fails', (context) => {
  const missingBinary = path.join(tmpdir(), 'verify-no-such-boothstrap')
  const errorOutput = context.mock.method(console, 'error', () => {})

  const passed = verifyWithBoothstrap(fixtureRoot('ok'), missingBinary)

  assert.equal(passed, false)
  assert.deepEqual(errorOutput.mock.calls.map((call) => call.arguments), [
    [`boothstrap not found at ${missingBinary}; run npm ci`],
  ])
})
