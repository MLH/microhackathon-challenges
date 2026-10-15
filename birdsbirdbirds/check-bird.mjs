// Checks a bird.json entry before the page injects its keyframes into a
// <style> element. `checkBird` is pure and returns actionable error strings;
// run as `node check-bird.mjs [path]` it checks a file (default bird.json).
//
// css_keyframes goes through a small strict tokenizer and parser that accepts
// exactly one `@keyframes <animation_name> { ... }` rule built from an
// allowlist of properties, transform functions, and units, so nothing else
// can reach the page's stylesheet.

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { readWorkspaceFile, RefusedFileError } from './workspace-file.mjs'

export const MAX_BIRD_FILE_BYTES = 8192
export const MAX_KEYFRAMES_BYTES = 4096
export const MAX_BIRD_NAME_LENGTH = 40
export const MAX_ORIGIN_LENGTH = 60
export const MAX_TIMING_FUNCTION_LENGTH = 100
export const MIN_DURATION_SECONDS = 2
export const MAX_DURATION_SECONDS = 60

const ENTRY_KEYS = ['bird_name', 'origin', 'animation']
const ANIMATION_KEYS = ['css_keyframes', 'animation_name', 'duration', 'timing_function']
const ALLOWED_PROPERTIES = ['transform', 'opacity', 'animation-timing-function']
const TIMING_KEYWORDS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']

/**
 * What each kind of transform argument accepts, and the error for anything
 * else. Only 0 may go bare where a unit is required, as in CSS itself.
 */
const ARGUMENT_KINDS = {
  length: {
    units: ['vw', 'vh', 'px', 'em', 'rem', '%'],
    bareZero: true,
    problem: (call, argument) => `${call} needs a length unit (vw, vh, px, em, rem, or %) on ${argument.text}; only 0 may go without one`,
  },
  depth: {
    units: ['vw', 'vh', 'px', 'em', 'rem'],
    bareZero: true,
    problem: (call, argument) => `${call} needs a length unit (vw, vh, px, em, or rem; % is not allowed for z) on ${argument.text}; only 0 may go without one`,
  },
  angle: {
    units: ['deg', 'turn'],
    bareZero: true,
    problem: (call, argument) => `${call} needs an angle unit (deg or turn); write ${argument.value}deg`,
  },
  number: {
    units: [''],
    bareZero: false,
    problem: (call, argument) => `${call} takes plain numbers with no unit; write ${argument.value}`,
  },
}

const { length, depth, angle, number } = ARGUMENT_KINDS

/**
 * Each allowed transform function: the fewest arguments it takes, and the
 * kind of each argument in order (so the most it takes is their count).
 */
const TRANSFORM_FUNCTIONS = {
  translate: { minimum: 1, kinds: [length, length] },
  translateX: { minimum: 1, kinds: [length] },
  translateY: { minimum: 1, kinds: [length] },
  translate3d: { minimum: 3, kinds: [length, length, depth] },
  rotate: { minimum: 1, kinds: [angle] },
  rotateZ: { minimum: 1, kinds: [angle] },
  scale: { minimum: 1, kinds: [number, number] },
  scaleX: { minimum: 1, kinds: [number] },
  scaleY: { minimum: 1, kinds: [number] },
  skew: { minimum: 1, kinds: [angle, angle] },
  skewX: { minimum: 1, kinds: [angle] },
  skewY: { minimum: 1, kinds: [angle] },
}

/** Raw substrings rejected before tokenizing, each with the fix Pi should make. */
const FORBIDDEN_TEXT = [
  { pattern: /url\(/i, message: '"url(" is not allowed; the bird image comes from bird.png, so keyframes need no URLs' },
  { pattern: /@import/i, message: '"@import" is not allowed; css_keyframes holds only one @keyframes block' },
  { pattern: /\\/, message: 'backslash escapes are not allowed; write plain CSS with no "\\"' },
  { pattern: /["']/, message: 'quotes are not allowed; keyframes need no strings, so remove every " and \'' },
  { pattern: /</, message: '"<" is not allowed; css_keyframes is CSS only, never HTML' },
  { pattern: /\/\*/, message: 'comments ("/*") are not allowed; remove them' },
  { pattern: /!\s*important/i, message: '"!important" is not allowed and does nothing in keyframes; remove it' },
]

const ANIMATION_NAME_PATTERN = /^fly_[A-Za-z0-9_-]{1,60}$/
const DURATION_PATTERN = /^\d+(\.\d+)?s$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u

/**
 * Bidi controls, zero-width and other invisible characters, and line and
 * paragraph separators. Zero-width (non-)joiners and the emoji variation
 * selector stay allowed: Persian, Sinhala, Devanagari, and emoji need them.
 */
const INVISIBLE_CHARACTER_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B\u2060-\u2064\uFEFF\u00AD\u2028\u2029]/u
const VISIBLE_CHARACTER_PATTERN = /[\p{L}\p{N}\p{S}\p{P}]/u
const MAX_STACKED_MARKS = 4
const STACKED_MARKS_PATTERN = new RegExp(`\\p{M}{${MAX_STACKED_MARKS + 1},}`, 'u')
const KEYFRAMES_FIELD = 'animation.css_keyframes'
const PUNCTUATION = new Set(['{', '}', ':', ';', ',', ')'])
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f'])

/** A parse failure carrying the actionable message to report. */
class CheckError extends Error {}

/**
 * Checks a parsed bird.json value against the birds-v1 shape.
 * Returns an array of actionable error strings; an empty array means valid.
 */
export function checkBird(entry) {
  if (!isPlainObject(entry)) {
    return ['bird.json must hold one JSON object like {"bird_name": ..., "origin": ..., "animation": {...}}']
  }

  const errors = [
    ...unknownKeyErrors(entry, ENTRY_KEYS, ''),
    ...labelErrors(entry, 'bird_name', MAX_BIRD_NAME_LENGTH, "the bird's name"),
    ...labelErrors(entry, 'origin', MAX_ORIGIN_LENGTH, 'where the bird is from'),
  ]
  if (!Object.hasOwn(entry, 'animation')) return [...errors, 'animation is missing; add an "animation" object with css_keyframes, animation_name, duration, timing_function']
  if (!isPlainObject(entry.animation)) return [...errors, 'animation must be an object with css_keyframes, animation_name, duration, timing_function']

  return [...errors, ...animationErrors(entry.animation)]
}

/**
 * Reads and checks a bird.json file: a regular file (never a symlink or pipe)
 * of at most MAX_BIRD_FILE_BYTES. Returns `{ entry, errors }`; `entry` is
 * undefined when the file could not be read or parsed.
 */
export function loadBirdFile(filePath) {
  let text
  try {
    text = readBirdText(filePath)
  } catch (error) {
    if (error instanceof CheckError) return { entry: undefined, errors: [error.message] }
    return { entry: undefined, errors: [`${filePath}: cannot read the file (${error.code ?? error.message}); write bird.json in the workspace, then run the checker again`] }
  }

  let entry
  try {
    entry = JSON.parse(text)
  } catch (error) {
    return { entry: undefined, errors: [`${filePath}: ${describeJsonError(error)}; rewrite it as one JSON object`] }
  }

  return { entry, errors: checkBird(entry) }
}

/** Reads bird.json as UTF-8, failing with an actionable CheckError when it is refused or not UTF-8. */
function readBirdText(filePath) {
  let bytes
  try {
    bytes = readWorkspaceFile(filePath, MAX_BIRD_FILE_BYTES)
  } catch (error) {
    if (!(error instanceof RefusedFileError)) throw error
    const fix = error.tooLarge ? 'use fewer keyframes and shorter names' : 'write bird.json as a plain file with the write tool'
    throw new CheckError(`${error.message}; ${fix}`)
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new CheckError(`${filePath}: is not valid UTF-8; save it as UTF-8 text`)
  }
}

/**
 * Says where JSON.parse failed without echoing the file: V8's own message
 * quotes the text, which may not be bird.json's at all.
 */
function describeJsonError(error) {
  const position = /at position (\d+)/.exec(error.message)?.[1]

  return position === undefined ? 'not valid JSON' : `not valid JSON at position ${position}`
}

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Lists keys of `object` outside `allowedKeys`, naming where they sit. */
function unknownKeyErrors(object, allowedKeys, prefix) {
  const where = prefix === '' ? 'bird.json' : prefix.slice(0, -1)

  return Object.keys(object)
    .filter((key) => !allowedKeys.includes(key))
    .map((key) => `${quote(`${prefix}${key}`)} is an unknown key; remove it (${where} holds only ${allowedKeys.join(', ')})`)
}

/** Checks a short display string such as bird_name or origin. */
function labelErrors(entry, key, maxLength, meaning) {
  if (!Object.hasOwn(entry, key)) return [`${key} is missing; add ${meaning} as a string`]

  const value = entry[key]
  if (typeof value !== 'string') return [`${key} must be a string holding ${meaning}`]
  if (value.trim() === '') return [`${key} is empty; give ${meaning}`]
  if (CONTROL_CHARACTER_PATTERN.test(value)) return [`${key} contains a control character such as a newline or tab; use plain text on one line`]

  const invisible = INVISIBLE_CHARACTER_PATTERN.exec(value)?.[0]
  if (invisible !== undefined) return [`${key} contains the invisible character ${codePointName(invisible)}; use plain visible text`]
  if (!VISIBLE_CHARACTER_PATTERN.test(value)) return [`${key} has no visible letters, digits, or symbols; give ${meaning}`]

  const stackedMarks = STACKED_MARKS_PATTERN.exec(value)?.[0]
  if (stackedMarks !== undefined) return [`${key} stacks ${[...stackedMarks].length} accent marks on one letter; use at most ${MAX_STACKED_MARKS}`]

  const length = [...value].length
  if (length > maxLength) return [`${key} is ${length} characters, over the ${maxLength}-character limit; shorten it`]

  return []
}

/** Checks the animation object and every field in it. */
function animationErrors(animation) {
  const errors = unknownKeyErrors(animation, ANIMATION_KEYS, 'animation.')
  const missing = ANIMATION_KEYS.filter((key) => !Object.hasOwn(animation, key))
  for (const key of missing) errors.push(`animation.${key} is missing; add it as a string`)
  for (const key of ANIMATION_KEYS) {
    if (!missing.includes(key) && typeof animation[key] !== 'string') errors.push(`animation.${key} must be a string`)
  }
  if (errors.length > 0) return errors

  const nameErrors = animationNameErrors(animation.animation_name)

  return [
    ...nameErrors,
    ...durationErrors(animation.duration),
    ...timingFunctionErrors(animation.timing_function),
    ...(nameErrors.length === 0 ? keyframesErrors(animation.css_keyframes, animation.animation_name) : []),
  ]
}

/**
 * Checks animation_name starts with fly_, which keeps it clear of CSS keywords
 * and of the page's own keyframes such as flap.
 */
function animationNameErrors(name) {
  if (!ANIMATION_NAME_PATTERN.test(name)) {
    return [`animation.animation_name ${quote(name)} is not allowed; start it with fly_ and follow with 1 to 60 letters, digits, _ or -, e.g. "fly_robin"`]
  }

  return []
}

/** Checks duration is seconds like "14s" within the allowed range. */
function durationErrors(duration) {
  if (!DURATION_PATTERN.test(duration)) {
    return [`animation.duration ${quote(duration)} is not allowed; write whole or decimal seconds like "14s"`]
  }

  const seconds = Number(duration.slice(0, -1))
  if (seconds < MIN_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
    return [`animation.duration ${quote(duration)} is out of range; use ${MIN_DURATION_SECONDS}s to ${MAX_DURATION_SECONDS}s`]
  }

  return []
}

/** Checks timing_function with the same rule as animation-timing-function inside keyframes. */
function timingFunctionErrors(timingFunction) {
  const field = 'animation.timing_function'
  if (timingFunction.length > MAX_TIMING_FUNCTION_LENGTH) {
    return [`${field} is over ${MAX_TIMING_FUNCTION_LENGTH} characters; use ${TIMING_KEYWORDS.join(', ')}, or cubic-bezier(x1, y1, x2, y2)`]
  }

  try {
    checkTimingValue(tokenize(timingFunction, field), field)
  } catch (error) {
    if (!(error instanceof CheckError)) throw error
    return [error.message]
  }

  return []
}

/** Checks css_keyframes: byte cap, forbidden text, then a strict parse. */
function keyframesErrors(css, animationName) {
  const bytes = Buffer.byteLength(css, 'utf8')
  if (bytes > MAX_KEYFRAMES_BYTES) {
    return [`${KEYFRAMES_FIELD} is ${bytes} bytes, over the ${MAX_KEYFRAMES_BYTES}-byte cap; use fewer keyframes`]
  }

  const forbidden = FORBIDDEN_TEXT
    .filter(({ pattern }) => pattern.test(css))
    .map(({ message }) => `${KEYFRAMES_FIELD}: ${message}`)
  if (forbidden.length > 0) return forbidden

  try {
    parseKeyframes(tokenize(css, KEYFRAMES_FIELD), animationName)
  } catch (error) {
    if (!(error instanceof CheckError)) throw error
    return [error.message]
  }

  return []
}

/** Builds a CheckError for css_keyframes with the given detail. */
function keyframesError(detail) {
  return new CheckError(`${KEYFRAMES_FIELD}: ${detail}`)
}

/**
 * Splits CSS text into tokens: `at-keyword`, `ident`, `function` (an ident
 * with its opening parenthesis), `number` (with `unit`, '' when unitless),
 * and single-character punctuation. Throws CheckError on any other character.
 */
function tokenize(source, field) {
  const tokens = []
  let index = 0

  /** Reads an identifier starting at `index`; returns '' when none starts there. */
  const readIdentifier = () => {
    const start = index
    if (source[index] === '-' && isIdentifierStart(source[index + 1])) index += 1
    if (!isIdentifierStart(source[index])) {
      index = start
      return ''
    }
    while (isIdentifierCharacter(source[index])) index += 1

    return source.slice(start, index)
  }

  while (index < source.length) {
    const character = source[index]

    if (WHITESPACE.has(character)) {
      index += 1
    } else if (PUNCTUATION.has(character)) {
      tokens.push({ type: character })
      index += 1
    } else if (character === '@') {
      index += 1
      const name = readIdentifier()
      if (name === '') throw new CheckError(`${field}: "@" must start "@keyframes"; remove the stray "@"`)
      tokens.push({ type: 'at-keyword', value: name })
    } else if (startsNumber(source, index)) {
      const start = index
      if (source[index] === '+' || source[index] === '-') index += 1
      while (isDigit(source[index])) index += 1
      if (source[index] === '.' && isDigit(source[index + 1])) {
        index += 1
        while (isDigit(source[index])) index += 1
      }
      if ((source[index] === 'e' || source[index] === 'E') && startsExponent(source, index + 1)) {
        throw new CheckError(`${field}: exponents aren't allowed (found ${quote(readExponentText(source, start, index + 1))}); write plain numbers like 1000px`)
      }
      const value = Number(source.slice(start, index))
      let unit = ''
      if (source[index] === '%') {
        unit = '%'
        index += 1
      } else {
        const unitStart = index
        while (isLetter(source[index])) index += 1
        unit = source.slice(unitStart, index)
      }
      tokens.push({ type: 'number', value, unit, text: source.slice(start, index) })
    } else {
      const name = readIdentifier()
      if (name === '') throw new CheckError(`${field}: unexpected character ${quote(character)} (${codePointName(character)}); use only letters, digits, spaces and { } : ; , ( ) . % -`)
      if (source[index] === '(') {
        index += 1
        tokens.push({ type: 'function', value: name })
      } else {
        tokens.push({ type: 'ident', value: name })
      }
    }
  }

  return tokens
}

/** True when a number token starts at `index`: a digit, or a sign or dot before one. */
function startsNumber(source, index) {
  const character = source[index]
  if (isDigit(character)) return true
  if (character === '.') return isDigit(source[index + 1])
  if (character === '+' || character === '-') {
    return isDigit(source[index + 1]) || (source[index + 1] === '.' && isDigit(source[index + 2]))
  }

  return false
}

/** True when an exponent's digits, with an optional sign, start at `index`. */
function startsExponent(source, index) {
  const character = source[index]

  return isDigit(character) || ((character === '+' || character === '-') && isDigit(source[index + 1]))
}

/** The text of a number with an exponent, from `start` through the exponent's digits after `exponentIndex`. */
function readExponentText(source, start, exponentIndex) {
  let end = exponentIndex
  if (source[end] === '+' || source[end] === '-') end += 1
  while (isDigit(source[end])) end += 1

  return source.slice(start, end)
}

/** True for an ASCII digit. */
function isDigit(character) {
  return character !== undefined && character >= '0' && character <= '9'
}

/** True for an ASCII letter. */
function isLetter(character) {
  return character !== undefined && ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z'))
}

/** True for a character that may open an identifier. */
function isIdentifierStart(character) {
  return isLetter(character) || character === '_'
}

/** True for a character that may continue an identifier. */
function isIdentifierCharacter(character) {
  return isIdentifierStart(character) || isDigit(character) || character === '-'
}

/** Describes a token for an error message. */
function describe(token) {
  if (token === undefined) return 'the end'
  if (token.type === 'at-keyword') return quote(`@${token.value}`)
  if (token.type === 'function') return quote(`${token.value}(`)
  if (token.type === 'ident') return quote(token.value)
  if (token.type === 'number') return quote(token.text)

  return quote(token.type)
}

/**
 * Parses tokens as exactly `@keyframes <animationName> { <frame>+ }` and
 * nothing else. Throws CheckError naming the first problem and its fix.
 */
function parseKeyframes(tokens, animationName) {
  checkBraceBalance(tokens)
  const atRules = tokens.filter((token) => token.type === 'at-keyword')
  if (atRules.length > 1) {
    throw keyframesError(`found a second at-rule ${describe(atRules[1])}; css_keyframes holds exactly one @keyframes block`)
  }

  let position = 0
  /** The token at the cursor, without moving it. */
  const peek = () => tokens[position]
  /** The token at the cursor, moving the cursor past it. */
  const next = () => tokens[position++]
  /** Takes the next token, failing unless it is `type`; `context` says where in the rule it was expected. */
  const expect = (type, context) => {
    const token = next()
    if (token?.type !== type) throw keyframesError(`expected "${type}" ${context} but found ${describe(token)}`)
  }

  const opening = next()
  if (opening?.type !== 'at-keyword' || opening.value !== 'keyframes') {
    throw keyframesError(`must start with "@keyframes ${animationName} {" but starts with ${describe(opening)}`)
  }
  const nameToken = next()
  if (nameToken?.type !== 'ident') {
    throw keyframesError(`"@keyframes" must be followed by the name ${quote(animationName)}, found ${describe(nameToken)}`)
  }
  if (nameToken.value !== animationName) {
    throw keyframesError(`the @keyframes name ${quote(nameToken.value)} does not match animation.animation_name ${quote(animationName)}; make them the same`)
  }
  expect('{', `after "@keyframes ${animationName}"`)

  let frameCount = 0
  while (peek()?.type !== '}') {
    position = parseFrame(tokens, position)
    frameCount += 1
  }
  next()

  if (frameCount === 0) throw keyframesError('the @keyframes block has no frames; add frames such as "0% { ... } 100% { ... }"')
  if (position < tokens.length) {
    throw keyframesError(`found ${describe(peek())} after the closing "}" of @keyframes; every frame must sit inside the one @keyframes block, so remove or move anything after its final "}"`)
  }
}

/** Fails unless every "{" has a matching "}" and none closes early below depth zero. */
function checkBraceBalance(tokens) {
  const opens = tokens.filter((token) => token.type === '{').length
  const closes = tokens.filter((token) => token.type === '}').length
  if (opens !== closes) {
    throw keyframesError(`braces are unbalanced (${opens} "{" and ${closes} "}"); each frame needs one "{" and one "}", plus one pair around the whole @keyframes block`)
  }
}

/** Parses one frame starting at `position`: selectors, then a declaration block. Returns the next position. */
function parseFrame(tokens, position) {
  let cursor = position
  for (;;) {
    checkFrameSelector(tokens[cursor])
    cursor += 1
    if (tokens[cursor]?.type !== ',') break
    cursor += 1
  }
  if (tokens[cursor]?.type !== '{') {
    throw keyframesError(`expected "{" after a frame selector but found ${describe(tokens[cursor])}; write frames like "50% { transform: ... }"`)
  }
  cursor += 1

  while (tokens[cursor]?.type !== '}') {
    if (tokens[cursor]?.type === ';') {
      cursor += 1
      continue
    }
    cursor = parseDeclaration(tokens, cursor)
  }

  return cursor + 1
}

/** Fails unless the token is `from`, `to`, or a percentage from 0% to 100%. */
function checkFrameSelector(token) {
  if (token?.type === 'ident' && (token.value === 'from' || token.value === 'to')) return
  if (token?.type === 'number' && token.unit === '%' && token.value >= 0 && token.value <= 100) return

  throw keyframesError(`frame selector ${describe(token)} is not allowed; use from, to, or a percentage from 0% to 100%`)
}

/** Parses `property: value` starting at `position`; returns the position of the ";" or "}" after it. */
function parseDeclaration(tokens, position) {
  const property = tokens[position]
  if (property?.type !== 'ident') {
    throw keyframesError(`expected a property name inside a frame but found ${describe(property)}; write declarations like "transform: translate(10vw, 40vh)"`)
  }
  if (!ALLOWED_PROPERTIES.includes(property.value)) {
    throw keyframesError(`property ${quote(property.value)} is not allowed; move the bird with transform: translate(...) (allowed: ${ALLOWED_PROPERTIES.join(', ')})`)
  }
  if (tokens[position + 1]?.type !== ':') {
    throw keyframesError(`expected ":" after ${quote(property.value)} but found ${describe(tokens[position + 1])}`)
  }

  let end = position + 2
  while (end < tokens.length && tokens[end].type !== ';' && tokens[end].type !== '}') {
    if (tokens[end].type === '{') throw keyframesError(`found "{" inside the ${quote(property.value)} value; end the declaration with ";" and close the frame with "}"`)
    end += 1
  }
  const value = tokens.slice(position + 2, end)
  if (value.length === 0) throw keyframesError(`${quote(property.value)} has no value; give it one or remove it`)

  if (property.value === 'transform') checkTransformValue(value)
  if (property.value === 'opacity') checkOpacityValue(value)
  if (property.value === 'animation-timing-function') checkTimingValue(value, `${KEYFRAMES_FIELD}: animation-timing-function`)

  return end
}

/**
 * Fails unless the value is `none` or allowed transform functions, each with
 * the right number of arguments in the units its kind takes.
 */
function checkTransformValue(value) {
  if (value.length === 1 && value[0].type === 'ident' && value[0].value === 'none') return

  let position = 0
  while (position < value.length) {
    const transformFunction = value[position]
    if (transformFunction.type !== 'function' || !Object.hasOwn(TRANSFORM_FUNCTIONS, transformFunction.value)) {
      throw keyframesError(`transform ${describe(transformFunction)} is not allowed; use none or these functions: ${Object.keys(TRANSFORM_FUNCTIONS).join(', ')}`)
    }
    const { argumentTokens, next } = readArguments(value, position + 1, `${KEYFRAMES_FIELD}: transform ${transformFunction.value}(`)
    const { minimum, kinds } = TRANSFORM_FUNCTIONS[transformFunction.value]
    const maximum = kinds.length
    if (argumentTokens.length < minimum || argumentTokens.length > maximum) {
      const expected = minimum === maximum ? `${minimum}` : `${minimum} or ${maximum}`
      throw keyframesError(`transform ${transformFunction.value}() takes ${expected} argument${maximum === 1 ? '' : 's'} but got ${argumentTokens.length}`)
    }
    const call = `${transformFunction.value}(${argumentTokens.map((argument) => argument.text).join(', ')})`
    argumentTokens.forEach((argument, index) => checkArgumentKind(call, argument, kinds[index]))
    position = next
  }
}

/**
 * Fails unless a number token has one of the kind's units, or is a bare 0
 * where the kind allows it. `call` is the transform as written, for the message.
 */
function checkArgumentKind(call, argument, kind) {
  if (kind.units.includes(argument.unit)) return
  if (kind.bareZero && argument.unit === '' && argument.value === 0) return
  if (kind.units.includes(argument.unit.toLowerCase())) {
    throw keyframesError(`${call} writes the unit of ${argument.text} in capitals; units are lowercase, like ${argument.value}${argument.unit.toLowerCase()}`)
  }

  throw keyframesError(kind.problem(call, argument))
}

/** Reads comma-separated number arguments up to ")" starting at `position`. Returns them and the position after ")". */
function readArguments(tokens, position, context) {
  const argumentTokens = []
  let cursor = position
  for (;;) {
    const token = tokens[cursor]
    if (token?.type !== 'number') {
      throw new CheckError(`${context} arguments must be numbers like 10vw or 15deg, found ${describe(token)}`)
    }
    argumentTokens.push(token)
    cursor += 1
    if (tokens[cursor]?.type === ')') return { argumentTokens, next: cursor + 1 }
    if (tokens[cursor]?.type !== ',') {
      throw new CheckError(`${context} arguments must be separated by "," and end with ")", found ${describe(tokens[cursor])}`)
    }
    cursor += 1
  }
}

/** Fails unless the value is a single unitless number from 0 to 1. */
function checkOpacityValue(value) {
  const [number] = value
  if (value.length !== 1 || number.type !== 'number' || number.unit !== '' || number.value < 0 || number.value > 1) {
    throw keyframesError(`opacity must be one plain number from 0 to 1, like "opacity: 0.5"; found ${value.map(describe).join(' ')}`)
  }
}

/** Fails unless the tokens are a timing keyword or cubic-bezier with four plain numbers, x values in 0–1. */
function checkTimingValue(value, field) {
  const allowed = `use ${TIMING_KEYWORDS.join(', ')}, or cubic-bezier(x1, y1, x2, y2) with plain numbers`
  const [first] = value
  if (first?.type === 'ident' && TIMING_KEYWORDS.includes(first.value)) {
    if (value.length === 1) return
    throw new CheckError(`${field} has extra text after ${describe(first)}; use one timing function on its own`)
  }
  if (first?.type !== 'function' || first.value !== 'cubic-bezier') {
    throw new CheckError(`${field} ${first === undefined ? 'is empty' : `${describe(first)} is not allowed`}; ${allowed}`)
  }

  let parsed
  try {
    parsed = readArguments(value, 1, `${field} cubic-bezier(`)
  } catch (error) {
    if (!(error instanceof CheckError)) throw error
    throw new CheckError(`${error.message}; ${allowed}`)
  }
  const { argumentTokens, next } = parsed
  if (next !== value.length) throw new CheckError(`${field} has extra text after cubic-bezier(...); ${allowed}`)
  if (argumentTokens.length !== 4 || argumentTokens.some((argument) => argument.unit !== '')) {
    throw new CheckError(`${field} cubic-bezier() needs exactly four plain numbers with no units; ${allowed}`)
  }
  if ([argumentTokens[0], argumentTokens[2]].some((argument) => argument.value < 0 || argument.value > 1)) {
    throw new CheckError(`${field} cubic-bezier() x values (the 1st and 3rd numbers) must be from 0 to 1`)
  }
}

/** Names a character by its code point, such as U+202E. */
function codePointName(character) {
  return `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

/** Quotes a value for a message, shortened so a long input never floods the output. */
function quote(value) {
  const text = String(value)

  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text)
}

/** Checks the file named by `argv[0]` (default bird.json) and returns the exit code. */
export function main(argv) {
  const filePath = argv[0] ?? 'bird.json'
  const { entry, errors } = loadBirdFile(filePath)

  if (errors.length > 0) {
    for (const error of errors) console.error(error)
    return 1
  }

  console.log(`ok: ${entry.bird_name} from ${entry.origin} passes`)
  return 0
}

/** True when the module at `moduleUrl` (its import.meta.url) is the script node was asked to run, symlinks resolved. */
export function isRunDirectly(moduleUrl) {
  if (process.argv[1] === undefined) return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isRunDirectly(import.meta.url)) process.exitCode = main(process.argv.slice(2))
