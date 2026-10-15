// Proves the birdsbirdbirds package: check-bird.mjs accepts real gallery
// birds and rejects CSS that could escape the page's keyframes <style>; the
// page server saves only PNGs to bird.png and serves only checked birds; the
// setup and cleanup hooks start and stop it; the label never parses HTML.

import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

import { checkBird, MAX_BIRD_FILE_BYTES, MAX_KEYFRAMES_BYTES } from '../birdsbirdbirds/check-bird.mjs'
import { createBirdLabel } from '../birdsbirdbirds/page/bird-label.mjs'
import { createBirdServer, MAX_PNG_BYTES } from '../birdsbirdbirds/server.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const packageDirectory = path.join(testDirectory, '..', 'birdsbirdbirds')
const checkerScript = path.join(packageDirectory, 'check-bird.mjs')

// Entries from the BirdsBirdBirds gallery's manifest.json, with `id` and `image` removed.
const GALLERY_BIRDS = [
  {
    bird_name: 'J.R. "Bob" Dobbs',
    origin: 'The High Himalaya',
    animation: {
      css_keyframes: '@keyframes fly_FLAP { 0% { transform: translate(-20vw, 60vh) rotate(-5deg); } 20% { transform: translate(10vw, 75vh) rotate(3deg); } 40% { transform: translate(45vw, 30vh) rotate(-8deg); } 60% { transform: translate(75vw, 55vh) rotate(4deg); } 80% { transform: translate(100vw, 35vh) rotate(-3deg); } 100% { transform: translate(120vw, 45vh) rotate(6deg); } }',
      animation_name: 'fly_FLAP',
      duration: '14s',
      timing_function: 'ease-in-out',
    },
  },
  {
    bird_name: 'Anonymous',
    origin: 'GitHub',
    animation: {
      css_keyframes: '@keyframes fly_bird_da0279f1 { 0% { transform: translate(-20vw, 30vh); } 100% { transform: translate(120vw, 47vh); } }',
      animation_name: 'fly_bird_da0279f1',
      duration: '20s',
      timing_function: 'linear',
    },
  },
  {
    bird_name: 'Floopy Bird',
    origin: 'Nest',
    animation: {
      css_keyframes: '@keyframes fly_dive { 0% { transform: translate(-20vw, 75vh) rotate(-10deg); } 15% { transform: translate(10vw, 60vh) rotate(-25deg); } 35% { transform: translate(35vw, 15vh) rotate(-40deg); } 60% { transform: translate(65vw, 45vh) rotate(15deg); } 80% { transform: translate(90vw, 30vh) rotate(-10deg); } 100% { transform: translate(120vw, 55vh) rotate(5deg); } }',
      animation_name: 'fly_dive',
      duration: '21s',
      timing_function: 'ease-in-out',
    },
  },
  {
    bird_name: 'Abdul',
    origin: 'North Carolina',
    animation: {
      css_keyframes: '@keyframes fly_flit { 0% { transform: translate(-20vw, 55vh) rotate(-10deg); } 25% { transform: translate(15vw, 40vh) rotate(5deg); } 50% { transform: translate(50vw, 65vh) rotate(-8deg); } 75% { transform: translate(85vw, 30vh) rotate(2deg); } 100% { transform: translate(120vw, 45vh) rotate(-5deg); } }',
      animation_name: 'fly_flit',
      duration: '22s',
      timing_function: 'cubic-bezier(0.42, 0, 0.58, 1)',
    },
  },
  {
    bird_name: 'Lily',
    origin: 'University of South Carolina',
    animation: {
      css_keyframes: '@keyframes fly_XXXX { 0% { transform: translate(-20vw, 40vh) rotate(-5deg); } 50% { transform: translate(50vw, 20vh) rotate(3deg); } 100% { transform: translate(120vw, 35vh) rotate(-3deg); } }',
      animation_name: 'fly_XXXX',
      duration: '18s',
      timing_function: 'ease-in-out',
    },
  },
]

/** Builds a valid bird entry named fly_test; `overrides` and `animation` replace only the fields a test is about. */
const birdEntry = ({ animation = {}, ...overrides } = {}) => ({
  bird_name: 'Robin',
  origin: 'Durham, NC',
  animation: {
    css_keyframes: '@keyframes fly_test { 0% { transform: translate(-20vw, 50vh); } 100% { transform: translate(120vw, 40vh); } }',
    animation_name: 'fly_test',
    duration: '12s',
    timing_function: 'linear',
    ...animation,
  },
  ...overrides,
})

/** Builds a valid bird entry whose css_keyframes is `css`. */
const birdWithKeyframes = (css) => birdEntry({ animation: { css_keyframes: css } })

/** Runs check-bird.mjs as a child process from `cwd` with the given arguments. */
const runChecker = (args, cwd) => spawnSync(process.execPath, [checkerScript, ...args], { cwd, encoding: 'utf8' })

/** Makes a fresh temporary directory, runs `body` with it, and removes it afterwards. */
const withTemporaryDirectory = async (body) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'birdsbirdbirds-test-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

for (const bird of GALLERY_BIRDS) {
  test(`accepts the gallery bird ${bird.animation.animation_name}`, () => {
    const errors = checkBird(bird)

    assert.deepEqual(errors, [])
  })
}

const REJECTED_BIRDS = [
  {
    behavior: 'rejects a url( in the keyframes',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: url(evil.svg); } }'),
    mentions: /css_keyframes: "url\(" is not allowed/,
  },
  {
    behavior: 'rejects an @import',
    entry: birdWithKeyframes('@import x; @keyframes fly_test { 0% { transform: none; } }'),
    mentions: /"@import" is not allowed/,
  },
  {
    behavior: 'rejects an extra rule after the keyframes block',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: none; } } body { display: none }'),
    mentions: /found "body" after the closing "}" of @keyframes/,
  },
  {
    behavior: 'rejects a frame closed early so later frames land outside the block',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: none; } } 100% { transform: none; }'),
    mentions: /found "100%" after the closing "}" of @keyframes/,
  },
  {
    behavior: 'rejects unbalanced braces',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: none; } } 100% { transform: none; } }'),
    mentions: /braces are unbalanced \(3 "\{" and 4 "}"\)/,
  },
  {
    behavior: 'rejects a second at-rule inside the block',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: none; } @media screen { } }'),
    mentions: /second at-rule "@media"/,
  },
  {
    behavior: 'rejects a keyframes name that differs from animation_name',
    entry: birdWithKeyframes('@keyframes fly_other { 0% { transform: none; } }'),
    mentions: /"fly_other" does not match animation.animation_name "fly_test"/,
  },
  {
    behavior: 'rejects css_keyframes over the byte cap',
    entry: birdWithKeyframes(`@keyframes fly_test { ${'0% { opacity: 1; } '.repeat(250)}}`),
    mentions: new RegExp(`css_keyframes is \\d+ bytes, over the ${MAX_KEYFRAMES_BYTES}-byte cap`),
  },
  {
    behavior: 'rejects a bird_name over the length limit',
    entry: birdEntry({ bird_name: 'R'.repeat(41) }),
    mentions: /bird_name is 41 characters, over the 40-character limit/,
  },
  {
    behavior: 'rejects a property outside the allowlist with the transform alternative',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { left: 10px; } }'),
    mentions: /property "left" is not allowed; move the bird with transform: translate/,
  },
  {
    behavior: 'rejects a transform function outside the allowlist',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: matrix(1, 0, 0, 1, 0, 0); } }'),
    mentions: /transform "matrix\(" is not allowed/,
  },
  {
    behavior: 'rejects an unknown top-level key such as id',
    entry: birdEntry({ id: 'bird_test' }),
    mentions: /"id" is an unknown key; remove it/,
  },
  {
    behavior: 'rejects quotes in the keyframes',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: "none"; } }'),
    mentions: /quotes are not allowed/,
  },
  {
    behavior: 'rejects a backslash escape in the keyframes',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: none\\7d; } }'),
    mentions: /backslash escapes are not allowed/,
  },
  {
    behavior: 'rejects a duration outside the allowed range',
    entry: birdEntry({ animation: { duration: '1s' } }),
    mentions: /animation.duration "1s" is out of range; use 2s to 60s/,
  },
  {
    behavior: 'rejects a timing function outside the allowlist',
    entry: birdEntry({ animation: { timing_function: 'steps(4)' } }),
    mentions: /animation.timing_function "steps\(" is not allowed; use linear/,
  },
]

for (const { behavior, entry, mentions } of REJECTED_BIRDS) {
  test(behavior, () => {
    const errors = checkBird(entry)

    assert.ok(errors.length > 0, 'expected at least one error')
    assert.match(errors.join('\n'), mentions)
  })
}

test('the checker CLI passes a valid bird.json from the current directory', () => withTemporaryDirectory(async (workspace) => {
  await writeFile(path.join(workspace, 'bird.json'), JSON.stringify(GALLERY_BIRDS[2]))

  const result = runChecker([], workspace)

  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'ok: Floopy Bird from Nest passes\n')
}))

test('the checker CLI fails an invalid bird with an actionable message', () => withTemporaryDirectory(async (workspace) => {
  const birdFile = path.join(workspace, 'bird.json')
  await writeFile(birdFile, JSON.stringify(birdWithKeyframes('@keyframes fly_test { 0% { left: 10px; } }')))

  const result = runChecker([birdFile], workspace)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /property "left" is not allowed; move the bird with transform/)
}))

test('the checker CLI fails a file over the byte cap without parsing it', () => withTemporaryDirectory(async (workspace) => {
  const birdFile = path.join(workspace, 'bird.json')
  await writeFile(birdFile, ' '.repeat(MAX_BIRD_FILE_BYTES + 1))

  const result = runChecker([birdFile], workspace)

  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`over the ${MAX_BIRD_FILE_BYTES}-byte cap`))
}))

const SERVER_TOKEN = 'test-token'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Builds one PNG chunk: length, type, data, and the CRC over type and data. */
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typeAndData))

  return Buffer.concat([length, typeAndData, checksum])
}

/** A valid 1×1 transparent RGBA PNG. */
const TINY_PNG = (() => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(6, 9)
  const transparentPixelRow = Buffer.from([0, 0, 0, 0, 0])

  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(transparentPixelRow)), pngChunk('IEND', Buffer.alloc(0))])
})()

/** Starts a page server for `workspace` on a free loopback port, closed when the test ends; resolves its port. */
const startBirdServer = async (t, workspace) => {
  const server = createBirdServer({ workspace, token: SERVER_TOKEN })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })

  return server.address().port
}

/**
 * Sends one HTTP request with exactly the given path and headers (Host
 * defaults to 127.0.0.1:<port>) and resolves `{ status, headers, body }`.
 * Errors after the response arrives, such as the server dropping an
 * oversized upload, are ignored.
 */
const sendRequest = ({ port, method = 'GET', requestPath = '/', headers = {}, body }) => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers: { host: `127.0.0.1:${port}`, ...headers } }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
    response.on('error', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
  })
  request.on('error', reject)
  request.end(body)
})

/** POSTs a PNG body to /bird.png; `headers` replace only the defaults a test is about. */
const postBird = ({ port, body = TINY_PNG, headers = {}, requestPath = '/bird.png' }) => sendRequest({
  port,
  method: 'POST',
  requestPath,
  headers: { 'content-type': 'image/png', 'content-length': String(body.length), ...headers },
  body,
})

/** Makes a temporary directory with an empty `workspace` inside, so a test can check nothing lands beside it. */
const withWorkspace = (body) => withTemporaryDirectory(async (directory) => {
  const workspace = path.join(directory, 'workspace')
  await mkdir(workspace)

  return body({ directory, workspace })
})

test('the server saves a PNG upload as bird.png and writes nothing else', (t) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(t, workspace)

  const response = await postBird({ port, headers: { origin: `http://127.0.0.1:${port}` } })

  assert.equal(response.status, 204)
  assert.deepEqual(await readFile(path.join(workspace, 'bird.png')), TINY_PNG)
  assert.deepEqual(await readdir(workspace), ['bird.png'])
}))

test('the server refuses a body over the cap with 413 and saves nothing', (t) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(t, workspace)
  const oversized = Buffer.concat([TINY_PNG, Buffer.alloc(MAX_PNG_BYTES)])

  const response = await postBird({ port, body: oversized })

  assert.equal(response.status, 413)
  assert.deepEqual(await readdir(workspace), [])
}))

test('the server refuses a streamed body once it passes the cap, with no Content-Length', (t) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(t, workspace)
  const oversized = Buffer.concat([TINY_PNG, Buffer.alloc(MAX_PNG_BYTES)])

  const response = await sendRequest({ port, method: 'POST', requestPath: '/bird.png', headers: { 'content-type': 'image/png', 'transfer-encoding': 'chunked' }, body: oversized })

  assert.equal(response.status, 413)
  assert.deepEqual(await readdir(workspace), [])
}))

const REFUSED_UPLOADS = [
  { behavior: 'a body that is not a PNG with 415', upload: { body: Buffer.from('GIF89a not a png at all') }, status: 415 },
  { behavior: 'a PNG signature without an IHDR chunk with 415', upload: { body: Buffer.concat([PNG_SIGNATURE, pngChunk('IEND', Buffer.alloc(0))]) }, status: 415 },
  { behavior: 'the wrong Content-Type with 415', upload: { headers: { 'content-type': 'image/png; charset=utf-8' } }, status: 415 },
  { behavior: 'a foreign Origin with 403', upload: { headers: { origin: 'http://evil.example' } }, status: 403 },
  { behavior: 'a Host that is not the server with 421', upload: { headers: { host: 'evil.example:4322' } }, status: 421 },
  { behavior: 'POST /../bird.png with 404', upload: { requestPath: '/../bird.png' }, status: 404 },
  { behavior: 'POST /bird.png/../x with 404', upload: { requestPath: '/bird.png/../x' }, status: 404 },
  { behavior: 'POST /%2e%2e/bird.png with 404', upload: { requestPath: '/%2e%2e/bird.png' }, status: 404 },
]

for (const { behavior, upload, status } of REFUSED_UPLOADS) {
  test(`the server refuses ${behavior} and writes nothing`, (t) => withWorkspace(async ({ directory, workspace }) => {
    const port = await startBirdServer(t, workspace)

    const response = await postBird({ port, ...upload })

    assert.equal(response.status, status)
    assert.deepEqual(await readdir(workspace), [])
    assert.deepEqual(await readdir(directory), ['workspace'])
  }))
}

test('the server answers 404 for bird.json before Pi writes it', (t) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(t, workspace)

  const response = await sendRequest({ port, requestPath: '/bird.json' })

  assert.equal(response.status, 404)
}))

test('the server serves a bird.json that passes the checker', (t) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(t, workspace)
  await writeFile(path.join(workspace, 'bird.json'), JSON.stringify(GALLERY_BIRDS[0]))

  const response = await sendRequest({ port, requestPath: '/bird.json' })

  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), GALLERY_BIRDS[0])
}))

test('the server answers 422 for a failing bird.json and never serves its keyframes', (t) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(t, workspace)
  const keyframes = '@keyframes fly_test { 0% { transform: url(https://evil.example/x.svg); } }'
  await writeFile(path.join(workspace, 'bird.json'), JSON.stringify(birdWithKeyframes(keyframes)))

  const response = await sendRequest({ port, requestPath: '/bird.json' })

  assert.equal(response.status, 422)
  assert.ok(!response.body.toString().includes('evil.example'))
  assert.match(JSON.parse(response.body).errors.join('\n'), /"url\(" is not allowed/)
}))

test('the server answers 422 for a bird.json over the byte cap', (t) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(t, workspace)
  await writeFile(path.join(workspace, 'bird.json'), ' '.repeat(MAX_BIRD_FILE_BYTES + 1))

  const response = await sendRequest({ port, requestPath: '/bird.json' })

  assert.equal(response.status, 422)
}))

/** Resolves a TCP port that was free a moment ago, by binding port 0 and closing. */
const findFreePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.on('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

/** Runs the package's `setup` or `cleanup` hook for `workspace` on `port`; resolves `{ code, stdout, stderr }`. */
const runHook = (hook, { workspace, port }) => new Promise((resolve) => {
  const environment = { ...process.env, BOOTHSTRAP_WORKSPACE: workspace, BIRDSBIRDBIRDS_PORT: String(port) }
  execFile(path.join(packageDirectory, hook), { env: environment, timeout: 20_000 }, (error, stdout, stderr) => {
    resolve({ code: error === null ? 0 : error.code, stdout, stderr })
  })
})

/** Runs setup in a fresh workspace on a free port, with cleanup registered for when the test ends. */
const runSetup = async (t, workspace) => {
  const port = await findFreePort()
  t.after(() => runHook('cleanup', { workspace, port }))

  return { port, setupResult: await runHook('setup', { workspace, port }) }
}

/** True when something answers GET /health on `port`. */
const isAnswering = (port) => sendRequest({ port, requestPath: '/health' }).then(() => true, () => false)

test('setup starts the page server and exits, and cleanup stops it', (t) => withWorkspace(async ({ workspace }) => {
  const { port, setupResult } = await runSetup(t, workspace)
  const health = await sendRequest({ port, requestPath: '/health' })
  const page = await sendRequest({ port, requestPath: '/' })

  const cleanupResult = await runHook('cleanup', { workspace, port })

  assert.equal(setupResult.code, 0, setupResult.stderr)
  assert.equal(health.status, 200)
  assert.match(JSON.parse(health.body).instance, /^[0-9a-f]{64}$/)
  assert.equal(page.status, 200)
  assert.match(page.body.toString(), /<script type="module" src="\/app.mjs"><\/script>/)
  assert.match(page.headers['content-security-policy'], /script-src 'self'/)
  assert.equal(cleanupResult.code, 0, cleanupResult.stderr)
  assert.equal(await isAnswering(port), false)
  assert.deepEqual(await readdir(workspace), [])
}))

test('setup fails with a message naming the port when the port is busy', (t) => withWorkspace(async ({ workspace }) => {
  const occupier = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve))
  const { port } = occupier.address()
  t.after(() => new Promise((resolve) => occupier.close(resolve)))

  const setupResult = await runHook('setup', { workspace, port })

  assert.notEqual(setupResult.code, 0)
  assert.match(setupResult.stderr, new RegExp(`port ${port} is busy`))
}))

test('cleanup succeeds when run twice', (t) => withWorkspace(async ({ workspace }) => {
  const { port } = await runSetup(t, workspace)

  const firstRun = await runHook('cleanup', { workspace, port })
  const secondRun = await runHook('cleanup', { workspace, port })

  assert.equal(firstRun.code, 0, firstRun.stderr)
  assert.equal(secondRun.code, 0, secondRun.stderr)
}))

test('cleanup succeeds after setup failed on a busy port', (t) => withWorkspace(async ({ workspace }) => {
  const occupier = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve))
  const { port } = occupier.address()
  t.after(() => new Promise((resolve) => occupier.close(resolve)))
  await runHook('setup', { workspace, port })

  const cleanupResult = await runHook('cleanup', { workspace, port })

  assert.equal(cleanupResult.code, 0, cleanupResult.stderr)
  assert.deepEqual(await readdir(workspace), [])
}))

/** A minimal DOM element that records textContent and throws if anything parses HTML. */
class TextOnlyElement {
  constructor(tagName) {
    this.tagName = tagName
    this.className = ''
    this.textContent = ''
    this.children = []
  }

  /** Appends a child element. */
  appendChild(child) {
    this.children.push(child)
    return child
  }

  /** Throws: label code must never parse HTML. */
  get innerHTML() { throw new Error('innerHTML read') }

  /** Throws: label code must never parse HTML. */
  set innerHTML(_) { throw new Error('innerHTML written') }

  /** Throws: label code must never parse HTML. */
  get outerHTML() { throw new Error('outerHTML read') }

  /** Throws: label code must never parse HTML. */
  set outerHTML(_) { throw new Error('outerHTML written') }

  /** Throws: label code must never parse HTML. */
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML called') }
}

/** A fake document whose createElement makes TextOnlyElements. */
const textOnlyDocument = { createElement: (tagName) => new TextOnlyElement(tagName) }

test('the bird label puts names in as text, never as HTML', () => {
  const birdName = '<img src=x onerror=alert(1)>'

  const label = createBirdLabel(textOnlyDocument, { birdName, origin: '<b>Durham</b>' })

  assert.equal(label.className, 'bird-label')
  assert.deepEqual(label.children.map((child) => [child.className, child.textContent]), [
    ['name', '<img src=x onerror=alert(1)>'],
    ['origin', '· <b>Durham</b>'],
  ])
})
