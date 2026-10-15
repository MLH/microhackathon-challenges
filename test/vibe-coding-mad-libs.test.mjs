// Proves the vibe-coding-mad-libs package: prompt assembly, the extension
// loading under its pinned Pi packages, and the setup and cleanup hooks. The
// install test is the only one that uses the network, to reach the npm registry.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, link, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, get } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assemblePrompt, fillSentence, hasUnfilledBlank, isFinishedPrompt } from '../vibe-coding-mad-libs/prompt.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const packageDirectory = path.join(testDirectory, '..', 'vibe-coding-mad-libs')
const installTimeoutMilliseconds = 300_000
const serverExitTimeoutMilliseconds = 5_000

const filledAnswers = { theme: 'game', subject: 'cats', audience: 'kids', style: 'retro' }

/** Makes a fresh temporary directory that `context` removes when the test ends. */
const makeTemporaryDirectory = async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mad-libs-test-'))
  context.after(() => rm(directory, { recursive: true, force: true }))

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
const holdPort = (context, port, body) => new Promise((resolve, reject) => {
  const server = createServer((_request, response) => response.end(body))
  context.after(() => new Promise((done) => {
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
  child.once('close', (code) => resolve({ code, stdout, stderr, pid: child.pid }))
})

/** Runs the package's `hook` (setup or cleanup) with the workspace and preview port set; `options` adds spawn options. */
const runHook = (hook, workspace, port, options) => runExecutable(path.join(packageDirectory, hook), [], {
  ...options,
  env: { ...process.env, BOOTHSTRAP_WORKSPACE: workspace, MAD_LIBS_PREVIEW_PORT: String(port) },
})

/** Makes a workspace and registers cleanup to run in teardown, so no server outlives the test. */
const makeWorkspace = async (context, port) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'mad-libs-test-'))
  context.after(async () => {
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

/** GETs the preview's `/` on `port` with `host` as the Host header, as a browser on that name would. */
const getPreviewAs = (port, host) => new Promise((resolve, reject) => {
  get({ host: '127.0.0.1', port, path: '/', headers: { host } }, (response) => {
    let text = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => { text += chunk })
    response.on('end', () => resolve({ status: response.statusCode, text }))
  }).on('error', reject)
})

/** True when connecting to `port` is refused. */
const isRefused = async (port) => {
  try {
    await fetch(`http://127.0.0.1:${port}/`)
  } catch (error) {
    return error.cause?.code === 'ECONNREFUSED'
  }

  return false
}

/** Polls until connecting to `port` is refused, failing the test if it never is. */
const waitUntilRefused = async (port) => {
  const deadline = Date.now() + serverExitTimeoutMilliseconds
  while (!(await isRefused(port))) {
    assert.ok(Date.now() < deadline, `port ${port} still accepts connections`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Reads one column of `ps` for `pid`, such as `pgid`. */
const readProcessColumn = async (column, pid) => (await runExecutable('ps', ['-o', `${column}=`, '-p', String(pid)])).stdout.trim()

/** Finds the pid of the preview server serving `workspace`, or undefined when none runs. */
const findServerPid = async (workspace) => {
  const { stdout } = await runExecutable('ps', ['-eo', 'pid=,args='])
  const line = stdout.split('\n').find((candidate) => candidate.endsWith(`preview.mjs serve ${workspace}`))

  return line === undefined ? undefined : Number(line.trim().split(/\s+/)[0])
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

test('uses "an" before a Theme that starts with a vowel', () => {
  const answers = { ...filledAnswers, theme: 'arcade game' }

  const sentence = assemblePrompt(answers)

  assert.equal(sentence, 'Build an arcade game about cats for kids in retro style.')
})

test('fills the form preview with answers as typed and brackets the blanks', () => {
  const answers = { theme: 'price $& game', subject: ' ' }

  const sentence = fillSentence(answers)

  assert.equal(sentence, 'Build a price $& game about [Subject] for [Audience] in [Style] style.')
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
  { name: 'a finished sentence without a final period', text: 'Build a game about cats for kids in retro style', finished: true },
  { name: 'a finished sentence ending in "!"', text: 'Build a game about cats for kids in retro style!', finished: true },
  { name: 'a finished sentence with surrounding whitespace', text: '  Build a game about cats for kids in retro style.\n', finished: true },
  { name: 'a sentence with a bracketed blank', text: 'Build a [Theme] about cats for kids in retro style.', finished: false },
  { name: 'the unfilled template', text: 'Build a [Theme] about [Subject] for [Audience] in [Style] style.', finished: false },
  { name: 'a sentence with an empty part', text: 'Build a game about   for kids in retro style.', finished: false },
  { name: 'a part holding a bracketed blank', text: 'Build a game about cats for kids in [Style] style.', finished: false },
  { name: 'other text', text: 'Make me a website about cats', finished: false },
  { name: 'an empty string', text: '', finished: false },
]

const unfilledBlankCases = [
  { text: 'Build a [Theme] about cats for kids in retro style.', unfilled: true },
  { text: 'Build a game about cats for kids in [style] style', unfilled: true },
  { text: 'Build a game about cats for kids in retro style', unfilled: false },
  { text: 'Build a game about cats, please', unfilled: false },
]

for (const { text, unfilled } of unfilledBlankCases) {
  test(`${unfilled ? 'finds' : 'finds no'} bracketed blank in "${text}"`, () => {
    assert.equal(hasUnfilledBlank(text), unfilled)
  })
}

for (const { name, text, finished } of finishedPromptCases) {
  test(`${finished ? 'accepts' : 'rejects'} ${name} as a finished prompt`, () => {
    assert.equal(isFinishedPrompt(text), finished)
  })
}

test('loads the extension under the pinned Pi packages after install', { timeout: installTimeoutMilliseconds + 60_000 }, async (context) => {
  const installedPackage = path.join(await makeTemporaryDirectory(context), 'package')
  await cp(packageDirectory, installedPackage, { recursive: true, filter: (source) => path.basename(source) !== 'node_modules' })
  const installed = await runExecutable(path.join(installedPackage, 'install'), [], { timeout: installTimeoutMilliseconds })
  assert.equal(installed.code, 0, installed.stderr)
  const projectDirectory = await makeTemporaryDirectory(context)
  const agentDirectory = await makeTemporaryDirectory(context)
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

test('setup copies the dice sheet and serves the waiting page', async (context) => {
  const port = await findFreePort()
  const workspace = await makeWorkspace(context, port)

  const setup = await runHook('setup', workspace, port)
  const waiting = await getPreview(port)

  assert.equal(setup.code, 0, setup.stderr)
  assert.equal(await readFile(path.join(workspace, 'dice-sheet.md'), 'utf8'), await readFile(path.join(packageDirectory, 'dice-sheet.md'), 'utf8'))
  assert.equal(waiting.status, 200)
  assert.match(waiting.text, /Waiting for your app/)
})

test('the preview serves index.html once it exists', async (context) => {
  const port = await findFreePort()
  const workspace = await makeWorkspace(context, port)
  const setup = await runHook('setup', workspace, port)
  assert.equal(setup.code, 0, setup.stderr)
  await writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>My app</title><body>hello app</body>')

  const app = await getPreview(port)

  assert.equal(app.status, 200)
  assert.match(app.text, /hello app/)
})

test('the preview adds the reload script before the last </body>, leaving one in a script intact', async (context) => {
  const port = await findFreePort()
  const workspace = await makeWorkspace(context, port)
  const setup = await runHook('setup', workspace, port)
  assert.equal(setup.code, 0, setup.stderr)
  await writeFile(path.join(workspace, 'index.html'), '<body><script>const tag = "</body>"</script></body>')

  const app = await getPreview(port)

  assert.match(app.text, /^<body><script>const tag = "<\/body>"<\/script><script>new EventSource/)
  assert.match(app.text, /<\/script><\/body>$/)
})

const reloadPlacementCases = [
  { name: 'an uppercase </BODY>', page: '<BODY>app</BODY>', served: /^<BODY>app<script>new EventSource.*<\/script><\/BODY>$/ },
  { name: 'a </body > with a space', page: '<body>app</body >', served: /^<body>app<script>new EventSource.*<\/script><\/body >$/ },
  { name: 'a wide-lowercasing character before </body>', page: '<body>İ</body>', served: /^<body>İ<script>new EventSource.*<\/script><\/body>$/ },
  { name: 'no </body> at all', page: '<p>app</p>', served: /^<p>app<\/p><script>new EventSource.*<\/script>$/ },
]

for (const { name, page, served } of reloadPlacementCases) {
  test(`the preview places the reload script correctly for ${name}`, async (context) => {
    const port = await findFreePort()
    const workspace = await makeWorkspace(context, port)
    const setup = await runHook('setup', workspace, port)
    assert.equal(setup.code, 0, setup.stderr)
    await writeFile(path.join(workspace, 'index.html'), page)

    const app = await getPreview(port)

    assert.match(app.text, served)
  })
}

test('the preview refuses a hard-linked index.html', async (context) => {
  const port = await findFreePort()
  const workspace = await makeWorkspace(context, port)
  const setup = await runHook('setup', workspace, port)
  assert.equal(setup.code, 0, setup.stderr)
  const outside = path.join(await makeTemporaryDirectory(context), 'outside.html')
  await writeFile(outside, 'outside secret')
  await link(outside, path.join(workspace, 'index.html'))

  const app = await getPreview(port)

  assert.equal(app.status, 503)
  assert.doesNotMatch(app.text, /outside secret/)
})

test('the preview tells a visitor on another host name which URL to open', async (context) => {
  const port = await findFreePort()
  const workspace = await makeWorkspace(context, port)
  const setup = await runHook('setup', workspace, port)
  assert.equal(setup.code, 0, setup.stderr)

  const refused = await getPreviewAs(port, `localhost:${port}`)

  assert.equal(refused.status, 403)
  assert.match(refused.text, new RegExp(`Open http://127\\.0\\.0\\.1:${port}/`))
})

test('setup keeps the preview server in setup\'s own process group', async (context) => {
  const port = await findFreePort()
  const workspace = await makeWorkspace(context, port)

  const setup = await runHook('setup', workspace, port, { detached: true })
  const serverPid = await findServerPid(workspace)
  context.after(() => { try { process.kill(-setup.pid, 'SIGKILL') } catch { /* The group is already gone. */ } })

  assert.equal(setup.code, 0, setup.stderr)
  assert.notEqual(serverPid, undefined, 'no preview server is running')
  assert.equal(await readProcessColumn('pgid', serverPid), String(setup.pid))
})

test('setup fails naming the port when it is busy, and leaves the other listener and no state file', async (context) => {
  const port = await findFreePort()
  await holdPort(context, port, 'foreign listener')
  const workspace = await makeWorkspace(context, port)

  const setup = await runHook('setup', workspace, port)
  const afterwards = await getPreview(port)

  assert.notEqual(setup.code, 0)
  assert.match(setup.stderr, new RegExp(String(port)))
  assert.equal(afterwards.text, 'foreign listener')
  assert.equal(await exists(path.join(workspace, '.preview-state.json')), false)
})

test('cleanup run twice after setup exits 0 both times and closes the port', async (context) => {
  const port = await findFreePort()
  const workspace = await makeWorkspace(context, port)
  const setup = await runHook('setup', workspace, port)
  assert.equal(setup.code, 0, setup.stderr)

  const first = await runHook('cleanup', workspace, port)
  const second = await runHook('cleanup', workspace, port)

  assert.equal(first.code, 0, first.stderr)
  assert.equal(second.code, 0, second.stderr)
  assert.equal(await isRefused(port), true)
})

test('cleanup after a failed setup exits 0 and leaves the other listener answering', async (context) => {
  const port = await findFreePort()
  await holdPort(context, port, 'foreign listener')
  const workspace = await makeWorkspace(context, port)
  await runHook('setup', workspace, port)

  const cleanup = await runHook('cleanup', workspace, port)
  const afterwards = await getPreview(port)

  assert.equal(cleanup.code, 0, cleanup.stderr)
  assert.equal(afterwards.text, 'foreign listener')
})

test('cleanup after a crash exits 0 and leaves the other listener on the port answering', async (context) => {
  const port = await findFreePort()
  const workspace = await makeWorkspace(context, port)
  const setup = await runHook('setup', workspace, port)
  assert.equal(setup.code, 0, setup.stderr)
  process.kill(await findServerPid(workspace), 'SIGKILL')
  await waitUntilRefused(port)
  await holdPort(context, port, 'foreign listener')

  const cleanup = await runHook('cleanup', workspace, port)
  const afterwards = await getPreview(port)

  assert.equal(cleanup.code, 0, cleanup.stderr)
  assert.equal(afterwards.text, 'foreign listener')
})

test('cleanup exits 0 when the workspace does not exist', async (context) => {
  const port = await findFreePort()
  const parent = await makeTemporaryDirectory(context)

  const cleanup = await runHook('cleanup', path.join(parent, 'missing'), port)

  assert.equal(cleanup.code, 0, cleanup.stderr)
})
