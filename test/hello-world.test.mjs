// Proves the hello-world package's manifest invariants and that its setup and
// cleanup hooks behave on a workspace, offline.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const challengeDirectory = fileURLToPath(new URL('../challenges/hello-world/', import.meta.url))

/** Creates a temporary directory that is removed when the test ends. */
const makeDirectory = async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hello-world-'))
  context.after(() => rm(directory, { recursive: true, force: true }))

  return directory
}

/**
 * Runs a hook from `cwd` with a clean environment. `BOOTHSTRAP_WORKSPACE` is
 * set only when `workspace` is given, so omitting it exercises the standalone
 * fallback to the current directory.
 */
const runHook = (hook, { cwd, workspace }) =>
  execFileAsync(path.join(challengeDirectory, hook), [], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      TMPDIR: cwd,
      ...(workspace === undefined ? {} : { BOOTHSTRAP_WORKSPACE: workspace }),
    },
  })

/** Reads the package manifest. */
const readManifest = async () => JSON.parse(await readFile(path.join(challengeDirectory, 'challenge.json'), 'utf8'))

/** Lists a directory's entries in a stable order. */
const listSorted = async (directory) => (await readdir(directory)).sort()

test('manifest keeps the step IDs and model the skill depends on', async () => {
  const manifest = await readManifest()

  assert.deepEqual(manifest.steps.map((step) => step.id), ['greet', 'hello-file'])
  assert.equal(manifest.model, 'google/gemini-3.8-flash')
  assert.deepEqual(manifest.vault_services, ['gemini'])
})

test('skill names every step the manifest declares', async () => {
  const manifest = await readManifest()
  const skill = await readFile(path.join(challengeDirectory, 'skills/start-challenge/SKILL.md'), 'utf8')

  for (const step of manifest.steps) {
    assert.ok(skill.includes(`\`${step.id}\``), `skill never names step ${step.id}`)
  }
})

test('setup seeds welcome.txt in the workspace', async (context) => {
  const cwd = await makeDirectory(context)
  const workspace = await makeDirectory(context)

  await runHook('setup', { cwd, workspace })

  assert.match(await readFile(path.join(workspace, 'welcome.txt'), 'utf8'), /hello/i)
  assert.deepEqual(await listSorted(cwd), [])
})

test('cleanup run twice removes the seeded file and keeps the participant\'s files', async (context) => {
  const cwd = await makeDirectory(context)
  const workspace = await makeDirectory(context)
  await runHook('setup', { cwd, workspace })
  await writeFile(path.join(workspace, 'hello.txt'), 'Hello, world!')

  await runHook('cleanup', { cwd, workspace })
  await runHook('cleanup', { cwd, workspace })

  assert.deepEqual(await listSorted(workspace), ['hello.txt'])
  assert.equal(await readFile(path.join(workspace, 'hello.txt'), 'utf8'), 'Hello, world!')
})

test('cleanup succeeds after setup failed on a missing workspace', async (context) => {
  const cwd = await makeDirectory(context)
  const workspace = path.join(cwd, 'never-created')

  await assert.rejects(runHook('setup', { cwd, workspace }), /workspace/i)
  await runHook('cleanup', { cwd, workspace })

  assert.deepEqual(await listSorted(cwd), [])
})

test('setup seeds the current directory when BOOTHSTRAP_WORKSPACE is unset', async (context) => {
  const cwd = await makeDirectory(context)

  await runHook('setup', { cwd })

  assert.match(await readFile(path.join(cwd, 'welcome.txt'), 'utf8'), /hello/i)
})

test('cleanup clears the current directory when BOOTHSTRAP_WORKSPACE is unset', async (context) => {
  const cwd = await makeDirectory(context)
  await runHook('setup', { cwd })

  await runHook('cleanup', { cwd })

  assert.deepEqual(await listSorted(cwd), [])
})
