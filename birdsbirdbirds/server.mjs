// Serves the drawing page and the sky on 127.0.0.1. The page saves the
// participant's drawing as <workspace>/bird.png and polls bird.json, which is
// served only once check-bird.mjs passes it, so nothing unchecked reaches the
// page's keyframes stylesheet.
//
// Run as `node server.mjs` with BIRDSBIRDBIRDS_WORKSPACE (absolute),
// BIRDSBIRDBIRDS_TOKEN, and optionally BIRDSBIRDBIRDS_PORT (default 4322).
// Exits with code 3 when the port is busy.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isRunDirectly, loadBirdFile } from './check-bird.mjs'
import { readWorkspaceFile, RefusedFileError } from './workspace-file.mjs'

export const DEFAULT_PORT = 4322
export const MAX_PNG_BYTES = 2 * 1024 * 1024
export const PORT_BUSY_EXIT_CODE = 3

const LISTEN_HOST = '127.0.0.1'
const PAGE_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IHDR_CHUNK_TYPE = Buffer.from('IHDR', 'ascii')
// IEND has no data, so the chunk (length, type, CRC) is always these 12 bytes.
const IEND_CHUNK = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

/** The page files the server hands out, keyed by request path; nothing else under page/ is reachable. */
const STATIC_FILES = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/app.mjs': { file: 'app.mjs', contentType: 'text/javascript; charset=utf-8' },
  '/bird-label.mjs': { file: 'bird-label.mjs', contentType: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', contentType: 'text/css; charset=utf-8' },
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; connect-src 'self'; script-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
}

/** Hex SHA-256 of `text`; /health reports the token's hash so setup can recognise its own server. */
export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Creates the page server for `workspace` (absolute). `token` authorises
 * POST /shutdown. The server is not listening yet; the Host and Origin checks
 * use whatever port it is later bound to, so tests can listen on port 0.
 */
export function createBirdServer({ workspace, token }) {
  if (!path.isAbsolute(workspace)) throw new Error(`workspace must be an absolute path, got ${JSON.stringify(workspace)}`)
  if (typeof token !== 'string' || token === '') throw new Error('token must be a non-empty string')

  const server = http.createServer((request, response) => {
    handleRequest({ server, workspace, token, request, response }).catch((error) => {
      console.error(`birdsbirdbirds server: ${request.method} ${request.url} failed: ${error.message}`)
      if (response.headersSent) return response.destroy()
      sendText(response, 500, 'internal error')
    })
  })

  return server
}

/** Routes one request after the Host check; paths match exactly, with no normalisation. */
async function handleRequest({ server, workspace, token, request, response }) {
  const port = server.address().port
  if (!isOwnHost(request.headers.host, port)) return sendText(response, 421, `wrong host; open http://${LISTEN_HOST}:${port}/`)

  const [requestPath] = request.url.split('?')
  const route = `${request.method} ${requestPath}`

  if (request.method === 'GET' && Object.hasOwn(STATIC_FILES, requestPath)) return sendStaticFile(response, STATIC_FILES[requestPath])
  if (route === 'GET /health') return sendJson(response, 200, { instance: sha256Hex(token) })
  if (route === 'GET /bird.png') return sendSavedBird(response, workspace)
  if (route === 'POST /bird.png') return saveBird({ request, response, workspace, port })
  if (route === 'GET /bird.json') return sendBirdEntry(response, workspace)
  if (route === 'POST /shutdown') return shutDown({ server, token, request, response })

  sendText(response, 404, 'not found')
}

/** True when the Host header names this server by loopback address or localhost, which blocks DNS rebinding. */
function isOwnHost(hostHeader, port) {
  return hostHeader === `${LISTEN_HOST}:${port}` || hostHeader === `localhost:${port}`
}

/** True when the Origin header is absent or one of this server's own origins. */
function isOwnOriginOrNone(originHeader, port) {
  if (originHeader === undefined) return true

  return originHeader === `http://${LISTEN_HOST}:${port}` || originHeader === `http://localhost:${port}`
}

/** Sends one file from page/. */
async function sendStaticFile(response, { file, contentType }) {
  const body = await readFile(path.join(PAGE_DIRECTORY, file))

  send(response, 200, contentType, body)
}

/**
 * Sends <workspace>/bird.png: 404 when it isn't saved yet, 422 when it is a
 * symlink, pipe, or anything but a regular file of at most MAX_PNG_BYTES.
 */
function sendSavedBird(response, workspace) {
  let body
  try {
    body = readWorkspaceFile(path.join(workspace, 'bird.png'), MAX_PNG_BYTES)
  } catch (error) {
    if (error.code === 'ENOENT') return sendText(response, 404, 'no bird.png yet')
    if (error instanceof RefusedFileError) return sendText(response, 422, `${error.message}; press Save on the drawing page again`)
    throw error
  }

  send(response, 200, 'image/png', body)
}

/**
 * Serves <workspace>/bird.json only when check-bird.mjs passes it: 404 when
 * missing, 422 with the checker's errors (and never the entry) otherwise.
 */
async function sendBirdEntry(response, workspace) {
  const birdFile = path.join(workspace, 'bird.json')
  try {
    await lstat(birdFile)
  } catch (error) {
    if (error.code === 'ENOENT') return sendText(response, 404, 'no bird.json yet')
    throw error
  }

  const { entry, errors } = loadBirdFile(birdFile)
  if (errors.length > 0) return sendJson(response, 422, { errors })

  sendJson(response, 200, entry)
}

/**
 * Saves a PNG request body as <workspace>/bird.png through a temp file and a
 * rename, so the page never sees half a file. Answers 204, or 403/413/415
 * without writing anything.
 */
async function saveBird({ request, response, workspace, port }) {
  if (request.headers['content-type'] !== 'image/png') return sendText(response, 415, 'Content-Type must be image/png')
  if (!isOwnOriginOrNone(request.headers.origin, port)) return sendText(response, 403, 'cross-origin saves are not allowed')
  if (Number(request.headers['content-length']) > MAX_PNG_BYTES) return refuseOversizedBody(request, response)

  const body = await readBodyWithin(request, MAX_PNG_BYTES)
  if (body === undefined) return refuseOversizedBody(request, response)
  if (!isPngWithHeader(body)) return sendText(response, 415, 'body must be a PNG image')

  await writeFileAtomically(path.join(workspace, 'bird.png'), body)
  send(response, 204)
}

/** Answers 413 and drops the connection once the answer is out, so the rest of the body is never read. */
function refuseOversizedBody(request, response) {
  response.setHeader('Connection', 'close')
  response.on('finish', () => request.destroy())
  sendText(response, 413, `the image is over ${MAX_PNG_BYTES} bytes`)
}

/** Reads the request body, or resolves undefined and stops reading as soon as it passes `maxBytes`. */
function readBodyWithin(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0

    /** Collects a chunk, giving up once the body is too big. */
    const onData = (chunk) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        request.off('data', onData)
        request.off('end', onEnd)
        request.pause()
        return resolve(undefined)
      }
      chunks.push(chunk)
    }

    /** Resolves with the whole body. */
    const onEnd = () => resolve(Buffer.concat(chunks))

    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', reject)
  })
}

/** True when `body` is a whole PNG: signature and IHDR first, and the empty IEND chunk last. */
export function isCompletePng(body) {
  return isPngWithHeader(body) && body.subarray(-IEND_CHUNK.length).equals(IEND_CHUNK)
}

/** True when `body` starts with the PNG signature followed by an IHDR chunk. */
function isPngWithHeader(body) {
  const ihdrTypeOffset = PNG_SIGNATURE.length + 4

  return body.length >= ihdrTypeOffset + IHDR_CHUNK_TYPE.length
    && body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    && body.subarray(ihdrTypeOffset, ihdrTypeOffset + IHDR_CHUNK_TYPE.length).equals(IHDR_CHUNK_TYPE)
}

/** Writes `body` to a fresh temp file beside `destination`, then renames it over; removes the temp file on failure. */
async function writeFileAtomically(destination, body) {
  const temporaryFile = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporaryFile, body, { flag: 'wx' })
    await rename(temporaryFile, destination)
  } catch (error) {
    await rm(temporaryFile, { force: true })
    throw error
  }
}

/** Answers 204 and closes the server when the X-Bird-Token header matches; 403 otherwise. */
function shutDown({ server, token, request, response }) {
  if (!tokensMatch(request.headers['x-bird-token'], token)) return sendText(response, 403, 'wrong or missing X-Bird-Token')

  response.on('finish', () => {
    server.close()
    server.closeAllConnections()
  })
  send(response, 204)
}

/** Compares a presented token with the real one in constant time. */
function tokensMatch(presented, token) {
  if (typeof presented !== 'string') return false

  return timingSafeEqual(createHash('sha256').update(presented).digest(), createHash('sha256').update(token).digest())
}

/** Sends a response with the security headers on every answer. */
function send(response, status, contentType, body) {
  response.writeHead(status, contentType === undefined ? SECURITY_HEADERS : { ...SECURITY_HEADERS, 'Content-Type': contentType })
  response.end(body)
}

/** Sends a plain-text response. */
function sendText(response, status, text) {
  send(response, status, 'text/plain; charset=utf-8', `${text}\n`)
}

/** Sends a JSON response. */
function sendJson(response, status, value) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

/**
 * Reads BIRDSBIRDBIRDS_PORT from `environment`, defaulting to DEFAULT_PORT.
 * Throws an Error with a message fit to show as is when it isn't a port number.
 */
export function portFromEnvironment(environment) {
  const portText = environment.BIRDSBIRDBIRDS_PORT ?? String(DEFAULT_PORT)
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new Error(`BIRDSBIRDBIRDS_PORT must be a port number from 1 to 65535, got ${JSON.stringify(portText)}`)
  }

  return port
}

/** Reads the server settings from the environment, failing with a clear message when one is missing or malformed. */
function readSettings(environment) {
  const workspace = environment.BIRDSBIRDBIRDS_WORKSPACE
  const token = environment.BIRDSBIRDBIRDS_TOKEN

  if (workspace === undefined || !path.isAbsolute(workspace)) throw new Error('BIRDSBIRDBIRDS_WORKSPACE must be set to an absolute path')
  if (token === undefined || token === '') throw new Error('BIRDSBIRDBIRDS_TOKEN must be set')

  return { workspace, token, port: portFromEnvironment(environment) }
}

/** Starts the server from the environment; exits 3 when the port is busy and 1 on any other startup failure. */
export function main(environment) {
  let settings
  try {
    settings = readSettings(environment)
  } catch (error) {
    console.error(`birdsbirdbirds server: ${error.message}`)
    process.exitCode = 1
    return
  }

  const { workspace, token, port } = settings
  const server = createBirdServer({ workspace, token })
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`birdsbirdbirds server: port ${port} is busy; stop whatever is using it`)
      process.exit(PORT_BUSY_EXIT_CODE)
    }
    console.error(`birdsbirdbirds server: cannot listen on ${LISTEN_HOST}:${port} (${error.code ?? error.message})`)
    process.exit(1)
  })
  server.listen(port, LISTEN_HOST, () => console.log(`birdsbirdbirds server: serving ${workspace} at http://${LISTEN_HOST}:${port}/`))
}

if (isRunDirectly(import.meta.url)) main(process.env)
