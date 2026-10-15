// Proves the vibe-coding-mad-libs package: prompt assembly, the extension
// loading under its pinned Pi packages, and the setup and cleanup hooks. The
// install test is the only one that uses the network, to reach the npm registry.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assemblePrompt, isFinishedPrompt } from '../vibe-coding-mad-libs/prompt.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const packageDirectory = path.join(testDirectory, '..', 'vibe-coding-mad-libs')
const installTimeoutMilliseconds = 300_000

const filledAnswers = { theme: 'game', subject: 'cats', audience: 'kids', style: 'retro' }

/** Makes a fresh temporary directory that `test` removes when the test ends. */
const makeTemporaryDirectory = async (test) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mad-libs-test-'))
  test.after(() => rm(directory, { recursive: true, force: true }))

  return directory
}

/** Asks the operating system for a port nothing listens on right now. */
const findFreePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

/** Starts a server on `port` that answers every request with `body`. */
const holdPort = (test, port, body) => new Promise((resolve, reject) => {
  const server = createServer((_request, response) => response.end(body))
  test.after(() => new Promise((done) => {
    server.close(done)
    server.closeAllConnections()
  }))
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => resolve(server))
})

/** Runs an executable to completion and resolves with its exit code and output. */
const runExecutable = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', reject)
  child.once('close', (code) => resolve({ code, stdout, stderr }))
})

/** Runs the package's `hook` (setup or cleanup) with the workspace and preview port set. */
const runHook = (hook, workspace, port) => runExecutable(path.join(packageDirectory, hook), [], {
  env: { ...process.env, BOOTHSTRAP_WORKSPACE: workspace, MAD_LIBS_PREVIEW_PORT: String(port) },
})

/** Makes a workspace and registers cleanup to run in teardown, so no server outlives the test. */
const makeWorkspace = async (test, port) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'mad-libs-test-'))
  test.after(async () => {
    await runHook('cleanup', workspace, port)
    await rm(workspace, { recursive: true, force: true })
  })

  return workspace
}

/** Fetches the preview page and resolves with its status and text. */
const getPreview = async (port) => {
  const response = await fetch(`http://127.0.0.1:${port}/`)

  return { status: response.status, text: await response.text() }
}

/** True when connecting to `port` is refused. */
const isRefused = async (port) => {
  try {
    await fetch(`http://127.0.0.1:${port}/`)
  } catch (error) {
    return error.cause?.code === 'ECONNREFUSED'
  }

  return false
}

/** True when `target` exists. */
const exists = (target) => stat(target).then(() => true, () => false)

const fieldNames = { theme: 'Theme', subject: 'Subject', audience: 'Audience', style: 'Style' }

const blankAnswerCases = [
  { name: 'empty', value: '' },
  { name: 'whitespace only', value: '   \t ' },
  { name: 'multi-line', value: 'first\nsecond' },
  { name: 'a bracketed blank', value: '[Style]' },
  { name: 'a bracketed blank in other case', value: 'a [theme] thing' },
]

test('fills the sentence from four answers, trimmed', () => {
  const answers = { theme: '  game ', subject: '\tcats\t', audience: ' kids', style: 'retro  ' }

  const sentence = assemblePrompt(answers)

  assert.equal(sentence, 'Build a game about cats for kids in retro style.')
})

for (const [key, label] of Object.entries(fieldNames)) {
  for (const { name, value } of blankAnswerCases) {
    test(`refuses to assemble when ${key} is ${name}, naming ${label}`, () => {
      const answers = { ...filledAnswers, [key]: value }

      assert.throws(() => assemblePrompt(answers), new RegExp(`${label} is blank`))
    })
  }

  test(`refuses to assemble when ${key} is missing, naming ${label}`, () => {
    const { [key]: _missing, ...answers } = filledAnswers

    assert.throws(() => assemblePrompt(answers), new RegExp(`${label} is blank`))
  })
}

const finishedPromptCases = [
  { name: 'a finished sentence', text: 'Build a game about cats for kids in retro style.', finished: true },
  { name: 'a finished sentence starting with "Build an"', text: 'Build an app about cats for kids in retro style.', finished: true },
  { name: 'a finished sentence with surrounding whitespace', text: '  Build a game about cats for kids in retro style.\n', finished: true },
  { name: 'a sentence with a bracketed blank', text: 'Build a [Theme] about cats for kids in retro style.', finished: false },
  { name: 'the unfilled template', text: 'Build a [Theme] about [Subject] for [Audience] in [Style] style.', finished: false },
  { name: 'a sentence with an empty part', text: 'Build a game about   for kids in retro style.', finished: false },
  { name: 'a part holding a bracketed blank', text: 'Build a game about cats for kids in [Style] style.', finished: false },
  { name: 'other text', text: 'Make me a website about cats', finished: false },
  { name: 'an empty string', text: '', finished: false },
]

for (const { name, text, finished } of finishedPromptCases) {
  test(`${finished ? 'accepts' : 'rejects'} ${name} as a finished prompt`, () => {
    assert.equal(isFinishedPrompt(text), finished)
  })
}

test('loads the extension under the pinned Pi packages after install', { timeout: installTimeoutMilliseconds + 60_000 }, async (test) => {
  const installedPackage = path.join(await makeTemporaryDirectory(test), 'package')
  await cp(packageDirectory, installedPackage, { recursive: true, filter: (source) => path.basename(source) !== 'node_modules' })
  const installed = await runExecutable(path.join(installedPackage, 'install'), [], { timeout: installTimeoutMilliseconds })
  assert.equal(installed.code, 0, installed.stderr)
  const projectDirectory = await makeTemporaryDirectory(test)
  const agentDirectory = await makeTemporaryDirectory(test)
  const piDirectory = path.join(installedPackage, 'node_modules', '@earendil-works', 'pi-coding-agent')
  const pi = await import(pathToFileURL(path.join(piDirectory, 'dist', 'index.js')))

  const { extensions, errors } = await pi.discoverAndLoadExtensions([path.join(installedPackage, 'mad-libs.mjs')], projectDirectory, agentDirectory)

  const piManifest = JSON.parse(await readFile(path.join(piDirectory, 'package.json'), 'utf8'))
  assert.equal(piManifest.version, '1.0.4')
  assert.deepEqual(errors, [])
  assert.equal(extensions.length, 1)
  assert.ok(extensions[0].commands.has('mad-libs'))
  for (const eventName of ['session_start', 'agent_settled', 'input']) {
    assert.ok(extensions[0].handlers.has(eventName), `no ${eventName} handler`)
  }
})

test('setup copies the dice sheet and serves the waiting page, then the app once index.html exists', async (test) => {
  const port = await findFreePort()
  const workspace = await makeWorkspace(test, port)

  const setup = await runHook('setup', workspace, port)
  const waiting = await getPreview(port)
  await writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>My app</title><body>hello app</body>')
  const app = await getPreview(port)

  assert.equal(setup.code, 0, setup.stderr)
  assert.equal(await readFile(path.join(workspace, 'dice-sheet.md'), 'utf8'), await readFile(path.join(packageDirectory, 'dice-sheet.md'), 'utf8'))
  assert.equal(waiting.status, 200)
  assert.match(waiting.text, /Waiting for your app/)
  assert.equal(app.status, 200)
  assert.match(app.text, /hello app/)
})

test('setup fails naming the port when it is busy, and leaves the other listener and no state file', async (test) => {
  const port = await findFreePort()
  await holdPort(test, port, 'foreign listener')
  const workspace = await makeWorkspace(test, port)

  const setup = await runHook('setup', workspace, port)
  const afterwards = await getPreview(port)

  assert.notEqual(setup.code, 0)
  assert.match(setup.stderr, new RegExp(String(port)))
  assert.equal(afterwards.text, 'foreign listener')
  assert.equal(await exists(path.join(workspace, '.preview-state.json')), false)
})

test('cleanup run twice after setup exits 0 both times and closes the port', async (test) => {
  const port = await findFreePort()
  const workspace = await makeWorkspace(test, port)
  const setup = await runHook('setup', workspace, port)
  assert.equal(setup.code, 0, setup.stderr)

  const first = await runHook('cleanup', workspace, port)
  const second = await runHook('cleanup', workspace, port)

  assert.equal(first.code, 0, first.stderr)
  assert.equal(second.code, 0, second.stderr)
  assert.equal(await isRefused(port), true)
})

test('cleanup after a failed setup exits 0 and leaves the other listener answering', async (test) => {
  const port = await findFreePort()
  await holdPort(test, port, 'foreign listener')
  const workspace = await makeWorkspace(test, port)
  await runHook('setup', workspace, port)

  const cleanup = await runHook('cleanup', workspace, port)
  const afterwards = await getPreview(port)

  assert.equal(cleanup.code, 0, cleanup.stderr)
  assert.equal(afterwards.text, 'foreign listener')
})

test('cleanup exits 0 when the workspace does not exist', async (test) => {
  const port = await findFreePort()
  const parent = await makeTemporaryDirectory(test)
  await mkdir(path.join(parent, 'present'))

  const cleanup = await runHook('cleanup', path.join(parent, 'missing'), port)

  assert.equal(cleanup.code, 0, cleanup.stderr)
})
