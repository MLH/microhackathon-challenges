// Proves the birdsbirdbirds package: check-bird.mjs accepts real gallery
// birds and rejects CSS that could escape the page's keyframes stylesheet; the
// page server saves only PNGs to bird.png and serves only checked birds; the
// setup and cleanup hooks start and stop it; the label never parses HTML; the
// workspace watcher and its Pi extension report each new drawing once.

import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

import { DEFAULT_DEBOUNCE_MS, watchWorkspace } from '../birdsbirdbirds/bird-watcher.mjs'
import { checkBird, loadBirdFile, MAX_BIRD_FILE_BYTES, MAX_KEYFRAMES_BYTES } from '../birdsbirdbirds/check-bird.mjs'
import birdsbirdbirdsExtension from '../birdsbirdbirds/extension.mjs'
import { createBirdLabel } from '../birdsbirdbirds/page/bird-label.mjs'
import { createBirdServer, MAX_PNG_BYTES } from '../birdsbirdbirds/server.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const packageDirectory = path.join(testDirectory, '..', 'birdsbirdbirds')
const checkerScript = path.join(packageDirectory, 'check-bird.mjs')
const serverScript = path.join(packageDirectory, 'server.mjs')

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
const runChecker = (args, cwd) => spawnSync(process.execPath, [checkerScript, ...args], { cwd, encoding: 'utf8', timeout: 10_000 })

/** Makes a named pipe at `filePath`; opening it for reading blocks until a writer appears. */
const makeFifo = (filePath) => {
  const result = spawnSync('mkfifo', [filePath], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`mkfifo ${filePath} failed: ${result.stderr}`)
}

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

const ACCEPTED_LABELS = [
  { behavior: 'a Persian name joined with a zero-width non-joiner', bird_name: 'می\u200Cخواهم' },
  { behavior: 'a Sinhala origin joined with a zero-width joiner', origin: 'ශ්\u200Dරී ලංකාව' },
  { behavior: 'emoji built with zero-width joiners and a variation selector', bird_name: '👩\u200D💻 🏳\uFE0F\u200D🌈' },
  { behavior: 'a Tibetan name with three marks stacked on one letter', bird_name: 'སྒྲུབ' },
]

for (const { behavior, ...labels } of ACCEPTED_LABELS) {
  test(`accepts ${behavior}`, () => {
    const errors = checkBird(birdEntry(labels))

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
  {
    behavior: 'rejects a rotate() angle given as a length',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: rotate(5px); } }'),
    mentions: /css_keyframes: rotate\(5px\) needs an angle unit \(deg or turn\); write 5deg/,
  },
  {
    behavior: 'rejects a rotate() angle with no unit',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: rotate(5); } }'),
    mentions: /css_keyframes: rotate\(5\) needs an angle unit \(deg or turn\); write 5deg/,
  },
  {
    behavior: 'rejects translate() lengths with no unit',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: translate(5, 2); } }'),
    mentions: /css_keyframes: translate\(5, 2\) needs a length unit \(vw, vh, px, em, rem, or %\) on 5/,
  },
  {
    behavior: 'rejects a scale() factor with a unit',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: scale(1.2px); } }'),
    mentions: /css_keyframes: scale\(1.2px\) takes plain numbers with no unit; write 1.2/,
  },
  {
    behavior: 'rejects a skew() angle given as a length',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: skew(10vw); } }'),
    mentions: /css_keyframes: skew\(10vw\) needs an angle unit \(deg or turn\); write 10deg/,
  },
  {
    behavior: 'rejects an animation name that could collide with the page\'s own flap keyframes',
    entry: birdEntry({ animation: { animation_name: 'flap', css_keyframes: '@keyframes flap { 0% { transform: none; } }' } }),
    mentions: /animation.animation_name "flap" is not allowed; start it with fly_/,
  },
  {
    behavior: 'rejects a bidi override in the bird name',
    entry: birdEntry({ bird_name: 'Robin\u202Enivor' }),
    mentions: /bird_name contains the invisible character U\+202E; use plain visible text/,
  },
  {
    behavior: 'rejects a bird name that is only a zero-width space',
    entry: birdEntry({ bird_name: '\u200B' }),
    mentions: /bird_name contains the invisible character U\+200B; use plain visible text/,
  },
  {
    behavior: 'rejects a line separator in the origin',
    entry: birdEntry({ origin: 'Durham\u2028NC' }),
    mentions: /origin contains the invisible character U\+2028; use plain visible text/,
  },
  {
    behavior: 'rejects accent marks stacked on one letter',
    entry: birdEntry({ bird_name: 'Ro\u0301\u0302\u0303\u0304\u0305bin' }),
    mentions: /bird_name stacks 5 accent marks on one letter; use at most 4/,
  },
  {
    behavior: 'rejects a bidi isolate in the origin',
    entry: birdEntry({ origin: 'Durham\u2066NC' }),
    mentions: /origin contains the invisible character U\+2066; use plain visible text/,
  },
  {
    behavior: 'rejects a Unicode tag character in the bird name',
    entry: birdEntry({ bird_name: 'Rob\u{E0041}in' }),
    mentions: /bird_name contains the invisible character U\+E0041; use plain visible text/,
  },
  {
    behavior: 'rejects a Hangul filler in the bird name',
    entry: birdEntry({ bird_name: 'Rob\u3164in' }),
    mentions: /bird_name contains the invisible character U\+3164; use plain visible text/,
  },
  {
    behavior: 'rejects a bird name that is only a braille blank',
    entry: birdEntry({ bird_name: '\u2800' }),
    mentions: /bird_name contains the invisible character U\+2800; use plain visible text/,
  },
  {
    behavior: 'rejects a soft hyphen in the bird name',
    entry: birdEntry({ bird_name: 'Rob\u00ADin' }),
    mentions: /bird_name contains the invisible character U\+00AD; use plain visible text/,
  },
  {
    behavior: 'rejects a percentage as the z length of translate3d()',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: translate3d(0, 0, 5%); } }'),
    mentions: /css_keyframes: translate3d\(0, 0, 5%\) needs a length unit \(vw, vh, px, em, or rem; % is not allowed for z\) on 5%/,
  },
  {
    behavior: 'rejects a unit written in capitals, saying units are lowercase',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: translate(1PX, 0); } }'),
    mentions: /css_keyframes: translate\(1PX, 0\) writes the unit of 1PX in capitals; units are lowercase, like 1px/,
  },
  {
    behavior: 'rejects a bird name with no visible letters, digits, or symbols',
    entry: birdEntry({ bird_name: '\u0301' }),
    mentions: /bird_name has no visible letters, digits, or symbols; give the bird's name/,
  },
  {
    behavior: 'rejects a number written with an exponent',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: translate(1e3px, 0); } }'),
    mentions: /^animation\.css_keyframes: exponents aren't allowed \(found "1e3"\); write plain numbers like 1000px$/,
  },
  {
    behavior: 'rejects a timing function followed by more text',
    entry: birdEntry({ animation: { timing_function: 'linear, ease' } }),
    mentions: /^animation\.timing_function has extra text after "linear"; use one timing function on its own/,
  },
  {
    behavior: 'rejects transform arguments missing a comma, naming css_keyframes',
    entry: birdWithKeyframes('@keyframes fly_test { 0% { transform: translate(10vw 40vh); } }'),
    mentions: /^animation\.css_keyframes: transform translate\( arguments must be separated by ","/,
  },
]

for (const { behavior, entry, mentions } of REJECTED_BIRDS) {
  test(behavior, () => {
    const errors = checkBird(entry)

    assert.ok(errors.length > 0, 'expected at least one error')
    assert.match(errors.join('\n'), mentions)
  })
}

test('names an invisible character in css_keyframes by code point, never printing it', () => {
  const entry = birdWithKeyframes('@keyframes fly_test { 0% { transform: none\u202E; } }')

  const message = checkBird(entry).join('\n')

  assert.match(message, /U\+202E/)
  assert.ok(!message.includes('\u202E'), JSON.stringify(message))
})

test('names an invisible character in animation_name by code point, never printing it', () => {
  const entry = birdEntry({ animation: { animation_name: 'fly_\u202Etest' } })

  const message = checkBird(entry).join('\n')

  assert.match(message, /U\+202E/)
  assert.ok(!message.includes('\u202E'), JSON.stringify(message))
})

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

test('the checker CLI reports invalid JSON without echoing the file', () => withTemporaryDirectory(async (workspace) => {
  const birdFile = path.join(workspace, 'bird.json')
  await writeFile(birdFile, 'top-secret-line')

  const result = runChecker([birdFile], workspace)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /not valid JSON/)
  assert.ok(!result.stderr.includes('top-secret'), result.stderr)
}))

test('the checker CLI refuses a named pipe as bird.json instead of waiting on it', () => withTemporaryDirectory(async (workspace) => {
  makeFifo(path.join(workspace, 'bird.json'))

  const result = runChecker([], workspace)

  assert.equal(result.status, 1, `signal ${result.signal}`)
  assert.match(result.stderr, /bird.json is not a regular file/)
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
const startBirdServer = async (testContext, workspace) => {
  const server = createBirdServer({ workspace, token: SERVER_TOKEN })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  testContext.after(() => {
    server.closeAllConnections()
    server.close()
  })

  return server.address().port
}

/**
 * Sends one HTTP request with exactly the given path and headers (Host
 * defaults to 127.0.0.1:<port>) and resolves `{ status, headers, body }`.
 * Errors after the response arrives, such as the server dropping an
 * oversized upload, are ignored. With `timeoutMs`, rejects when the server
 * goes quiet for that long.
 */
const sendRequest = ({ port, method = 'GET', requestPath = '/', headers = {}, body, timeoutMs }) => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers: { host: `127.0.0.1:${port}`, ...headers }, timeout: timeoutMs }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
    response.on('error', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
  })
  request.on('error', reject)
  request.on('timeout', () => request.destroy(new Error(`${method} ${requestPath} got no answer within ${timeoutMs} ms`)))
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

test('the server saves a PNG upload as bird.png and writes nothing else', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(testContext, workspace)

  const response = await postBird({ port, headers: { origin: `http://127.0.0.1:${port}` } })

  assert.equal(response.status, 204)
  assert.deepEqual(await readFile(path.join(workspace, 'bird.png')), TINY_PNG)
  assert.deepEqual(await readdir(workspace), ['bird.png'])
}))

test('the server refuses a body over the cap with 413 and saves nothing', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(testContext, workspace)
  const oversized = Buffer.concat([TINY_PNG, Buffer.alloc(MAX_PNG_BYTES)])

  const response = await postBird({ port, body: oversized })

  assert.equal(response.status, 413)
  assert.deepEqual(await readdir(workspace), [])
}))

test('the server refuses a streamed body once it passes the cap, with no Content-Length', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(testContext, workspace)
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
  test(`the server refuses ${behavior} and writes nothing`, (testContext) => withWorkspace(async ({ directory, workspace }) => {
    const port = await startBirdServer(testContext, workspace)

    const response = await postBird({ port, ...upload })

    assert.equal(response.status, status)
    assert.deepEqual(await readdir(workspace), [])
    assert.deepEqual(await readdir(directory), ['workspace'])
  }))
}

test('the server sends the page with a CSP that admits no inline styles and no blob: images', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(testContext, workspace)

  const response = await sendRequest({ port, requestPath: '/' })

  const policy = response.headers['content-security-policy']
  assert.match(policy, /style-src 'self';/)
  assert.doesNotMatch(policy, /'unsafe-inline'|blob:/)
  assert.doesNotMatch(response.body.toString(), /<style|style=/)
}))

test('the server answers 404 for bird.json before Pi writes it', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(testContext, workspace)

  const response = await sendRequest({ port, requestPath: '/bird.json' })

  assert.equal(response.status, 404)
}))

test('the server serves a bird.json that passes the checker', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(testContext, workspace)
  await writeFile(path.join(workspace, 'bird.json'), JSON.stringify(GALLERY_BIRDS[0]))

  const response = await sendRequest({ port, requestPath: '/bird.json' })

  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), GALLERY_BIRDS[0])
}))

test('the server answers 422 for a failing bird.json and never serves its keyframes', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(testContext, workspace)
  const keyframes = '@keyframes fly_test { 0% { transform: url(https://evil.example/x.svg); } }'
  await writeFile(path.join(workspace, 'bird.json'), JSON.stringify(birdWithKeyframes(keyframes)))

  const response = await sendRequest({ port, requestPath: '/bird.json' })

  assert.equal(response.status, 422)
  assert.ok(!response.body.toString().includes('evil.example'))
  assert.match(JSON.parse(response.body).errors.join('\n'), /"url\(" is not allowed/)
}))

test('the server answers 422 for a bird.json over the byte cap', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(testContext, workspace)
  await writeFile(path.join(workspace, 'bird.json'), ' '.repeat(MAX_BIRD_FILE_BYTES + 1))

  const response = await sendRequest({ port, requestPath: '/bird.json' })

  assert.equal(response.status, 422)
}))

test('the server refuses a symlinked bird.json without echoing its target', (testContext) => withWorkspace(async ({ directory, workspace }) => {
  const port = await startBirdServer(testContext, workspace)
  const target = path.join(directory, 'secret.txt')
  await writeFile(target, 'top-secret-line')
  await symlink(target, path.join(workspace, 'bird.json'))

  const response = await sendRequest({ port, requestPath: '/bird.json' })

  assert.equal(response.status, 422)
  assert.ok(!response.body.toString().includes('top-secret'), response.body.toString())
}))

test('the server refuses a symlinked bird.json even when its target is a valid bird', (testContext) => withWorkspace(async ({ directory, workspace }) => {
  const port = await startBirdServer(testContext, workspace)
  const target = path.join(directory, 'valid-bird.json')
  await writeFile(target, JSON.stringify(GALLERY_BIRDS[0]))
  await symlink(target, path.join(workspace, 'bird.json'))

  const response = await sendRequest({ port, requestPath: '/bird.json' })

  assert.equal(response.status, 422)
  assert.match(JSON.parse(response.body).errors.join('\n'), /bird.json is not a regular file/)
}))

/**
 * Makes lstat follow symlinks until the test ends, the way a symlink swapped
 * in between the lstat check and the open would look to the reader.
 */
const swapInSymlinksAfterLstat = (testContext) => {
  const realLstatSync = fs.lstatSync
  fs.lstatSync = fs.statSync
  syncBuiltinESMExports()
  testContext.after(() => {
    fs.lstatSync = realLstatSync
    syncBuiltinESMExports()
  })
}

test('the server refuses a bird.png symlink swapped in after the lstat check', (testContext) => withWorkspace(async ({ directory, workspace }) => {
  const port = await startBirdServer(testContext, workspace)
  const target = path.join(directory, 'elsewhere.png')
  await writeFile(target, TINY_PNG)
  await symlink(target, path.join(workspace, 'bird.png'))
  swapInSymlinksAfterLstat(testContext)

  const response = await sendRequest({ port, requestPath: '/bird.png' })

  assert.equal(response.status, 422)
  assert.match(response.body.toString(), /bird.png is not a regular file/)
}))

test('the checker refuses a bird.json symlink swapped in after the lstat check', (testContext) => withWorkspace(async ({ directory, workspace }) => {
  const target = path.join(directory, 'valid-bird.json')
  await writeFile(target, JSON.stringify(GALLERY_BIRDS[0]))
  await symlink(target, path.join(workspace, 'bird.json'))
  swapInSymlinksAfterLstat(testContext)

  const { errors } = loadBirdFile(path.join(workspace, 'bird.json'))

  assert.match(errors.join('\n'), /bird.json is not a regular file/)
}))

test('the server does not serve a symlinked bird.png', (testContext) => withWorkspace(async ({ directory, workspace }) => {
  const port = await startBirdServer(testContext, workspace)
  const target = path.join(directory, 'elsewhere.png')
  await writeFile(target, TINY_PNG)
  await symlink(target, path.join(workspace, 'bird.png'))

  const response = await sendRequest({ port, requestPath: '/bird.png' })

  assert.equal(response.status, 422)
}))

test('the server does not serve a bird.png over the size cap', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(testContext, workspace)
  await writeFile(path.join(workspace, 'bird.png'), Buffer.concat([TINY_PNG, Buffer.alloc(MAX_PNG_BYTES)]))

  const response = await sendRequest({ port, requestPath: '/bird.png' })

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

/**
 * Starts server.mjs as a child process for `workspace` on a free port, killed
 * when the test ends; resolves its port once it says it is serving. A child
 * keeps a blocked server from freezing the test runner too.
 */
const startServerProcess = async (testContext, workspace) => {
  const port = await findFreePort()
  const child = spawn(process.execPath, [serverScript], {
    env: { ...process.env, BIRDSBIRDBIRDS_WORKSPACE: workspace, BIRDSBIRDBIRDS_TOKEN: SERVER_TOKEN, BIRDSBIRDBIRDS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  testContext.after(() => child.kill('SIGKILL'))
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('serving')) resolve()
    })
    child.on('exit', (code) => reject(new Error(`server.mjs exited with ${code} before serving`)))
  })

  return port
}

test('the server answers 422 for a named-pipe bird.json and keeps answering', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startServerProcess(testContext, workspace)
  makeFifo(path.join(workspace, 'bird.json'))

  const response = await sendRequest({ port, requestPath: '/bird.json', timeoutMs: 5000 })

  assert.equal(response.status, 422)
  assert.equal((await sendRequest({ port, requestPath: '/health', timeoutMs: 5000 })).status, 200)
}))

/** Runs the package's `setup` or `cleanup` hook for `workspace` on `port`; resolves `{ code, stdout, stderr }`. */
const runHook = (hook, { workspace, port }) => new Promise((resolve) => {
  const environment = { ...process.env, BOOTHSTRAP_WORKSPACE: workspace, BIRDSBIRDBIRDS_PORT: String(port) }
  execFile(path.join(packageDirectory, hook), { env: environment, timeout: 20_000 }, (error, stdout, stderr) => {
    resolve({ code: error === null ? 0 : error.code, stdout, stderr })
  })
})

/**
 * Runs setup in a fresh workspace on a free port. The server is shut down by
 * its token when the test ends, since the workspace, and with it the record
 * cleanup reads, is gone by then.
 */
const runSetup = async (testContext, workspace) => {
  const port = await findFreePort()
  const setupResult = await runHook('setup', { workspace, port })
  const { token } = JSON.parse(await readFile(path.join(workspace, '.birdsbirdbirds', 'server.json'), 'utf8'))
  testContext.after(() => sendRequest({ port, method: 'POST', requestPath: '/shutdown', headers: { 'x-bird-token': token } }).catch(() => {}))

  return { port, setupResult }
}

/** True when something answers GET /health on `port`. */
const isAnswering = (port) => sendRequest({ port, requestPath: '/health' }).then(() => true, () => false)

test('setup starts the page server and exits', (testContext) => withWorkspace(async ({ workspace }) => {
  const { port, setupResult } = await runSetup(testContext, workspace)

  const health = await sendRequest({ port, requestPath: '/health' })
  const page = await sendRequest({ port, requestPath: '/' })
  assert.equal(setupResult.code, 0, setupResult.stderr)
  assert.equal(health.status, 200)
  assert.match(JSON.parse(health.body).instance, /^[0-9a-f]{64}$/)
  assert.equal(page.status, 200)
  assert.match(page.body.toString(), /<script type="module" src="\/app.mjs"><\/script>/)
  assert.match(page.headers['content-security-policy'], /script-src 'self'/)
}))

test('cleanup stops the page server and removes its state', (testContext) => withWorkspace(async ({ workspace }) => {
  const { port } = await runSetup(testContext, workspace)

  const cleanupResult = await runHook('cleanup', { workspace, port })

  assert.equal(cleanupResult.code, 0, cleanupResult.stderr)
  assert.equal(await isAnswering(port), false)
  assert.deepEqual(await readdir(workspace), [])
}))

test('setup fails with a message naming the port when the port is busy', (testContext) => withWorkspace(async ({ workspace }) => {
  const occupier = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve))
  const { port } = occupier.address()
  testContext.after(() => new Promise((resolve) => occupier.close(resolve)))

  const setupResult = await runHook('setup', { workspace, port })

  assert.notEqual(setupResult.code, 0)
  assert.match(setupResult.stderr, new RegExp(`port ${port} is busy`))
}))

test('cleanup succeeds when run twice', (testContext) => withWorkspace(async ({ workspace }) => {
  const { port } = await runSetup(testContext, workspace)

  const firstRun = await runHook('cleanup', { workspace, port })
  const secondRun = await runHook('cleanup', { workspace, port })

  assert.equal(firstRun.code, 0, firstRun.stderr)
  assert.equal(secondRun.code, 0, secondRun.stderr)
}))

test('cleanup succeeds after setup failed on a busy port', (testContext) => withWorkspace(async ({ workspace }) => {
  const occupier = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve))
  const { port } = occupier.address()
  testContext.after(() => new Promise((resolve) => occupier.close(resolve)))
  await runHook('setup', { workspace, port })

  const cleanupResult = await runHook('cleanup', { workspace, port })

  assert.equal(cleanupResult.code, 0, cleanupResult.stderr)
  assert.deepEqual(await readdir(workspace), [])
}))

/** A minimal DOM element that records textContent and throws if anything parses HTML. */
class TextOnlyElement {
  /** Makes an empty element with the given tag name. */
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

const WATCH_DEBOUNCE_MS = 50
const WATCH_EVENT_TIMEOUT_MS = 3_000

/** Long enough after a write for any duplicate event to have been debounced and reported. */
const WATCH_QUIET_MS = WATCH_DEBOUNCE_MS * 6

/** A drawing whose bytes differ from TINY_PNG; the watcher only hashes, so it needn't be a valid PNG. */
const OTHER_DRAWING = Buffer.concat([TINY_PNG, Buffer.from('another bird')])

/** Resolves after `milliseconds`; fs.watch runs in real time, so watcher tests wait for it to go quiet. */
const waitQuietly = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * Records each call it is handed as a callback. `waitForCalls(count)`
 * resolves once that many calls arrived, and rejects after
 * WATCH_EVENT_TIMEOUT_MS otherwise.
 */
const callRecorder = () => {
  const calls = []
  const waiters = new Set()

  /** Resolves waiters whose count is reached. */
  const wake = () => {
    for (const waiter of waiters) {
      if (calls.length >= waiter.count) waiter.resolve()
    }
  }

  return {
    calls,
    record: (...args) => {
      calls.push(args)
      wake()
    },
    waitForCalls: (count) => new Promise((resolve, reject) => {
      const waiter = { count, resolve: () => finish(resolve) }
      const timer = setTimeout(() => finish(() => reject(new Error(`expected ${count} calls, got ${calls.length} within ${WATCH_EVENT_TIMEOUT_MS} ms`))), WATCH_EVENT_TIMEOUT_MS)
      /** Settles once. */
      const finish = (settle) => {
        clearTimeout(timer)
        waiters.delete(waiter)
        settle()
      }
      waiters.add(waiter)
      wake()
    }),
  }
}

/** Watches `workspace` for the rest of the test; resolves recorders for each callback and the watcher. */
const startWatching = (testContext, workspace) => {
  const birdSaves = callRecorder()
  const errors = []
  const watcher = watchWorkspace({
    workspace,
    onBirdSaved: birdSaves.record,
    onError: (error) => errors.push(error),
    debounceMs: WATCH_DEBOUNCE_MS,
  })
  testContext.after(() => watcher.stop())

  return { watcher, birdSaves, errors }
}

test('the watcher reports a bird.png that appears, once', (testContext) => withWorkspace(async ({ workspace }) => {
  const { birdSaves, errors } = startWatching(testContext, workspace)

  await writeFile(path.join(workspace, 'bird.png'), TINY_PNG)

  await birdSaves.waitForCalls(1)
  await waitQuietly(WATCH_QUIET_MS)
  assert.equal(birdSaves.calls.length, 1)
  assert.deepEqual(errors, [])
}))

test('the watcher reports bird.png again when it is redrawn', (testContext) => withWorkspace(async ({ workspace }) => {
  const { birdSaves } = startWatching(testContext, workspace)
  await writeFile(path.join(workspace, 'bird.png'), TINY_PNG)
  await birdSaves.waitForCalls(1)

  await writeFile(path.join(workspace, 'bird.png'), OTHER_DRAWING)

  await birdSaves.waitForCalls(2)
  await waitQuietly(WATCH_QUIET_MS)
  assert.equal(birdSaves.calls.length, 2)
}))

test('the watcher ignores a burst of rewrites with the same drawing', (testContext) => withWorkspace(async ({ workspace }) => {
  const { birdSaves } = startWatching(testContext, workspace)
  await writeFile(path.join(workspace, 'bird.png'), TINY_PNG)
  await birdSaves.waitForCalls(1)

  for (let rewrite = 0; rewrite < 3; rewrite += 1) await writeFile(path.join(workspace, 'bird.png'), TINY_PNG)

  await waitQuietly(WATCH_QUIET_MS)
  assert.equal(birdSaves.calls.length, 1)
}))

test('the watcher reports a save through the page server once, not its temp file', (testContext) => withWorkspace(async ({ workspace }) => {
  const port = await startBirdServer(testContext, workspace)
  const { birdSaves, errors } = startWatching(testContext, workspace)

  const response = await postBird({ port })

  assert.equal(response.status, 204)
  await birdSaves.waitForCalls(1)
  await waitQuietly(WATCH_QUIET_MS)
  assert.equal(birdSaves.calls.length, 1)
  assert.deepEqual(errors, [])
}))

test('the watcher stays quiet about a bird.png already there when it starts', (testContext) => withWorkspace(async ({ workspace }) => {
  await writeFile(path.join(workspace, 'bird.png'), TINY_PNG)

  const { birdSaves } = startWatching(testContext, workspace)

  await waitQuietly(WATCH_QUIET_MS)
  assert.equal(birdSaves.calls.length, 0)
}))

test('the watcher does not report a bird.png symlink', (testContext) => withWorkspace(async ({ directory, workspace }) => {
  const outside = path.join(directory, 'outside.png')
  await writeFile(outside, TINY_PNG)
  const { birdSaves, errors } = startWatching(testContext, workspace)

  await symlink(outside, path.join(workspace, 'bird.png'))

  await waitQuietly(WATCH_QUIET_MS)
  assert.equal(birdSaves.calls.length, 0)
  assert.deepEqual(errors, [])
}))

test('the watcher reports nothing after it stops', (testContext) => withWorkspace(async ({ workspace }) => {
  const { watcher, birdSaves } = startWatching(testContext, workspace)
  watcher.stop()

  await writeFile(path.join(workspace, 'bird.png'), TINY_PNG)

  await waitQuietly(WATCH_QUIET_MS)
  assert.equal(birdSaves.calls.length, 0)
}))

/** A fake of the slice of Pi's ExtensionAPI the extension uses: records handlers and sent messages. */
const fakePi = () => {
  const handlers = {}
  const sent = callRecorder()

  return {
    handlers,
    sent,
    on: (eventName, handler) => {
      handlers[eventName] = handler
    },
    sendMessage: (message, options) => sent.record({ message, options }),
  }
}

/** A fake ExtensionContext for a session whose working directory is `workspace`. */
const fakeContext = (workspace) => ({ cwd: workspace, mode: 'print', hasUI: false, ui: { notify: () => {} } })

test('the extension tells Pi about a saved bird during a session, and stops at shutdown', (testContext) => withWorkspace(async ({ workspace }) => {
  const savedWorkspace = process.env.BOOTHSTRAP_WORKSPACE
  delete process.env.BOOTHSTRAP_WORKSPACE
  testContext.after(() => {
    if (savedWorkspace !== undefined) process.env.BOOTHSTRAP_WORKSPACE = savedWorkspace
  })
  const pi = fakePi()
  birdsbirdbirdsExtension(pi)
  const context = fakeContext(workspace)
  await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, context)
  testContext.after(() => pi.handlers.session_shutdown({ type: 'session_shutdown' }, context))

  await writeFile(path.join(workspace, 'bird.png'), TINY_PNG)
  await pi.sent.waitForCalls(1)
  await pi.handlers.session_shutdown({ type: 'session_shutdown' }, context)
  await writeFile(path.join(workspace, 'bird.png'), OTHER_DRAWING)

  await waitQuietly(DEFAULT_DEBOUNCE_MS * 3)
  assert.deepEqual(pi.sent.calls, [[{
    message: { customType: 'birdsbirdbirds', content: '[birdsbirdbirds] The participant saved their bird as bird.png. Read it, describe it, and report draw-bird.', display: false },
    options: { triggerTurn: true, deliverAs: 'followUp' },
  }]])
}))
