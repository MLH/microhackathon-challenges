// Proves tools/verify.mjs finds packages, rejects duplicate ids, and exits
// correctly. The CLI tests run the real `boothstrap dev --verify`, offline.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { findDuplicateIds, findPackages, findPackagesOutsideChallenges, main } from '../tools/verify.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const verifyScript = path.join(testDirectory, '..', 'tools', 'verify.mjs')
const fixtureRoot = (name) => path.join(testDirectory, 'fixtures', 'roots', name)

/** Runs tools/verify.mjs as a child process with the given arguments. */
const runCliWith = (args) => spawnSync(process.execPath, [verifyScript, ...args], { encoding: 'utf8' })

/** Runs tools/verify.mjs against one root directory. */
const runCli = (root) => runCliWith(['--root', root])

/** Builds a verifier fake that records the directories it is given and accepts those `accepts` approves. */
const fakeVerifier = (accepts = () => true) => {
  const directories = []
  const verify = (verifiedDirectories) => {
    directories.push(...verifiedDirectories)

    return verifiedDirectories.every(accepts)
  }

  return { directories, verify }
}

/** Makes a fresh temporary directory, runs `body` with it, and removes it afterwards. */
const withTemporaryDirectory = async (body) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'verify-test-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Makes a fresh temporary repo root with an empty challenges/ directory, runs `body` with it, and removes it afterwards. */
const withTemporaryRoot = (body) => withTemporaryDirectory(async (root) => {
  await mkdir(path.join(root, 'challenges'))

  return body(root, path.join(root, 'challenges'))
})

test('finds directories under challenges/, symlinked and nested ones included, that hold a challenge.json', () => {
  const names = findPackages(fixtureRoot('layout')).map((entry) => entry.name)

  assert.deepEqual(names, ['challenges/holder/nested', 'challenges/linked-a', 'challenges/top-a', 'challenges/top-b'])
})

test('finds a package inside a grouping folder', () => {
  const names = findPackages(fixtureRoot('grouped')).map((entry) => entry.name)

  assert.deepEqual(names, ['challenges/beginner/gamma'])
})

test('finds no packages when there is no challenges/ directory', () => withTemporaryDirectory(async (root) => {
  await mkdir(path.join(root, 'stray'))
  await writeFile(path.join(root, 'stray', 'challenge.json'), '{"id": "stray"}')

  const names = findPackages(root).map((entry) => entry.name)

  assert.deepEqual(names, [])
}))

test('does not look inside a package, node_modules, or a dot-directory for more packages', () => withTemporaryRoot(async (_, challenges) => {
  const manifestPaths = ['outer', 'outer/inner', 'node_modules/dependency', '.cache/entry', 'group/real']
  for (const manifestPath of manifestPaths) {
    await mkdir(path.join(challenges, manifestPath), { recursive: true })
    await writeFile(path.join(challenges, manifestPath, 'challenge.json'), '{}')
  }

  const names = findPackages(path.dirname(challenges)).map((entry) => entry.name)

  assert.deepEqual(names, ['challenges/group/real', 'challenges/outer'])
}))

test('does not walk forever through a symlink back to an ancestor directory', () => withTemporaryRoot(async (root, challenges) => {
  await mkdir(path.join(challenges, 'group'))
  await symlink('..', path.join(challenges, 'group', 'up'))

  const names = findPackages(root).map((entry) => entry.name)

  assert.deepEqual(names, [])
}))

test('reports a package at the root or in a top-level directory other than challenges/', () => withTemporaryRoot(async (root) => {
  await writeFile(path.join(root, 'challenge.json'), '{}')
  await writeFile(path.join(root, 'challenges', 'challenge.json'), '{}')
  await mkdir(path.join(root, 'stray'))
  await writeFile(path.join(root, 'stray', 'challenge.json'), '{}')

  const strayManifests = findPackagesOutsideChallenges(root)

  assert.deepEqual(strayManifests, ['challenge.json', 'challenges/challenge.json', 'stray/challenge.json'])
}))

test('does not walk a symlink that leaves challenges/, even to a place inside the repo', () => withTemporaryRoot(async (root, challenges) => {
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'verify-outside-'))
  try {
    await mkdir(path.join(outsideRoot, 'evil'))
    await writeFile(path.join(outsideRoot, 'evil', 'challenge.json'), '{}')
    await mkdir(path.join(root, 'test', 'fixture'), { recursive: true })
    await writeFile(path.join(root, 'test', 'fixture', 'challenge.json'), '{}')
    await mkdir(path.join(challenges, 'group'))
    await symlink(outsideRoot, path.join(challenges, 'group', 'outside'))
    await symlink('../../test', path.join(challenges, 'group', 'inside'))

    const names = findPackages(root).map((entry) => entry.name)

    assert.deepEqual(names, [])
  } finally {
    await rm(outsideRoot, { recursive: true, force: true })
  }
}))

test('reports packages that share a challenge id with the directories involved', () => {
  const packages = findPackages(fixtureRoot('duplicate'))

  assert.deepEqual(findDuplicateIds(packages), [{ id: 'fixture-alpha', names: ['challenges/one', 'challenges/two'] }])
})

test('reports no duplicates when every id is unique', () => {
  const packages = findPackages(fixtureRoot('ok'))

  assert.deepEqual(findDuplicateIds(packages), [])
})

test('skips a dangling symlink under challenges/', () => withTemporaryRoot(async (root, challenges) => {
  await symlink(path.join(challenges, 'gone'), path.join(challenges, 'dangling'))

  const names = findPackages(root).map((entry) => entry.name)

  assert.deepEqual(names, [])
}))

test('leaves a package with an unparseable or id-less manifest out of the duplicate check', () => withTemporaryRoot(async (root, challenges) => {
  const manifests = {
    first: '{"id": "shared"}',
    second: '{"id": "shared"}',
    unparseable: '{not json',
    'no-id': '{"title": "no id"}',
    'numeric-id': '{"id": 7}',
  }
  for (const [name, manifest] of Object.entries(manifests)) {
    await mkdir(path.join(challenges, name))
    await writeFile(path.join(challenges, name, 'challenge.json'), manifest)
  }

  const duplicates = findDuplicateIds(findPackages(root))

  assert.deepEqual(duplicates, [{ id: 'shared', names: ['challenges/first', 'challenges/second'] }])
}))

test('exits 0 when every package verifies and ids are unique', () => {
  const { directories, verify } = fakeVerifier()

  const code = main({ root: fixtureRoot('ok'), verify })

  assert.equal(code, 0)
  assert.deepEqual(directories.map((dir) => path.basename(dir)), ['alpha', 'beta'])
})

test('exits 1 when a package sits outside challenges/, still verifying the rest', () => {
  const { directories, verify } = fakeVerifier()

  const code = main({ root: fixtureRoot('outside'), verify })

  assert.equal(code, 1)
  assert.deepEqual(directories.map((dir) => path.basename(dir)), ['alpha'])
})

test('exits 1 on duplicate ids even when every package verifies', () => {
  const code = main({ root: fixtureRoot('duplicate'), verify: fakeVerifier().verify })

  assert.equal(code, 1)
})

test('exits 1 when the verifier rejects a package', () => {
  const { verify } = fakeVerifier((dir) => !dir.endsWith('alpha'))

  const code = main({ root: fixtureRoot('ok'), verify })

  assert.equal(code, 1)
})

test('exits 0 and says so when there are no packages', () => withTemporaryDirectory(async (emptyRoot) => {
  const result = runCli(emptyRoot)

  assert.equal(result.status, 0)
  assert.match(result.stdout, /No challenge packages found/)
}))

test('CLI exits 0 for valid packages verified by the real boothstrap', () => {
  const result = runCli(fixtureRoot('ok'))

  assert.equal(result.status, 0, result.stderr)
})

test('CLI exits 1 for a package the real boothstrap rejects', () => {
  const result = runCli(fixtureRoot('invalid'))

  assert.equal(result.status, 1)
  assert.match(result.stderr, /not a valid challenge package/)
})

test('CLI exits 0 for a package in a grouping folder', () => {
  const result = runCli(fixtureRoot('grouped'))

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ok .*gamma/)
})

test('CLI exits 1 naming a package outside challenges/ while still verifying the others', () => {
  const result = runCli(fixtureRoot('outside'))

  assert.equal(result.status, 1)
  assert.match(result.stderr, /^stray\/challenge\.json is outside challenges\/; move its package under challenges\/$/m)
  assert.match(result.stdout, /ok .*alpha/)
})

test('CLI verifies a symlinked package and still reports the others after a failure', () => withTemporaryRoot(async (root, challenges) => {
  await cp(path.join(fixtureRoot('invalid'), 'challenges', 'broken'), path.join(challenges, 'broken'), { recursive: true })
  await cp(path.join(fixtureRoot('ok'), 'challenges', 'alpha'), path.join(challenges, 'alpha'), { recursive: true })
  await symlink('broken', path.join(challenges, 'a-broken'))
  await symlink('alpha', path.join(challenges, 'b-alpha'))

  const result = runCli(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /a-broken is not a valid challenge package/)
  assert.match(result.stdout, /ok .*b-alpha/)
}))

const unsafeSymlinkCases = [
  { name: 'dangling', setup: async () => {}, target: () => 'gone', reason: /is dangling or loops/ },
  { name: 'looping', setup: async (root) => symlink('self', path.join(root, 'self')), target: () => 'self', reason: /is dangling or loops/ },
  { name: 'running through a file', setup: (root) => writeFile(path.join(root, 'plain'), ''), target: () => 'plain/inner', reason: /is dangling or loops/ },
  { name: 'pointing outside the repo', setup: async () => {}, target: () => '..', reason: /points outside the repo/ },
  { name: 'absolute even inside the repo', setup: (root) => mkdir(path.join(root, 'inside')), target: (root) => path.join(root, 'inside'), reason: /has an absolute target/ },
]

for (const { name, setup, target, reason } of unsafeSymlinkCases) {
  test(`CLI exits 1 naming a ${name} top-level symlink`, () => withTemporaryDirectory(async (root) => {
    await setup(root)
    await symlink(target(root), path.join(root, 'link'))

    const result = runCli(root)

    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(`^Unsafe symlink "link" -> .*: ${reason.source}\\n`, 'm'))
    assert.doesNotMatch(result.stderr, /\n\s+at /)
  }))
}

test('CLI exits 1 naming an unsafe symlink inside a grouping folder under challenges/', () => withTemporaryRoot(async (root, challenges) => {
  await mkdir(path.join(challenges, 'group'))
  await symlink('../../..', path.join(challenges, 'group', 'link'))

  const result = runCli(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /^Unsafe symlink "challenges\/group\/link" -> \.\.\/\.\.\/\.\.: points outside the repo$/m)
}))

test('CLI exits 1 naming a dot-named top-level symlink', () => withTemporaryDirectory(async (root) => {
  await symlink('..', path.join(root, '.hidden'))

  const result = runCli(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /^Unsafe symlink "\.hidden" -> \.\.: points outside the repo$/m)
}))

test('CLI exits 1 and names the directories for duplicate ids', () => {
  const result = runCli(fixtureRoot('duplicate'))

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Duplicate challenge id "fixture-alpha" in: challenges\/one, challenges\/two/)
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

test('CLI rejects a --root that is not a directory with a one-line message', () => withTemporaryDirectory(async (directory) => {
  const missing = path.join(directory, 'no-such-root')

  const result = runCliWith(['--root', missing])

  assert.equal(result.status, 1)
  assert.equal(result.stderr, `verify: --root is not a directory: ${missing}\n`)
}))

test('CLI reports a boothstrap binary that cannot run and exits 1', () => withTemporaryDirectory(async (installRoot) => {
  // The script finds its binary relative to itself, and this copy has no node_modules.
  await mkdir(path.join(installRoot, 'tools'))
  const strandedScript = path.join(installRoot, 'tools', 'verify.mjs')
  await copyFile(verifyScript, strandedScript)

  const result = spawnSync(process.execPath, [strandedScript, '--root', fixtureRoot('ok')], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /could not run boothstrap at .*boothstrap: .*ENOENT.*; run npm ci/)
}))
