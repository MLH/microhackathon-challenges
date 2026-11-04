// Turns flights into what the sky draws and plays: the path through a
// flight's waypoints, and Web Animations keyframes for a bird. A CSS
// animation's timing function applies to each keyframe interval, not to the
// whole flight, so every keyframe carries its easing and the effect itself
// stays linear, which plays a flight exactly as the gallery's CSS does.

/** The bird's box on the gallery stage, in pixels; the path runs through its centre. */
export const BIRD_BOX_PIXELS = 120

/** How much slower than its stated duration a bird flies, as the gallery plays it. */
export const FLIGHT_SLOWDOWN = 3

/** How many seconds apart flock birds start, as the gallery staggers them. */
export const FLOCK_STAGGER_SECONDS = 2.3

const BIRD_BOX_CENTRE = BIRD_BOX_PIXELS / 2

/** The point each waypoint puts the bird's centre at, `{ n, x, y }`, in stage pixels. */
export function pathPoints(waypoints) {
  return waypoints.map((waypoint) => ({ n: waypoint.n, x: waypoint.x + BIRD_BOX_CENTRE, y: waypoint.y + BIRD_BOX_CENTRE }))
}

/** SVG path data for straight segments through `points`. */
export function pathData(points) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
}

/**
 * How far along the path each point sits, as a share of its whole length
 * from 0 to 1. A path with no length puts every point at 0.
 */
export function distanceShares(points) {
  const distances = [0]
  for (let index = 1; index < points.length; index += 1) {
    const step = Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y)
    distances.push(distances[index - 1] + step)
  }
  const total = distances.at(-1)

  return distances.map((distance) => (total === 0 ? 0 : distance / total))
}

/**
 * The segments to highlight after a revision, each `{ from, to }` as indexes
 * into the waypoints: every segment with a changed waypoint at either end.
 */
export function changedSegments(waypoints, changed) {
  const changedNumbers = new Set(changed)
  const segments = []
  for (let index = 1; index < waypoints.length; index += 1) {
    if (changedNumbers.has(waypoints[index - 1].n) || changedNumbers.has(waypoints[index].n)) segments.push({ from: index - 1, to: index })
  }

  return segments
}

/** Web Animations keyframes that fly a bird through a flight's waypoints. */
export function flightKeyframes({ waypoints, timing_function: timingFunction }) {
  return waypoints.map((waypoint) => withOptional({
    offset: waypoint.offset,
    transform: `translate(${waypoint.x}px, ${waypoint.y}px) rotate(${waypoint.rotate ?? 0}deg) scale(${waypoint.scale ?? 1})`,
    easing: waypoint.easing ?? timingFunction,
  }, 'opacity', waypoint.opacity))
}

/** Web Animations keyframes that fly a flock bird from the gallery feed. */
export function flockKeyframes({ keyframes, timing_function: timingFunction }) {
  return keyframes.map((keyframe) => withOptional({
    offset: keyframe.offset,
    transform: keyframe.transform,
    easing: keyframe.easing ?? timingFunction,
  }, 'opacity', keyframe.opacity))
}

/** How long one flight of a bird whose stated duration is `durationSeconds` plays, in milliseconds, slowed as the gallery slows it. */
export function playbackMilliseconds(durationSeconds) {
  return durationSeconds * FLIGHT_SLOWDOWN * 1000
}

/**
 * How many seconds into its slowed flight the flock bird at `position`
 * starts, given its stated `durationSeconds`, so birds sharing the sky don't
 * fly as one, as the gallery staggers them.
 */
export function flockStartSeconds(position, durationSeconds) {
  return (position * FLOCK_STAGGER_SECONDS) % (durationSeconds * FLIGHT_SLOWDOWN)
}

/** `keyframe` with `key` set to `value`, unless `value` is undefined. */
function withOptional(keyframe, key, value) {
  return value === undefined ? keyframe : { ...keyframe, [key]: value }
}
