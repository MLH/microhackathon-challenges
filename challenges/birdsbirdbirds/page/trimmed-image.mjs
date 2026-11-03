// Crops bird drawings to their ink as the sky shows them, so birds published
// before saves were trimmed still fill their box. Every image is
// same-origin, so the canvas can read its pixels. The cropped copy is a
// data: URL, which the page's CSP allows, and each source is cropped once.

import { cropOf } from './trim.mjs'

/** Each source URL's cropped copy, as a promise of a URL to show. */
const croppedUrls = new Map()

/**
 * A URL showing `url`'s image cropped to its ink. PNGs only: the practice
 * flock's SVGs already fill their box and animate their wings, which a
 * canvas copy would freeze. Falls back to `url` when the image can't be
 * read or has no ink.
 */
export function trimmedImageUrl(url) {
  if (!new URL(url, window.location.href).pathname.endsWith('.png')) return Promise.resolve(url)
  if (!croppedUrls.has(url)) croppedUrls.set(url, cropImage(url).catch(() => url))

  return croppedUrls.get(url)
}

/** Loads `url` and resolves a data: URL of its inked part, or `url` itself when it has no ink. */
async function cropImage(url) {
  const image = new Image()
  image.src = url
  await image.decode()

  const source = canvasOf(image.naturalWidth, image.naturalHeight)
  source.context.drawImage(image, 0, 0)
  const crop = cropOf(source.context.getImageData(0, 0, source.canvas.width, source.canvas.height).data, source.canvas.width, source.canvas.height)
  if (crop === undefined) return url

  const cropped = canvasOf(crop.width, crop.height)
  cropped.context.drawImage(source.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)

  return cropped.canvas.toDataURL('image/png')
}

/** A fresh canvas of the given size and its 2D context. */
function canvasOf(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) }
}
