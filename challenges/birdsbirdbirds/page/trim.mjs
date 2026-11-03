// Finds the part of a drawing that holds ink, so a bird drawn small on the
// 512px canvas still fills its box in the sky. Pure: it reads RGBA pixel data
// and returns rectangles, so it runs the same in the page and in tests.

/** How much empty margin to keep around the ink, as a share of its longer side. */
export const TRIM_PADDING_SHARE = 0.06

/** The faintest alpha that counts as ink, so stray anti-aliasing noise doesn't widen the crop. */
const INK_ALPHA = 16

/**
 * The rectangle `{ x, y, width, height }` to crop an image to: the bounding
 * box of its inked pixels, padded by `paddingShare` of the box's longer side
 * on every edge and held inside the image. `rgba` is `width` × `height`
 * pixels, four bytes each. Undefined when no pixel has ink.
 */
export function cropOf(rgba, width, height, paddingShare = TRIM_PADDING_SHARE) {
  const ink = inkBounds(rgba, width, height)
  if (ink === undefined) return undefined

  const padding = Math.round(Math.max(ink.right - ink.left, ink.bottom - ink.top) * paddingShare)
  const left = Math.max(0, ink.left - padding)
  const top = Math.max(0, ink.top - padding)
  const right = Math.min(width, ink.right + padding)
  const bottom = Math.min(height, ink.bottom + padding)

  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The inked pixels' bounding box, `{ left, top, right, bottom }` with right and bottom exclusive, or undefined. */
function inkBounds(rgba, width, height) {
  let left = width
  let top = height
  let right = 0
  let bottom = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] < INK_ALPHA) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x + 1)
      bottom = Math.max(bottom, y + 1)
    }
  }

  return right === 0 ? undefined : { left, top, right, bottom }
}
