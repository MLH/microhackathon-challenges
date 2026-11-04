// Turns a checked bird.json into the waypoints the sky page draws and flies,
// on the booth gallery's 1000 by 850 sky stage. Lengths convert to stage
// pixels exactly as the gallery converts them (1vw is 10px, 1vh is 8.5px),
// since the gallery plays the same flight on that stage, so the path the
// participant directs is the path the booth screens show.

import { readKeyframes } from './check-bird.mjs'

/** The gallery's sky stage, in pixels. */
export const STAGE_WIDTH = 1000
export const STAGE_HEIGHT = 850

/** The bird's box on the gallery stage, in pixels; a translate percentage is a share of it. */
export const BIRD_BOX_PIXELS = 120

/** Stage pixels per length unit, as the gallery converts them. */
const STAGE_PIXELS_PER_UNIT = { px: 1, vw: STAGE_WIDTH / 100, vh: STAGE_HEIGHT / 100, em: 16, rem: 16 }

/** Degrees per angle unit. */
const DEGREES_PER_UNIT = { deg: 1, turn: 360 }

/** The largest scale the gallery draws a bird at either way. */
const MAX_SCALE = 5

/** How far a waypoint may move or turn before it counts as changed: pixels, degrees, and scale. */
const CHANGE_TOLERANCE = { position: 0.5, rotate: 0.5, scale: 0.005 }

/** The identity 2D matrix, as `[a, b, c, d, e, f]`. */
const IDENTITY = [1, 0, 0, 1, 0, 0]

/**
 * The flight a checked bird.json `entry` describes, numbered `version`:
 * `{ version, bird_name, origin, duration_s, timing_function, waypoints }`.
 * `duration_s` is the flight's own duration in seconds, as bird.json states
 * it; players slow it down as the gallery does. Each waypoint is `{ n, offset, x, y }` plus
 * `rotate` (degrees) and `scale` when its transform sets them, `opacity` when
 * its frame sets it, and `easing` when its frame sets a timing function.
 * `x` and `y` place the bird box's top-left corner, as translate does.
 */
export function flightOf(entry, version) {
  const { css_keyframes: css, animation_name: animationName, duration, timing_function: timingFunction } = entry.animation

  return {
    version,
    bird_name: entry.bird_name,
    origin: entry.origin,
    duration_s: Number.parseFloat(duration),
    timing_function: timingFunction,
    waypoints: waypointsOf(readKeyframes(css, animationName)),
  }
}

/**
 * What's wrong with where a checked bird.json `entry` starts and ends: a bird
 * flies in from off the sky and out again, so its first and last waypoints
 * must hold all of its box, turned and scaled, off the stage. Empty when both
 * do.
 */
export function offScreenErrors(entry) {
  const { waypoints } = flightOf(entry, 0)
  const first = waypoints[0]
  const last = waypoints.at(-1)
  const errors = []
  if (isInSky(first)) {
    errors.push('waypoint 1 puts the bird in the sky; start it fully off screen, such as translate(-20vw, 50vh)')
  }
  if (isInSky(last)) {
    errors.push(`waypoint ${last.n}, the last, puts the bird in the sky; end it fully off screen, such as translate(120vw, 40vh)`)
  }

  return errors
}

/** True when any of the bird box `waypoint` places overlaps the stage. */
function isInSky({ x, y, rotate = 0, scale = 1 }) {
  const radians = (rotate * Math.PI) / 180
  const reach = (BIRD_BOX_PIXELS / 2) * Math.abs(scale) * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)))
  const centreX = x + BIRD_BOX_PIXELS / 2
  const centreY = y + BIRD_BOX_PIXELS / 2

  return centreX + reach > 0 && centreX - reach < STAGE_WIDTH && centreY + reach > 0 && centreY - reach < STAGE_HEIGHT
}

/**
 * The numbers of the waypoints in `current` that no waypoint of `previous`
 * matches in position and transform, whatever its number: inserting a loop
 * renumbers every waypoint after it, but those that didn't move stay
 * unchanged. Empty when there is no previous flight, since nothing has been
 * revised yet.
 */
export function changedWaypoints(current, previous) {
  if (previous === undefined) return []

  return current.waypoints
    .filter((waypoint) => !previous.waypoints.some((before) => isSamePlacement(waypoint, before)))
    .map((waypoint) => waypoint.n)
}

/** True when `waypoint` and `before` place the bird alike, within CHANGE_TOLERANCE. */
function isSamePlacement(waypoint, before) {
  return !(Math.abs(waypoint.x - before.x) > CHANGE_TOLERANCE.position
    || Math.abs(waypoint.y - before.y) > CHANGE_TOLERANCE.position
    || Math.abs((waypoint.rotate ?? 0) - (before.rotate ?? 0)) > CHANGE_TOLERANCE.rotate
    || Math.abs((waypoint.scale ?? 1) - (before.scale ?? 1)) > CHANGE_TOLERANCE.scale)
}

/**
 * The waypoints of parsed keyframes: one per offset that sets a transform, in
 * offset order and numbered from 1. Frames sharing an offset merge, later
 * declarations winning, as CSS merges them. A flight that sets no transform
 * at its start or end gets an untransformed waypoint there, which is where
 * CSS puts the bird.
 */
function waypointsOf(frames) {
  const framesByOffset = new Map()
  for (const { offsets, declarations } of frames) {
    for (const offset of offsets) {
      const merged = framesByOffset.get(offset) ?? {}
      for (const { property, value } of declarations) merged[property] = value
      framesByOffset.set(offset, merged)
    }
  }
  for (const edge of [0, 1]) {
    const frame = framesByOffset.get(edge) ?? {}
    frame.transform ??= []
    framesByOffset.set(edge, frame)
  }

  return [...framesByOffset]
    .filter(([, frame]) => frame.transform !== undefined)
    .sort(([left], [right]) => left - right)
    .map(([offset, frame], index) => waypointOf(index + 1, offset, frame))
}

/** One waypoint, numbered `number`, from the merged frame at `offset`. */
function waypointOf(number, offset, frame) {
  const { x, y, rotate, scale } = placementOf(frame.transform)
  const waypoint = { n: number, offset: rounded(offset, 4), x: rounded(x, 1), y: rounded(y, 1) }
  if (rotate !== undefined) waypoint.rotate = rounded(rotate, 1)
  if (scale !== undefined) waypoint.scale = rounded(scale, 3)
  if (frame.opacity !== undefined) waypoint.opacity = frame.opacity
  if (frame['animation-timing-function'] !== undefined) waypoint.easing = frame['animation-timing-function']

  return waypoint
}

/**
 * Where a transform puts the bird box and how it turns and sizes it. The
 * transform origin is the box's centre, so the box moves by the translation
 * part of the composed matrix whatever turns or scales come first. `rotate`
 * adds up every rotation, so a full turn stays a full turn, and `scale` is
 * the product of the horizontal scales; each is undefined when the transform
 * has no function of its kind.
 */
function placementOf(transformFunctions) {
  let matrix = IDENTITY
  let rotate
  let scale
  for (const { name, arguments: transformArguments } of transformFunctions) {
    matrix = multiply(matrix, matrixOf(name, transformArguments))
    if (name === 'rotate' || name === 'rotateZ') rotate = (rotate ?? 0) + degreesOf(transformArguments[0])
    if (name === 'scale' || name === 'scaleX') scale = (scale ?? 1) * clampedScale(transformArguments[0])
  }

  return { x: matrix[4], y: matrix[5], rotate, scale }
}

/** The 2D matrix of one checked transform function. */
function matrixOf(name, transformArguments) {
  const [first, second] = transformArguments

  switch (name) {
    case 'translate':
    case 'translate3d':
      return [1, 0, 0, 1, pixelsOf(first), second === undefined ? 0 : pixelsOf(second)]
    case 'translateX':
      return [1, 0, 0, 1, pixelsOf(first), 0]
    case 'translateY':
      return [1, 0, 0, 1, 0, pixelsOf(first)]
    case 'rotate':
    case 'rotateZ': {
      const angle = radiansOf(first)
      return [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]
    }
    case 'scale': {
      const scaleX = clampedScale(first)
      return [scaleX, 0, 0, second === undefined ? scaleX : clampedScale(second), 0, 0]
    }
    case 'scaleX':
      return [clampedScale(first), 0, 0, 1, 0, 0]
    case 'scaleY':
      return [1, 0, 0, clampedScale(first), 0, 0]
    case 'skew':
      return [1, Math.tan(radiansOf(second)), Math.tan(radiansOf(first)), 1, 0, 0]
    case 'skewX':
      return [1, 0, Math.tan(radiansOf(first)), 1, 0, 0]
    case 'skewY':
      return [1, Math.tan(radiansOf(first)), 0, 1, 0, 0]
    default:
      throw new Error(`transform ${name}() has no matrix; check the bird with check-bird.mjs first`)
  }
}

/** The product `left × right` of two 2D matrices, each `[a, b, c, d, e, f]`. */
function multiply(left, right) {
  const [a, b, c, d, e, f] = left
  const [a2, b2, c2, d2, e2, f2] = right

  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ]
}

/** A checked length in stage pixels; a percentage is a share of the bird box. */
function pixelsOf({ value, unit }) {
  if (unit === '') return 0
  if (unit === '%') return (value / 100) * BIRD_BOX_PIXELS

  return value * STAGE_PIXELS_PER_UNIT[unit]
}

/** A checked angle in degrees. */
function degreesOf({ value, unit }) {
  return unit === '' ? 0 : value * DEGREES_PER_UNIT[unit]
}

/** A checked angle in radians; a missing optional angle is 0. */
function radiansOf(argument) {
  return argument === undefined ? 0 : (degreesOf(argument) * Math.PI) / 180
}

/** A scale factor held to the gallery's limit either way. */
function clampedScale({ value }) {
  return Math.min(Math.max(value, -MAX_SCALE), MAX_SCALE)
}

/** `value` rounded to `decimals` places, with -0 as 0. */
function rounded(value, decimals) {
  const result = Number(value.toFixed(decimals))

  return result === 0 ? 0 : result
}
