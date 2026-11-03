// Seeds a BirdsBirdBirds workspace for previewing the sky page by hand: a
// sample bird.png and two successive flights recorded in .flights/, so the
// page opens on a revision with a ghost path and highlighted changes.
//
// Usage: node tools/seed-birds-workspace.mjs <workspace>
// Then serve it with the command this prints.

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

import { recordFlight } from '../challenges/birdsbirdbirds/flight-history.mjs'

const PACKAGE_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'challenges', 'birdsbirdbirds')
const PREVIEW_PORT = 4399
const BIRD_WIDTH = 160
const BIRD_HEIGHT = 130

/** The two flights, in order: the second loops at waypoint 4 and droops at the end. */
const FLIGHTS = [
  '0% { transform: translate(4vw, 70vh) rotate(-10deg); } 20% { transform: translate(24vw, 38vh) rotate(-20deg); } 40% { transform: translate(32vw, 18vh) rotate(-30deg); } 55% { transform: translate(48vw, 30vh) rotate(10deg); } 75% { transform: translate(66vw, 12vh) rotate(-5deg); } 100% { transform: translate(84vw, 8vh) rotate(0deg); }',
  '0% { transform: translate(4vw, 70vh) rotate(-10deg); } 20% { transform: translate(24vw, 38vh) rotate(-20deg); } 40% { transform: translate(32vw, 18vh) rotate(-30deg); } 55% { transform: translate(48vw, 30vh) rotate(10deg); } 75% { transform: translate(66vw, 40vh) rotate(15deg); } 100% { transform: translate(84vw, 50vh) rotate(20deg); }',
]

/** A bird.json for `keyframes`, as Pi would write it. */
function birdEntry(keyframes, duration) {
  return {
    bird_name: 'Sir Flaps-a-Lot',
    origin: 'Toronto',
    animation: { css_keyframes: `@keyframes fly_flaps { ${keyframes} }`, animation_name: 'fly_flaps', duration, timing_function: 'ease-in-out' },
  }
}

/** One PNG chunk: length, type, data, and the CRC over type and data. */
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typeAndData))

  return Buffer.concat([length, typeAndData, checksum])
}

/** The RGBA colour of a cartoon red bird facing right at pixel (x, y), transparent off the bird. */
function birdPixel(x, y) {
  const inEllipse = (centreX, centreY, radiusX, radiusY) => ((x - centreX) / radiusX) ** 2 + ((y - centreY) / radiusY) ** 2 < 1
  if (inEllipse(130, 46, 4, 4)) return [30, 30, 30, 255]
  if (x > 142 && x < 158 && Math.abs(y - 50) < (158 - x) / 3) return [242, 179, 61, 255]
  if (inEllipse(70, 55, 30, 16)) return [224, 76, 63, 255]
  if (inEllipse(80, 70, 55, 38) || inEllipse(125, 50, 22, 22)) return [255, 107, 91, 255]

  return [0, 0, 0, 0]
}

/** A sample drawing as a transparent PNG. */
function samplePng() {
  const rows = []
  for (let y = 0; y < BIRD_HEIGHT; y += 1) {
    const row = [0]
    for (let x = 0; x < BIRD_WIDTH; x += 1) row.push(...birdPixel(x, y))
    rows.push(Buffer.from(row))
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(BIRD_WIDTH, 0)
  header.writeUInt32BE(BIRD_HEIGHT, 4)
  header.writeUInt8(8, 8)
  header.writeUInt8(6, 9)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  return Buffer.concat([signature, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))])
}

/** Seeds `workspace` and prints how to serve it. */
function main([workspaceArgument]) {
  if (workspaceArgument === undefined) {
    console.error('usage: node tools/seed-birds-workspace.mjs <workspace>')
    return 1
  }

  const workspace = path.resolve(workspaceArgument)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(path.join(workspace, 'bird.png'), samplePng())
  for (const [index, keyframes] of FLIGHTS.entries()) {
    writeFileSync(path.join(workspace, 'bird.json'), `${JSON.stringify(birdEntry(keyframes, index === 0 ? '6s' : '8s'), null, 2)}\n`)
    recordFlight(workspace)
  }

  console.log(`seeded ${workspace} with bird.png and two flights; preview it with:`)
  console.log(`BIRDSBIRDBIRDS_WORKSPACE=${workspace} BIRDSBIRDBIRDS_TOKEN=dev BIRDSBIRDBIRDS_PORT=${PREVIEW_PORT} node ${path.relative(process.cwd(), path.join(PACKAGE_DIRECTORY, 'server.mjs'))}`)
  console.log(`then open http://127.0.0.1:${PREVIEW_PORT}/`)

  return 0
}

process.exitCode = main(process.argv.slice(2))
