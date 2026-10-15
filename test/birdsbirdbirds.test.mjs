// Proves the birdsbirdbirds package: check-bird.mjs accepts real gallery
// birds and rejects CSS that could escape the page's keyframes <style>.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkBird, MAX_BIRD_FILE_BYTES, MAX_KEYFRAMES_BYTES } from '../birdsbirdbirds/check-bird.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const packageDirectory = path.join(testDirectory, '..', 'birdsbirdbirds')
const checkerScript = path.join(packageDirectory, 'check-bird.mjs')

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
const runChecker = (args, cwd) => spawnSync(process.execPath, [checkerScript, ...args], { cwd, encoding: 'utf8' })

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
]

for (const { behavior, entry, mentions } of REJECTED_BIRDS) {
  test(behavior, () => {
    const errors = checkBird(entry)

    assert.ok(errors.length > 0, 'expected at least one error')
    assert.match(errors.join('\n'), mentions)
  })
}

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
