// Brings the booth screens' flock to the sky page, so the participant's bird
// flies among the birds already published. The booth API serves its feed and
// images same-origin only, so the page server fetches them and serves them
// from its own origin, keeping copies in TMPDIR. Without a gallery URL, or
// when the feed can't be fetched or fails its checks, the page gets the
// bundled practice flock in flock/ instead.
//
// The feed is `<gallery url>/birds.json`:
// `{ "items": [{ id, bird_name, origin, display_name, stored_at, image_url,
// keyframes: [{ offset, transform, opacity?, easing? }], duration_s,
// timing_function }] }`, with `image_url` a path on the gallery's origin,
// every transform in stage pixels, and `duration_s` the bird's own stated
// duration, which the page slows down as the gallery does. Each transform and timing function is
// read with check-bird.mjs's grammar and written out again, so nothing else
// reaches the page.

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readTimingFunction, readTransform } from './check-bird.mjs'
import { readWorkspaceFile } from './workspace-file.mjs'

export const FLOCK_FEED_FILE = 'birds.json'

/** How long a fetched feed is reused before the gallery is asked again. */
export const FEED_FRESH_MS = 30_000

const FETCH_TIMEOUT_MS = 3000
const MAX_FEED_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_FLOCK_BIRDS = 40
const MAX_KEYFRAMES = 40
const MAX_TRANSFORM_LENGTH = 400
const MAX_ID_LENGTH = 100
const MAX_LABEL_LENGTH = { bird_name: 40, origin: 60, display_name: 40 }
const MIN_DURATION_SECONDS = 2
const MAX_DURATION_SECONDS = 60

const DEMO_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flock')
const DEMO_FEED_FILE = path.join(DEMO_DIRECTORY, 'flock.json')
const DEMO_IMAGE_PATTERN = /^demo\/([a-z0-9-]{1,40}\.svg)$/
const IMAGE_KEY_PATTERN = /^[0-9a-f]{32}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Reads the gallery URL from BOOTHSTRAP_GALLERY_URL, else from the event's
 * BIRDSBIRDBIRDS_GALLERY_URL. Returns undefined when neither is set, and
 * throws an Error fit to show as is when the one set isn't an http(s) URL.
 */
export function galleryUrlFromEnvironment(environment) {
  const text = environment.BOOTHSTRAP_GALLERY_URL || environment.BIRDSBIRDBIRDS_GALLERY_URL
  if (!text) return undefined

  const url = URL.parse(text)
  if (url === null || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`the gallery URL must be an http or https URL, got ${JSON.stringify(text)}`)
  }

  return url.href
}

/**
 * The flock for the page, from `galleryUrl` (or none) with copies kept in
 * `cacheDirectory`. Returns `{ feed, liveImage, demoImage }`:
 *
 * - `feed()` resolves `{ source: 'live' | 'demo', items }`, each item with an
 *   `image_url` on the page server's own origin.
 * - `liveImage(key)` resolves a gallery bird's PNG bytes, or undefined when
 *   `key` names no bird in the feed or its image can't be fetched.
 * - `demoImage(fileName)` returns a practice bird's SVG bytes, or undefined.
 */
export function createFlock({ galleryUrl, cacheDirectory }) {
  const feedCacheFile = path.join(cacheDirectory, 'feed.json')
  const imageDirectory = path.join(cacheDirectory, 'images')
  const demoFeed = readDemoFeed()
  const demoFileNames = new Set(demoFeed.items.map((item) => path.posix.basename(item.image_url)))

  /** The live feed: a fresh cached copy, or a new fetch, or undefined when the gallery can't give one. */
  const liveFeed = async () => {
    const cached = readCachedFeed(feedCacheFile)
    if (cached !== undefined && Date.now() - cached.fetchedAt < FEED_FRESH_MS) return cached

    const fetched = await fetchFeed(galleryUrl)
    if (fetched !== undefined) writeFileAtomically(feedCacheFile, JSON.stringify(fetched))

    return fetched
  }

  return {
    /** The flock for /flock.json: the live feed when the gallery gives one, else the practice flock. */
    async feed() {
      const live = galleryUrl === undefined ? undefined : await liveFeed()
      if (live === undefined) return { source: 'demo', items: demoFeed.items }

      return { source: 'live', items: live.items.map(({ image_source: _, ...item }) => item) }
    },

    /** A gallery bird's PNG by its cache key, from the cache or fetched once. */
    async liveImage(key) {
      if (!IMAGE_KEY_PATTERN.test(key)) return undefined
      const cachedImage = readCachedImage(path.join(imageDirectory, `${key}.png`))
      if (cachedImage !== undefined) return cachedImage

      const source = readCachedFeed(feedCacheFile)?.items.find((item) => imageKeyOf(item.image_source) === key)?.image_source
      if (source === undefined) return undefined
      const image = await fetchCapped(source, MAX_IMAGE_BYTES)
      if (image === undefined || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return undefined
      writeFileAtomically(path.join(imageDirectory, `${key}.png`), image)

      return image
    },

    /** A practice bird's SVG, when `fileName` is one the practice flock lists. */
    demoImage(fileName) {
      return demoFileNames.has(fileName) ? readFileSync(path.join(DEMO_DIRECTORY, fileName)) : undefined
    },
  }
}

/** Reads the bundled practice flock, which must pass the same checks as a live feed. */
function readDemoFeed() {
  const items = birdsOf(JSON.parse(readFileSync(DEMO_FEED_FILE, 'utf8')), (imageUrl) => {
    const fileName = DEMO_IMAGE_PATTERN.exec(imageUrl)?.[1]

    return fileName === undefined ? undefined : { image_url: `/flock/demo/${fileName}` }
  })
  if (items.length === 0) throw new Error(`${DEMO_FEED_FILE} holds no bird that passes the feed checks`)

  return { items }
}

/**
 * Fetches and checks the gallery's feed. Resolves `{ fetchedAt, items }`,
 * each item also carrying its absolute `image_source`, or undefined when the
 * gallery doesn't answer, answers with an error, or sends no valid feed.
 */
async function fetchFeed(galleryUrl) {
  const feedUrl = new URL(FLOCK_FEED_FILE, galleryUrl.endsWith('/') ? galleryUrl : `${galleryUrl}/`)
  const body = await fetchCapped(feedUrl, MAX_FEED_BYTES)
  if (body === undefined) return undefined

  let feed
  try {
    feed = JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }

  const galleryOrigin = new URL(galleryUrl).origin
  const items = birdsOf(feed, (imageUrl) => {
    const source = imageUrl.startsWith('/') ? URL.parse(imageUrl, galleryOrigin) : null
    if (source === null || source.origin !== galleryOrigin) return undefined

    return { image_url: `/flock/images/${imageKeyOf(source.href)}.png`, image_source: source.href }
  })

  return { fetchedAt: Date.now(), items }
}

/**
 * The feed's birds that pass every check, newest first as the feed lists
 * them, at most MAX_FLOCK_BIRDS. `imageOf(image_url)` gives the fields that
 * locate a bird's image on the page server, or undefined to drop the bird.
 */
function birdsOf(feed, imageOf) {
  if (typeof feed !== 'object' || feed === null || !Array.isArray(feed.items)) return []

  return feed.items
    .flatMap((item) => {
      const bird = birdOf(item)
      const image = bird === undefined || typeof item.image_url !== 'string' ? undefined : imageOf(item.image_url)

      return image === undefined ? [] : [{ ...bird, ...image }]
    })
    .slice(0, MAX_FLOCK_BIRDS)
}

/** One feed item's checked fields, without its image, or undefined when any fails its rule. */
function birdOf(item) {
  if (typeof item !== 'object' || item === null) return undefined

  const { id, duration_s: durationSeconds } = item
  const labels = Object.fromEntries(Object.keys(MAX_LABEL_LENGTH).map((key) => [key, labelOf(item[key], MAX_LABEL_LENGTH[key])]))
  const timingFunction = typeof item.timing_function === 'string' ? readTimingFunction(item.timing_function) : undefined
  const keyframes = keyframesOf(item.keyframes)
  const validDuration = Number.isFinite(durationSeconds) && durationSeconds >= MIN_DURATION_SECONDS && durationSeconds <= MAX_DURATION_SECONDS
  const validId = typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH
  if (!validId || labels.bird_name === '' || labels.origin === '' || !validDuration || timingFunction === undefined || keyframes === undefined) return undefined

  return { id, ...labels, keyframes, duration_s: durationSeconds, timing_function: timingFunction }
}

/** A label cut to `maxLength` characters; '' when it is missing or not a string. The page shows it as text only. */
function labelOf(value, maxLength) {
  return typeof value === 'string' ? [...value.trim()].slice(0, maxLength).join('') : ''
}

/**
 * The feed's keyframes, each `{ offset, transform }` plus `opacity` and
 * `easing` when given, with transforms and easings written out again; or
 * undefined when any keyframe fails its rule or the offsets go backwards.
 */
function keyframesOf(keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length === 0 || keyframes.length > MAX_KEYFRAMES) return undefined

  const checked = []
  for (const keyframe of keyframes) {
    const offset = keyframe?.offset
    const transform = typeof keyframe?.transform === 'string' && keyframe.transform.length <= MAX_TRANSFORM_LENGTH ? readTransform(keyframe.transform) : undefined
    const previousOffset = checked.at(-1)?.offset ?? 0
    if (!Number.isFinite(offset) || offset < previousOffset || offset > 1 || transform === undefined) return undefined

    const written = { offset, transform: transform.length === 0 ? 'none' : transform.map(writtenFunction).join(' ') }
    if (keyframe.opacity !== undefined) {
      if (!Number.isFinite(keyframe.opacity) || keyframe.opacity < 0 || keyframe.opacity > 1) return undefined
      written.opacity = keyframe.opacity
    }
    if (keyframe.easing !== undefined) {
      written.easing = typeof keyframe.easing === 'string' ? readTimingFunction(keyframe.easing) : undefined
      if (written.easing === undefined) return undefined
    }
    checked.push(written)
  }

  return checked
}

/** A parsed transform function written out again, such as `translate(120px, 300px)`. */
function writtenFunction({ name, arguments: transformArguments }) {
  return `${name}(${transformArguments.map(({ value, unit }) => `${value}${unit}`).join(', ')})`
}

/** The cache key of an image URL: hex, so it is safe as a file name and a URL path. */
function imageKeyOf(imageUrl) {
  return createHash('sha256').update(imageUrl).digest('hex').slice(0, 32)
}

/**
 * GETs `url` without following redirects and resolves its body, or undefined
 * when the request fails, times out, answers anything but 200, or sends more
 * than `maxBytes`.
 */
async function fetchCapped(url, maxBytes) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (response.status !== 200 || Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel()
      return undefined
    }

    const chunks = []
    let totalBytes = 0
    for await (const chunk of response.body) {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) return undefined
      chunks.push(chunk)
    }

    return Buffer.concat(chunks)
  } catch {
    return undefined
  }
}

/** The cached feed `{ fetchedAt, items }`, or undefined when there is none or it can't be read. */
function readCachedFeed(feedCacheFile) {
  try {
    const cached = JSON.parse(readWorkspaceFile(feedCacheFile, MAX_FEED_BYTES * 2).toString('utf8'))

    return Number.isFinite(cached.fetchedAt) && Array.isArray(cached.items) ? cached : undefined
  } catch {
    return undefined
  }
}

/** A cached image's bytes, or undefined when it isn't cached. */
function readCachedImage(imageFile) {
  try {
    return readWorkspaceFile(imageFile, MAX_IMAGE_BYTES)
  } catch {
    return undefined
  }
}

/** Writes `body` to a fresh temp file beside `destination`, then renames it over, so readers never see half a file. */
function writeFileAtomically(destination, body) {
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  const temporaryFile = `${destination}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporaryFile, body, { flag: 'wx' })
    renameSync(temporaryFile, destination)
  } catch (error) {
    rmSync(temporaryFile, { force: true })
    throw error
  }
}
