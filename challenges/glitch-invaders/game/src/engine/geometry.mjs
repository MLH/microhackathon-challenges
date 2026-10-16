/** Axis-aligned rectangles and the overlap test the engine uses for every hit. */

/** Whether two boxes share any area. Boxes that only touch do not overlap. */
export function overlaps(first, second) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

/** Keep `value` within `[min, max]`. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
