// The display-only sky: the gallery's 1000 by 850 stage, scaled to fit the
// window, so the bird and the flock fly as they will on the booth screens.
// Each new flight draws its path on as a dotted line, pops in its numbered
// waypoints, then flies the bird along it. A revision keeps the previous
// path as a faint ghost and highlights what changed. Nothing here takes
// input: the participant directs the flight by talking to Pi.

import { createBirdLabel } from './bird-label.mjs'
import { trimmedImageUrl } from './trimmed-image.mjs'
import { changedSegments, distanceShares, flightKeyframes, flockKeyframes, flockStartSeconds, pathData, pathPoints, playbackMilliseconds } from './flight-motion.mjs'

const STAGE_WIDTH = 1000
const STAGE_HEIGHT = 850

/** How long the path takes to draw on, how long a waypoint takes to pop in, and the pause before take-off. */
const DRAW_MS = 2600
const POP_MS = 450
const TAKE_OFF_PAUSE_MS = 500

/** The mask path's normalised length, matching its pathLength attribute in index.html. */
const MASK_PATH_LENGTH = 1000

/** How far, in stage pixels, a waypoint may sit from an old one and still count as the same spot. */
const MOVED_TOLERANCE_PIXELS = 0.5

/** How long a waypoint stays lit, as a share of a flight, after the bird passes it. */
const PASS_GLOW_SHARE = 0.05

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

const elements = {
  frame: document.getElementById('stage-frame'),
  stage: document.getElementById('stage'),
  flock: document.getElementById('flock'),
  ghostPath: document.getElementById('ghost-path'),
  changedSegments: document.getElementById('changed-segments'),
  maskPath: document.getElementById('draw-mask-path'),
  pathShadow: document.getElementById('path-shadow'),
  pathDots: document.getElementById('path-dots'),
  waypoints: document.getElementById('waypoints'),
  perch: document.getElementById('perch'),
  perchBird: document.getElementById('perch-bird'),
  flight: document.getElementById('my-flight'),
  bird: document.getElementById('my-bird'),
  statusText: document.getElementById('status-text'),
  nameChip: document.getElementById('name-chip'),
  chipBird: document.getElementById('chip-bird'),
  flockNote: document.getElementById('flock-note'),
}

/** Timers of the flight being shown, cleared when the next one arrives. */
let pendingTimers = []

/** Scales the stage to the largest size that fits the window, keeping its shape. */
export function fitStage() {
  const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT)
  elements.frame.style.width = `${STAGE_WIDTH * scale}px`
  elements.frame.style.height = `${STAGE_HEIGHT * scale}px`
  elements.stage.style.transform = `scale(${scale})`
}

/** Shows the participant's drawing from `imageUrl`, cropped to its ink, wherever the bird appears. */
export async function setBirdImage(imageUrl) {
  const shownUrl = await trimmedImageUrl(imageUrl)
  for (const image of [elements.bird, elements.perchBird, elements.chipBird]) image.src = shownUrl
}

/**
 * Shows the flights /flight.json sent: the perched bird while there is no
 * flight yet, else `current` drawn on and flown, with `previous` as a ghost.
 */
export function showFlights({ current, previous, changed }) {
  clearFlight()
  elements.perch.hidden = current !== null
  if (current === null) return

  showName(current)
  elements.statusText.textContent = statusOf(current, changed)
  const drawMs = prefersReducedMotion() ? 0 : DRAW_MS
  const points = pathPoints(current.waypoints)
  const shares = distanceShares(points)

  drawGhost(previous)
  drawPath(points, drawMs)
  highlightChanges({ current, changed, points, shares, drawMs })
  const markers = popInWaypoints({ current, changed, points, shares, drawMs })
  markMovedWaypoints({ current, previous })
  later(() => takeOff(current, markers), drawMs + TAKE_OFF_PAUSE_MS)
}

/**
 * Flies the gallery's other birds, dimmed, behind the participant's: `feed`
 * is /flock.json's `{ source, items }`, `live` for the booth screens' flock
 * and `demo` for the bundled practice flock.
 */
export function showFlock(feed) {
  const birds = feed.items.map((item, position) => {
    const box = document.createElement('div')
    box.className = 'flight flock-bird'
    const image = document.createElement('img')
    image.className = 'bird'
    image.alt = ''
    trimmedImageUrl(item.image_url).then((shownUrl) => {
      image.src = shownUrl
    })
    box.appendChild(image)
    box.animate(flockKeyframes(item), {
      duration: playbackMilliseconds(item.duration_s),
      iterations: Infinity,
      delay: -flockStartSeconds(position, item.duration_s) * 1000,
    })

    return box
  })
  elements.flock.replaceChildren(...birds)
  elements.flockNote.hidden = birds.length === 0
  elements.flockNote.textContent = feed.source === 'live' ? 'Faint birds: the flock on the booth screens' : 'Faint birds: a practice flock'
}

/** Stops the flight being shown and removes everything it drew. */
function clearFlight() {
  for (const timer of pendingTimers) clearTimeout(timer)
  pendingTimers = []
  for (const element of [elements.maskPath, elements.flight]) {
    for (const animation of element.getAnimations()) animation.cancel()
  }
  elements.flight.hidden = true
  elements.waypoints.replaceChildren()
  elements.changedSegments.replaceChildren()
  for (const path of [elements.ghostPath, elements.maskPath, elements.pathShadow, elements.pathDots]) path.setAttribute('d', '')
}

/** Runs `callback` after `delayMs`, unless the next flight arrives first. */
function later(callback, delayMs) {
  pendingTimers.push(setTimeout(callback, delayMs))
}

/** Puts the bird's name and origin in the chip, as text only. */
function showName({ bird_name: birdName, origin }) {
  elements.nameChip.replaceChildren(elements.chipBird, createBirdLabel(document, { birdName, origin }))
  elements.nameChip.hidden = false
}

/** The status line for `current`: its number, and how many waypoints the last change moved. */
function statusOf(current, changed) {
  if (current.version === 1) return '· flight 1, Pi’s first sketch'
  if (changed.length === 0) return `· flight ${current.version}`

  return `· flight ${current.version}, ${changed.length} ${changed.length === 1 ? 'waypoint' : 'waypoints'} changed`
}

/** True when the participant's system asks for less motion. */
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Draws the previous flight's path faintly, or nothing on a first flight. */
function drawGhost(previous) {
  elements.ghostPath.setAttribute('d', previous === null ? '' : pathData(pathPoints(previous.waypoints)))
}

/** Draws the path through `points` on, from the first waypoint to the last, over `drawMs`. */
function drawPath(points, drawMs) {
  const data = pathData(points)
  for (const path of [elements.maskPath, elements.pathShadow, elements.pathDots]) path.setAttribute('d', data)
  elements.maskPath.animate(
    [{ strokeDashoffset: MASK_PATH_LENGTH }, { strokeDashoffset: 0 }],
    { duration: drawMs, fill: 'both' },
  )
}

/** Highlights each segment with a changed waypoint, fading in as the path reaches it. */
function highlightChanges({ current, changed, points, shares, drawMs }) {
  const segments = changedSegments(current.waypoints, changed).map(({ from, to }) => {
    const segment = document.createElementNS(SVG_NAMESPACE, 'path')
    segment.setAttribute('class', 'changed-segment')
    segment.setAttribute('d', pathData([points[from], points[to]]))
    segment.animate([{ opacity: 0 }, { opacity: 1 }], { duration: POP_MS, delay: shares[from] * drawMs, fill: 'both' })

    return segment
  })
  elements.changedSegments.replaceChildren(...segments)
}

/** Adds a numbered marker per waypoint, each popping in as the path reaches it. Returns the markers. */
function popInWaypoints({ current, changed, points, shares, drawMs }) {
  const markers = current.waypoints.map((waypoint, index) => {
    const marker = waypointMarker(waypoint.n, points[index])
    if (changed.includes(waypoint.n)) marker.classList.add('changed')
    marker.animate(
      [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.3)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 1 }],
      { duration: POP_MS, delay: shares[index] * drawMs, fill: 'backwards', easing: 'ease-out' },
    )

    return marker
  })
  elements.waypoints.append(...markers)

  return markers
}

/**
 * Leaves a dashed marker, with its old number, wherever the previous flight
 * had a waypoint that no current waypoint sits on: the spots the revision
 * moved or removed.
 */
function markMovedWaypoints({ current, previous }) {
  if (previous === null) return

  const currentPoints = pathPoints(current.waypoints)
  const oldMarkers = pathPoints(previous.waypoints)
    .filter((point) => !currentPoints.some((now) => Math.hypot(now.x - point.x, now.y - point.y) <= MOVED_TOLERANCE_PIXELS))
    .map((point) => {
      const marker = waypointMarker(point.n, point)
      marker.classList.add('old')

      return marker
    })
  elements.waypoints.prepend(...oldMarkers)
}

/** A numbered waypoint marker centred on `point`. */
function waypointMarker(number, point) {
  const marker = document.createElement('div')
  marker.className = 'waypoint'
  marker.textContent = String(number)
  marker.style.left = `${point.x}px`
  marker.style.top = `${point.y}px`

  return marker
}

/** Starts the bird's endless flight, lighting each waypoint marker as the bird passes it. */
function takeOff(current, markers) {
  const timing = { duration: playbackMilliseconds(current.duration_s), iterations: Infinity }
  elements.flight.hidden = false
  elements.flight.animate(flightKeyframes(current), timing)
  current.waypoints.forEach((waypoint, index) => {
    const marker = markers[index]
    marker.animate(passKeyframes(waypoint.offset, getComputedStyle(marker).backgroundColor), timing)
  })
}

/**
 * Keyframes over one flight that light a waypoint marker when the bird
 * reaches `offset`. Every keyframe sets the colour, `restingColour` outside
 * the glow, so it never drifts between them.
 */
function passKeyframes(offset, restingColour) {
  const lit = { transform: 'scale(1.3)', backgroundColor: '#f8b92a' }
  const resting = { transform: 'scale(1)', backgroundColor: restingColour }
  const glowEnd = Math.min(1, offset + PASS_GLOW_SHARE)

  return [
    { ...resting, offset: 0 },
    { ...resting, offset },
    { ...lit, offset: Math.min(1, offset + PASS_GLOW_SHARE / 3) },
    { ...resting, offset: glowEnd },
    { ...resting, offset: 1 },
  ]
}
